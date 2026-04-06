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
 *   7. Biome classification   — biome from temperature / moisture / altitude
 *   8. Detail noise           — high-frequency surface roughness
 *   9. Combine                — base + detail scaled by biome
 *  10. Height curve           — maps normalised noise to world-unit heights
 *  11. Spawn zone flatten     — safe flat area around tile centre
 *  12. Material selection     — biome-aware surface material
 *
 * After the per-cell loop a zone grid is built at lower resolution, and an
 * optional thermal erosion post-pass smooths steep slopes.
 */

import type { World, EntityId } from "@voxim/engine";
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
import {
  BiomeId,
  classifyBiome,
  biomeMaterial,
  biomeHeightScale,
  biomeRoughness,
} from "./biomes.ts";
import {
  ZoneType,
  ZONE_PROFILES,
  classifyZone,
  type ZoneCell,
  type ZoneGridData,
} from "./zones.ts";

// ---------------------------------------------------------------------------
// Internal constants
// ---------------------------------------------------------------------------

const CHUNK_CELLS = CHUNK_SIZE * CHUNK_SIZE;

// Material IDs kept here for generateFlatTile (which doesn't use biomes.ts)
const MAT_GRASS = 1;

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

/**
 * Map a normalised combined noise value to a [0, 1] curved value that
 * represents normalised height.  The result is later scaled to world units.
 */
function applyHeightCurve(
  normalizedH: number,
  seaLevel: number,
  shoreWidth: number,
  landExponent: number,
  mountainExponent: number,
): number {
  if (normalizedH < seaLevel - shoreWidth) {
    return 0; // deep water / ocean floor
  }
  if (normalizedH < seaLevel) {
    // Shore ramp: 0 → 0.15 over the shore band
    return ((normalizedH - (seaLevel - shoreWidth)) / shoreWidth) * 0.15;
  }
  // Land
  const landN = (normalizedH - seaLevel) / (1 - seaLevel);
  const powered = Math.pow(landN, landExponent);
  // Extra sharpening for near-peak values
  const mountainBoost =
    landN > 0.7
      ? Math.pow((landN - 0.7) / 0.3, mountainExponent) * 0.35
      : 0;
  return 0.15 + (powered + mountainBoost) * 0.85;
}

// ---------------------------------------------------------------------------
// Thermal erosion
// ---------------------------------------------------------------------------

/**
 * In-place thermal erosion over a flat height buffer.
 * Each pass: cells that are steeper than `angle` compared to a 4-connected
 * neighbour shed material downhill.
 */
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
    // Yield once per pass so the event loop can handle incoming connections/input
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
            // Erode from high cell, deposit into low neighbor (bidirectional).
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
// Per-cell noise evaluation (reusable for both heightmap and zone grid)
// ---------------------------------------------------------------------------

interface CellNoise {
  continent: number;
  ridge: number;
  moisture: number;
  temperature: number;
  combined: number;
  biomeId: BiomeId;
  normalizedH: number; // combined after biome height scale + detail
  detailFbm: number;
  detailBillow: number;
}

