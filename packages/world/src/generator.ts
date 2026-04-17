/**
 * World generator — multi-layer noise-based terrain for 512×512 tiles.
 *
 * Pipeline per cell:
 *   1. Domain warp            — organic coordinate distortion
 *   2. Continental noise      — broad landmass / ocean shapes
 *   3. Tectonic ridges        — mountain ranges via ridged FBM
 *   4. Moisture               — independent wetness field
 *   5. Temperature            — temperature with altitude falloff
 *   6. Combined base          — continent + tectonic contribution
 *   7. Biome classification   — picks a BiomeDef from ContentStore data
 *   8. Detail noise           — high-frequency surface roughness
 *   9. Combine                — base + detail scaled by biome.roughness
 *  10. Height curve           — maps normalised noise to world-unit heights
 *  11. Spawn zone flatten     — safe flat area around tile centre
 *  12. Material selection     — biome.materialRules → material name → id
 *
 * After the per-cell loop a zone grid is built at lower resolution, and an
 * optional thermal erosion post-pass smooths steep slopes.
 *
 * Biome and zone defs come from packages/content/data/{biomes,zones}/*.json;
 * callers pass them in via `WorldGenContent`.
 */

import type { World, EntityId } from "@voxim/engine";
import type { BiomeDef, ZoneDef } from "@voxim/content";
import { createChunk, setChunkHeights, setChunkMaterials } from "./chunk.ts";
import { CHUNK_SIZE, CHUNKS_PER_TILE_SIDE, TILE_SIZE, snapHeight } from "./terrain.ts";
import {
  fbm,
  ridgedFbm,
  billowFbm,
  domainWarp,
  valueNoise2D,
} from "./noise.ts";
import {
  DEFAULT_TERRAIN_CONFIG,
  type TerrainConfig,
} from "./terrain_config.ts";
import { classifyBiome, biomeMaterialName } from "./biomes.ts";
import { classifyZone, type ZoneCell, type ZoneGridData } from "./zones.ts";

// ---------------------------------------------------------------------------
// Content inputs
// ---------------------------------------------------------------------------

/**
 * Minimal slice of ContentStore that the generator needs. Callers build
 * this from their full ContentStore at the edge of the world package.
 */
export interface WorldGenContent {
  readonly biomes: readonly BiomeDef[];
  readonly zones: readonly ZoneDef[];
  resolveMaterialId(name: string): number;
}

// ---------------------------------------------------------------------------
// Internal constants
// ---------------------------------------------------------------------------

const CHUNK_CELLS = CHUNK_SIZE * CHUNK_SIZE;

// ---------------------------------------------------------------------------
// Exported types
// ---------------------------------------------------------------------------

export interface GeneratedTile {
  /** Chunk entity IDs indexed by chunkX + chunkY * CHUNKS_PER_TILE_SIDE */
  chunkIds: EntityId[];
  /** Coarse zone grid for this tile (danger, corruption, spawn weights). */
  zoneGrid: ZoneGridData;
}

// ---------------------------------------------------------------------------
// Helper math
// ---------------------------------------------------------------------------

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

// ---------------------------------------------------------------------------
// Height curve
// ---------------------------------------------------------------------------

function applyHeightCurve(
  normalizedH: number,
  seaLevel: number,
  shoreWidth: number,
  landExponent: number,
  mountainExponent: number,
): number {
  if (normalizedH < seaLevel - shoreWidth) {
    return 0;
  }
  if (normalizedH < seaLevel) {
    return ((normalizedH - (seaLevel - shoreWidth)) / shoreWidth) * 0.15;
  }
  const landN = (normalizedH - seaLevel) / (1 - seaLevel);
  const powered = Math.pow(landN, landExponent);
  const mountainBoost =
    landN > 0.7
      ? Math.pow((landN - 0.7) / 0.3, mountainExponent) * 0.35
      : 0;
  return 0.15 + (powered + mountainBoost) * 0.85;
}

// ---------------------------------------------------------------------------
// Thermal erosion
// ---------------------------------------------------------------------------

async function thermalErosion(
  heightBuffer: Float32Array,
  width: number,
  passes: number,
  angle: number,
): Promise<void> {
  const delta = new Float32Array(heightBuffer.length);
  const NX = [-1, 1, 0, 0];
  const NY = [ 0, 0,-1, 1];

  for (let pass = 0; pass < passes; pass++) {
    await new Promise<void>((r) => setTimeout(r, 0));
    delta.fill(0);
    for (let y = 1; y < width - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const idx = x + y * width;
        const h = heightBuffer[idx];
        for (let n = 0; n < 4; n++) {
          const nx = x + NX[n];
          const ny = y + NY[n];
          const nidx = nx + ny * width;
          const diff = h - heightBuffer[nidx];
          if (diff > angle) {
            const transfer = (diff - angle) * 0.25;
            delta[idx]  -= transfer;
            delta[nidx] += transfer;
          }
        }
      }
    }
    for (let i = 0; i < heightBuffer.length; i++) {
      heightBuffer[i] += delta[i];
    }
  }
}