function evaluateCell(
  wx: number,
  wy: number,
  seed: number,
  cfg: TerrainConfig,
): CellNoise {
  // 1. Domain warp
  let wxW = wx;
  let wyW = wy;
  if (cfg.domainWarp.enabled) {
    [wxW, wyW] = domainWarp(
      wx,
      wy,
      seed + 100,
      cfg.domainWarp.octaves,
      cfg.domainWarp.frequency,
      cfg.domainWarp.amplitude,
    );
  }

  // 2. Continental noise (warped coords)
  const cc = cfg.continent;
  const continent = fbm(
    wxW * cc.frequency,
    wyW * cc.frequency,
    seed + 200,
    cc.octaves,
    cc.lacunarity,
    cc.gain,
  );

  // 3. Tectonic ridges (warped coords)
  const tc = cfg.tectonic;
  const ridge = ridgedFbm(
    wxW * tc.frequency,
    wyW * tc.frequency,
    seed + 300,
    tc.octaves,
    tc.lacunarity,
    tc.gain,
    tc.ridgeOffset,
  );
  const continentMask = smoothstep(
    tc.continentThreshold,
    tc.continentThreshold + tc.continentBlend,
    continent,
  );
  const tectonicContrib = ridge * continentMask * tc.weight;

  // 4. Moisture (unwarped coords)
  const mc = cfg.moisture;
  const moisture = clamp(
    fbm(
      wx * mc.frequency,
      wy * mc.frequency,
      seed + 400,
      mc.octaves,
      mc.lacunarity,
      mc.gain,
    ) + mc.bias,
    0,
    1,
  );

  // 5. Temperature (unwarped coords, altitude corrected)
  const tmc = cfg.temperature;
  const tempRaw =
    fbm(
      wx * tmc.frequency,
      wy * tmc.frequency,
      seed + 500,
      tmc.octaves,
      tmc.lacunarity,
      tmc.gain,
    ) + tmc.bias;
  const temperature = clamp(
    tempRaw - continent * tmc.altitudeFalloff * 0.5,
    0,
    1,
  );

  // 6. Combined base
  const combined = clamp(continent + tectonicContrib, 0, 1);

  // 7. Biome classification
  const biomeId = classifyBiome(temperature, moisture, combined);
  const hScale = biomeHeightScale(biomeId);
  const roughness = biomeRoughness(biomeId);

  // 8. Detail noise (unwarped coords)
  const dc = cfg.detail;
  const detailFbm = fbm(
    wx * dc.frequency,
    wy * dc.frequency,
    seed + 600,
    dc.octaves,
    dc.lacunarity,
    dc.gain,
  );
  const detailBillow = billowFbm(
    wx * dc.frequency,
    wy * dc.frequency,
    seed + 700,
    dc.octaves,
    dc.lacunarity,
    dc.gain,
  );
  const detail =
    lerp(detailFbm, detailBillow, dc.billowMix) * dc.weight * roughness;

  // 9. Combine
  const normalizedH = clamp(combined * hScale + detail, 0, 1);

  return {
    continent,
    ridge,
    moisture,
    temperature,
    combined,
    biomeId,
    normalizedH,
    detailFbm,
    detailBillow,
  };
}

// ---------------------------------------------------------------------------
// Zone grid construction
// ---------------------------------------------------------------------------