// ---------------------------------------------------------------------------
// Per-cell noise evaluation
// ---------------------------------------------------------------------------

interface CellNoise {
  continent: number;
  ridge: number;
  moisture: number;
  temperature: number;
  combined: number;
  biome: BiomeDef;
  normalizedH: number;
  detailFbm: number;
  detailBillow: number;
}

function evaluateCell(
  wx: number,
  wy: number,
  seed: number,
  cfg: TerrainConfig,
  biomes: readonly BiomeDef[],
): CellNoise {
  // 1. Domain warp
  let wxW = wx;
  let wyW = wy;
  if (cfg.domainWarp.enabled) {
    [wxW, wyW] = domainWarp(
      wx, wy, seed + 100,
      cfg.domainWarp.octaves, cfg.domainWarp.frequency, cfg.domainWarp.amplitude,
    );
  }

  // 2. Continental noise
  const cc = cfg.continent;
  const continent = fbm(wxW * cc.frequency, wyW * cc.frequency, seed + 200,
                        cc.octaves, cc.lacunarity, cc.gain);

  // 3. Tectonic ridges
  const tc = cfg.tectonic;
  const ridge = ridgedFbm(wxW * tc.frequency, wyW * tc.frequency, seed + 300,
                          tc.octaves, tc.lacunarity, tc.gain, tc.ridgeOffset);
  const continentMask = smoothstep(
    tc.continentThreshold, tc.continentThreshold + tc.continentBlend, continent,
  );
  const tectonicContrib = ridge * continentMask * tc.weight;

  // 4. Moisture
  const mc = cfg.moisture;
  const moisture = clamp(
    fbm(wx * mc.frequency, wy * mc.frequency, seed + 400,
        mc.octaves, mc.lacunarity, mc.gain) + mc.bias,
    0, 1,
  );

  // 5. Temperature (altitude-corrected)
  const tmc = cfg.temperature;
  const tempRaw =
    fbm(wx * tmc.frequency, wy * tmc.frequency, seed + 500,
        tmc.octaves, tmc.lacunarity, tmc.gain) + tmc.bias;
  const temperature = clamp(tempRaw - continent * tmc.altitudeFalloff * 0.5, 0, 1);

  // 6. Combined base
  const combined = clamp(continent + tectonicContrib, 0, 1);

  // 7. Biome classification
  const biome = classifyBiome(biomes, {
    temperature, moisture, normalizedAltitude: combined,
  });

  // 8. Detail noise
  const dc = cfg.detail;
  const detailFbm = fbm(wx * dc.frequency, wy * dc.frequency, seed + 600,
                        dc.octaves, dc.lacunarity, dc.gain);
  const detailBillow = billowFbm(wx * dc.frequency, wy * dc.frequency, seed + 700,
                                  dc.octaves, dc.lacunarity, dc.gain);
  const detail = lerp(detailFbm, detailBillow, dc.billowMix) * dc.weight * biome.roughness;

  // 9. Combine
  const normalizedH = clamp(combined * biome.heightScale + detail, 0, 1);

  return {
    continent, ridge, moisture, temperature, combined,
    biome, normalizedH, detailFbm, detailBillow,
  };
}

// ---------------------------------------------------------------------------
// Zone grid construction
// ---------------------------------------------------------------------------

function buildZoneGrid(
  seed: number,
  cfg: TerrainConfig,
  biomes: readonly BiomeDef[],
  zones: readonly ZoneDef[],
): ZoneGridData {
  const gridSize = cfg.zone.gridSize;
  const cellWorldSize = TILE_SIZE / gridSize;
  const cells: ZoneCell[] = new Array(gridSize * gridSize);
  const hc = cfg.heightCurve;
  const spz = cfg.spawnZone;

  for (let zy = 0; zy < gridSize; zy++) {
    for (let zx = 0; zx < gridSize; zx++) {
      const wx = (zx + 0.5) * cellWorldSize;
      const wy = (zy + 0.5) * cellWorldSize;

      const cn = evaluateCell(wx, wy, seed, cfg, biomes);

      const curved = applyHeightCurve(
        cn.normalizedH, hc.seaLevel, hc.shoreWidth, hc.landExponent, hc.mountainExponent,
      );
      const avgHeight = snapHeight(hc.heightMin + curved * (hc.heightMax - hc.heightMin));

      const ddx = wx - spz.centerX;
      const ddy = wy - spz.centerY;
      const dist = Math.sqrt(ddx * ddx + ddy * ddy);
      const isSpawnZone = dist < spz.flatRadius;

      const rng = valueNoise2D(zx * 17.3, zy * 13.7, seed + 9999);

      const zoneDef = classifyZone(zones, {
        biomeId: cn.biome.id,
        normalizedAltitude: cn.combined,
        tectonicValue: cn.ridge,
        isSpawnZone,
        rng,
      });

      cells[zx + zy * gridSize] = {
        zoneId: zoneDef.id,
        biomeId: cn.biome.id,
        avgHeight,
        corruption: zoneDef.corruptionBaseline,
      };
    }
  }

  return { gridSize, cells };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build the full-resolution height and material buffers plus the zone grid.
 * This is the slow part (9.5M+ noise calls). Yields to the event loop every
 * 32 rows during the main loop, and once per erosion pass.
 */
export async function buildTerrainBuffers(
  seed: number,
  content: WorldGenContent,
  config: TerrainConfig = DEFAULT_TERRAIN_CONFIG,
): Promise<{ heightBuffer: Float32Array; materialBuffer: Uint16Array; zoneGrid: ZoneGridData }> {
  console.time("[world] terrain gen");

  const cfg = config;
  const hc = cfg.heightCurve;
  const spz = cfg.spawnZone;
  const { biomes, zones } = content;

  const totalCells = TILE_SIZE * TILE_SIZE;
  const heightBuffer = new Float32Array(totalCells);
  const materialBuffer = new Uint16Array(totalCells);

  for (let wy = 0; wy < TILE_SIZE; wy++) {
    if (wy % 32 === 0) {
      await new Promise<void>((r) => setTimeout(r, 0));
    }
    for (let wx = 0; wx < TILE_SIZE; wx++) {
      const cn = evaluateCell(wx, wy, seed, cfg, biomes);

      const curved = applyHeightCurve(
        cn.normalizedH, hc.seaLevel, hc.shoreWidth, hc.landExponent, hc.mountainExponent,
      );
      let h = snapHeight(hc.heightMin + curved * (hc.heightMax - hc.heightMin));

      const ddx = wx - spz.centerX;
      const ddy = wy - spz.centerY;
      const dist = Math.sqrt(ddx * ddx + ddy * ddy);
      if (dist < spz.flatRadius + spz.fadeRadius) {
        const blend = clamp((dist - spz.flatRadius) / spz.fadeRadius, 0, 1);
        const flatH = snapHeight(
          hc.heightMin + spz.targetNoise * (hc.heightMax - hc.heightMin) * 0.5,
        );
        h = snapHeight(lerp(flatH, h, blend));
      }

      const detailBlended = lerp(cn.detailFbm, cn.detailBillow, cfg.detail.billowMix);
      const materialName = biomeMaterialName(cn.biome, {
        normalizedHeight: cn.normalizedH,
        moisture: cn.moisture,
        detailNoise: detailBlended,
      });
      const matId = content.resolveMaterialId(materialName);

      const idx = wx + wy * TILE_SIZE;
      heightBuffer[idx] = h;
      materialBuffer[idx] = matId;
    }
  }

  if (cfg.erosion.enabled && cfg.erosion.thermalPasses > 0) {
    await thermalErosion(
      heightBuffer, TILE_SIZE, cfg.erosion.thermalPasses, cfg.erosion.thermalAngle,
    );
  }

  const zoneGrid = buildZoneGrid(seed, cfg, biomes, zones);

  console.timeEnd("[world] terrain gen");

  return { heightBuffer, materialBuffer, zoneGrid };
}

/**
 * Write pre-built height/material buffers into ECS chunk entities.
 * Synchronous — no noise computation, just memory copies.
 */
export function chunksFromBuffers(
  world: World,
  heightBuffer: Float32Array,
  materialBuffer: Uint16Array,
): EntityId[] {
  const chunkIds: EntityId[] = [];

  for (let cy = 0; cy < CHUNKS_PER_TILE_SIDE; cy++) {
    for (let cx = 0; cx < CHUNKS_PER_TILE_SIDE; cx++) {
      const id = createChunk(world, cx, cy);
      const heights = new Float32Array(CHUNK_CELLS);
      const materials = new Uint16Array(CHUNK_CELLS);

      for (let ly = 0; ly < CHUNK_SIZE; ly++) {
        for (let lx = 0; lx < CHUNK_SIZE; lx++) {
          const wx = cx * CHUNK_SIZE + lx;
          const wy = cy * CHUNK_SIZE + ly;
          const flatIdx = wx + wy * TILE_SIZE;
          const chunkIdx = lx + ly * CHUNK_SIZE;

          heights[chunkIdx] = heightBuffer[flatIdx];
          materials[chunkIdx] = materialBuffer[flatIdx];
        }
      }

      setChunkHeights(world, id, heights);
      setChunkMaterials(world, id, materials);

      chunkIds[cx + cy * CHUNKS_PER_TILE_SIDE] = id;
    }
  }

  return chunkIds;
}

/** Derive a numeric seed from a tile ID string. */
export function seedFromTileId(tileId: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < tileId.length; i++) {
    h ^= tileId.charCodeAt(i);
    h = (Math.imul(h, 0x01000193)) >>> 0;
  }
  return h;
}