function buildZoneGrid(seed: number, cfg: TerrainConfig): ZoneGridData {
  const gridSize = cfg.zone.gridSize;
  const cellWorldSize = TILE_SIZE / gridSize; // world units per zone cell
  const cells: ZoneCell[] = new Array(gridSize * gridSize);
  const hc = cfg.heightCurve;
  const spz = cfg.spawnZone;

  for (let zy = 0; zy < gridSize; zy++) {
    for (let zx = 0; zx < gridSize; zx++) {
      // Sample the centre of the zone cell
      const wx = (zx + 0.5) * cellWorldSize;
      const wy = (zy + 0.5) * cellWorldSize;

      const cn = evaluateCell(wx, wy, seed, cfg);

      // Height estimate from normalised value
      const curved = applyHeightCurve(
        cn.normalizedH,
        hc.seaLevel,
        hc.shoreWidth,
        hc.landExponent,
        hc.mountainExponent,
      );
      const avgHeight = snapHeight(hc.heightMin + curved * (hc.heightMax - hc.heightMin));

      // Spawn zone check
      const ddx = wx - spz.centerX;
      const ddy = wy - spz.centerY;
      const dist = Math.sqrt(ddx * ddx + ddy * ddy);
      const isSpawnZone = dist < spz.flatRadius;

      // Pseudo-random value for ruin roll
      const rng = valueNoise2D(zx * 17.3, zy * 13.7, seed + 9999);

      const zoneType = classifyZone(
        cn.biomeId,
        cn.combined,
        cn.moisture,
        cn.ridge,
        isSpawnZone,
        cfg.zone.ruinChance,
        cfg.zone.ruinMinAltitude,
        rng,
      );

      const corruption = ZONE_PROFILES[zoneType].corruptionBaseline;

      cells[zx + zy * gridSize] = {
        zoneType,
        biomeId: cn.biomeId,
        avgHeight,
        corruption,
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
 *
 * @param seed    Deterministic seed — different seeds produce different terrain.
 * @param config  Terrain generation config (defaults to DEFAULT_TERRAIN_CONFIG).
 */
export async function buildTerrainBuffers(
  seed = 0,
  config: TerrainConfig = DEFAULT_TERRAIN_CONFIG,
): Promise<{ heightBuffer: Float32Array; materialBuffer: Uint16Array; zoneGrid: ZoneGridData }> {
  console.time("[world] terrain gen");

  const cfg = config;
  const hc = cfg.heightCurve;
  const spz = cfg.spawnZone;

  // ---- Build full-resolution heightmap in a flat buffer ----
  const totalCells = TILE_SIZE * TILE_SIZE;
  const heightBuffer = new Float32Array(totalCells);
  const materialBuffer = new Uint16Array(totalCells);

  for (let wy = 0; wy < TILE_SIZE; wy++) {
    // Yield to the event loop every 32 rows
    if (wy % 32 === 0) {
      await new Promise<void>((r) => setTimeout(r, 0));
    }
    for (let wx = 0; wx < TILE_SIZE; wx++) {
      const cn = evaluateCell(wx, wy, seed, cfg);

      // 10. Apply height curve
      const curved = applyHeightCurve(
        cn.normalizedH,
        hc.seaLevel,
        hc.shoreWidth,
        hc.landExponent,
        hc.mountainExponent,
      );
      let h = snapHeight(hc.heightMin + curved * (hc.heightMax - hc.heightMin));

      // 11. Spawn zone flattening (on final h)
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

      // 12. Material
      const detailBlended = lerp(cn.detailFbm, cn.detailBillow, cfg.detail.billowMix);
      const mat = biomeMaterial(
        cn.biomeId,
        cn.normalizedH,
        cn.moisture,
        detailBlended,
        seed,
        wx,
        wy,
      );

      const idx = wx + wy * TILE_SIZE;
      heightBuffer[idx] = h;
      materialBuffer[idx] = mat;
    }
  }

  // ---- Thermal erosion post-pass ----
  if (cfg.erosion.enabled && cfg.erosion.thermalPasses > 0) {
    await thermalErosion(
      heightBuffer,
      TILE_SIZE,
      cfg.erosion.thermalPasses,
      cfg.erosion.thermalAngle,
    );
  }

  // ---- Build zone grid ----
  const zoneGrid = buildZoneGrid(seed, cfg);

  console.timeEnd("[world] terrain gen");

  return { heightBuffer, materialBuffer, zoneGrid };
}

/**
 * Write pre-built height/material buffers into ECS chunk entities.
 * Synchronous — no noise computation, just memory copies.
 *
 * @param world          ECS world to write chunk entities into.
 * @param heightBuffer   Flat Float32Array of TILE_SIZE × TILE_SIZE heights.
 * @param materialBuffer Flat Uint16Array of TILE_SIZE × TILE_SIZE material IDs.
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

/**
 * Generate a tile with multi-layer noise-based terrain.
 * Convenience async wrapper around buildTerrainBuffers + chunksFromBuffers.
 *
 * @param world   ECS world to write chunk entities into.
 * @param seed    Deterministic seed — different seeds produce different terrain.
 * @param config  Terrain generation config (defaults to DEFAULT_TERRAIN_CONFIG).
 */
export async function generateTile(
  world: World,
  seed = 0,
  config: TerrainConfig = DEFAULT_TERRAIN_CONFIG,
): Promise<GeneratedTile> {
  const { heightBuffer, materialBuffer, zoneGrid } = await buildTerrainBuffers(seed, config);
  const chunkIds = chunksFromBuffers(world, heightBuffer, materialBuffer);
  return { chunkIds, zoneGrid };
}

/**
 * Flat tile — uniform height 4.0, all grass.
 * Kept for tests and headless scenarios.
 */
export function generateFlatTile(world: World): GeneratedTile {
  const chunkIds: EntityId[] = [];
  const DEFAULT_HEIGHT = snapHeight(4.0);

  for (let cy = 0; cy < CHUNKS_PER_TILE_SIDE; cy++) {
    for (let cx = 0; cx < CHUNKS_PER_TILE_SIDE; cx++) {
      const id = createChunk(world, cx, cy);
      setChunkHeights(world, id, new Float32Array(CHUNK_CELLS).fill(DEFAULT_HEIGHT));
      setChunkMaterials(world, id, new Uint16Array(CHUNK_CELLS).fill(MAT_GRASS));
      chunkIds[cx + cy * CHUNKS_PER_TILE_SIDE] = id;
    }
  }

  // Flat tile has a trivial all-SafeZone zone grid
  const gridSize = DEFAULT_TERRAIN_CONFIG.zone.gridSize;
  const cells: ZoneCell[] = Array.from({ length: gridSize * gridSize }, () => ({
    zoneType: ZoneType.SafeZone,
    biomeId: BiomeId.Plains,
    avgHeight: DEFAULT_HEIGHT,
    corruption: 0,
  }));

  return { chunkIds, zoneGrid: { gridSize, cells } };
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
