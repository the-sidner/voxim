/**
 * Tilemap orchestrator — runs the per-tile pipeline against one worldmap cell.
 *
 * Pipeline:
 *   1. NoiseField        — biome-driven fbm cost surface (Float32Array)
 *   2. Chambers          — Poisson seeds + priority-flood organic growth
 *                          → openMask, chamberOf, chambers[]
 *   3. Network           — Delaunay + MST + braid + bezier carve with
 *                          per-edge width → re-labelled rooms/roomOf,
 *                          mutated openMask, corridors[]
 *   4. PortalPlacement   — bezier-carve gate→nearest-chamber → portals[],
 *                          additional corridors[], re-labelled rooms/roomOf
 *   5. BoundaryKinds     — per-pixel kind tagging
 *   6. RiverStamping     — overlay water onto openMask + kindOf
 *   7. Terrain           — heightmap from openMask + kindOf
 *   8. Materials         — per-pixel material id
 *
 * Pure function: same (worldCell, tileSeed, options) always yields the
 * same TileInit.
 */

import { runNoiseField } from "./pipeline/noise_field.ts";
import { runChambers } from "./pipeline/chambers.ts";
import { runNetwork } from "./pipeline/network.ts";
import { runPortalPlacement } from "./pipeline/portal_placement.ts";
import { runTerrain } from "./pipeline/terrain.ts";
import { runMaterials } from "./pipeline/materials.ts";
import { runBoundaryKinds } from "./pipeline/boundary_kinds.ts";
import { runRiverStamping } from "./pipeline/rivers.ts";
import { deriveGateSummary } from "./summary.ts";
import type { TileInit, TileInitWire } from "./types.ts";
import type { WorldCellRecord } from "../worldmap/types.ts";
import { DEFAULT_GEN_PARAMS, type GenParams } from "../genparams.ts";

const DEFAULT_TILE_SIZE = 512;
const DEFAULT_GRID_SIZE = 128;

export interface GenerateTileOptions {
  /** Side length of the playable tile in world units. Default 512. */
  tileSize?: number;
  /** Sample-grid resolution. Default 128 → 4 world units per pixel. */
  gridSize?: number;
  /** Worldgen tuning. Defaults from DEFAULT_GEN_PARAMS. */
  params?: GenParams;
}

export function generateTile(
  worldCell: WorldCellRecord,
  tileSeed: number,
  options: GenerateTileOptions = {},
): TileInit {
  const tileSize = options.tileSize ?? DEFAULT_TILE_SIZE;
  const gridSize = options.gridSize ?? DEFAULT_GRID_SIZE;
  const params   = options.params   ?? DEFAULT_GEN_PARAMS;
  const px2world = tileSize / gridSize;

  const noise = runNoiseField({
    biome: worldCell.biome,
    tileSeed,
    gridSize,
    params: params.noise,
  });

  const chambered = runChambers({
    noiseField: noise.noiseField,
    gridSize,
    px2world,
    tileSeed,
    params: params.room,
  });

  const networked = runNetwork({
    openMask:  chambered.openMask,
    chamberOf: chambered.chamberOf,
    chambers:  chambered.chambers,
    gridSize,
    px2world,
    tileSeed,
    params:    params.network,
  });

  const placed = runPortalPlacement({
    openMask:  networked.openMask,
    chamberOf: chambered.chamberOf,
    chambers:  chambered.chambers,
    gridSize,
    px2world,
    tileSize,
    gates:     worldCell.gates,
    network:   params.network,
    tileSeed,
  });

  // Kinds runs BEFORE terrain so the terrain stage can decide which
  // closed pixels deserve the wall step (CLIFF) vs. which stay flat
  // (VEGETATION / WATER / others — they're still impassable via the
  // openMask collision path in tile-server's physics).
  const kinds = runBoundaryKinds({
    openMask: placed.openMask,
    biome:    worldCell.biome,
    tileSeed,
    gridSize,
    params:   params.kinds,
  });

  // Linear features stamp AFTER kinds (overrides kindOf to WATER) and
  // BEFORE terrain (so river pixels register as non-CLIFF and stay flat).
  // Mutates placed.openMask + kinds.kindOf in place.
  runRiverStamping({
    rivers:   worldCell.rivers,
    openMask: placed.openMask,
    kindOf:   kinds.kindOf,
    gridSize,
    tileSize,
    widthPixels: params.river.widthPixels,
  });

  const terrain = runTerrain({
    openMask: placed.openMask,
    kindOf:   kinds.kindOf,
    biome:    worldCell.biome,
    tileSeed,
    gridSize,
    params:   params.terrain,
  });

  const mats = runMaterials({
    biome: worldCell.biome,
    tileSeed,
    gridSize,
    params: params.materials,
  });

  return {
    cellX:    worldCell.cellX,
    cellY:    worldCell.cellY,
    tileSize,
    gridSize,
    openMask: placed.openMask,
    roomOf:   placed.roomOf,
    rooms:    placed.rooms,
    chamberOf: chambered.chamberOf,
    chambers:  chambered.chambers,
    corridors: networked.corridors.concat(placed.corridors),
    portals:  placed.portals,
    gateSummary: deriveGateSummary(placed.portals),
    heightMap: terrain.heightMap,
    materials: mats.materials,
    kindOf:    kinds.kindOf,
    boundaries: [],
    features:   [],
  };
}

// ---- wire encoding --------------------------------------------------------

export function tileInitToWire(t: TileInit): TileInitWire {
  return {
    cellX:    t.cellX,
    cellY:    t.cellY,
    tileSize: t.tileSize,
    gridSize: t.gridSize,
    openMaskB64:   bytesToBase64(t.openMask),
    roomOfB64:     bytesToBase64(new Uint8Array(t.roomOf.buffer,    t.roomOf.byteOffset,    t.roomOf.byteLength)),
    chamberOfB64:  bytesToBase64(new Uint8Array(t.chamberOf.buffer, t.chamberOf.byteOffset, t.chamberOf.byteLength)),
    heightMapB64:  bytesToBase64(new Uint8Array(t.heightMap.buffer, t.heightMap.byteOffset, t.heightMap.byteLength)),
    materialsB64:  bytesToBase64(new Uint8Array(t.materials.buffer, t.materials.byteOffset, t.materials.byteLength)),
    kindOfB64:     bytesToBase64(new Uint8Array(t.kindOf.buffer,    t.kindOf.byteOffset,    t.kindOf.byteLength)),
    rooms:    t.rooms,
    chambers: t.chambers,
    corridors: t.corridors,
    portals:  t.portals,
    gateSummary: t.gateSummary,
    boundaries: t.boundaries,
    features:   t.features,
  };
}

export function tileInitFromWire(w: TileInitWire): TileInit {
  const openMask = base64ToBytes(w.openMaskB64);
  const roomOfBytes = base64ToBytes(w.roomOfB64);
  const roomOf = new Uint16Array(
    roomOfBytes.buffer,
    roomOfBytes.byteOffset,
    roomOfBytes.byteLength / 2,
  );
  const chamberOfBytes = base64ToBytes(w.chamberOfB64);
  const chamberOf = new Uint16Array(
    chamberOfBytes.buffer,
    chamberOfBytes.byteOffset,
    chamberOfBytes.byteLength / 2,
  );
  const heightBytes = base64ToBytes(w.heightMapB64);
  const heightMap = new Float32Array(
    heightBytes.buffer,
    heightBytes.byteOffset,
    heightBytes.byteLength / 4,
  );
  const matBytes = base64ToBytes(w.materialsB64);
  const materials = new Uint16Array(
    matBytes.buffer,
    matBytes.byteOffset,
    matBytes.byteLength / 2,
  );
  const kindBytes = base64ToBytes(w.kindOfB64);
  const kindOf = new Uint16Array(
    kindBytes.buffer,
    kindBytes.byteOffset,
    kindBytes.byteLength / 2,
  );
  return {
    cellX:    w.cellX,
    cellY:    w.cellY,
    tileSize: w.tileSize,
    gridSize: w.gridSize,
    openMask,
    roomOf,
    chamberOf,
    heightMap,
    materials,
    kindOf,
    rooms:    w.rooms,
    chambers: w.chambers,
    corridors: w.corridors,
    portals:  w.portals,
    gateSummary: w.gateSummary,
    boundaries: w.boundaries,
    features:   w.features,
  };
}

function bytesToBase64(bytes: Uint8Array): string {
  // Chunked to avoid blowing the call stack on String.fromCharCode.apply.
  let s = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
  }
  return btoa(s);
}

function base64ToBytes(b64: string): Uint8Array {
  if (typeof b64 !== "string") {
    throw new Error(
      `tile-init wire decode: expected base64 string, got ${b64 === undefined ? "undefined" : typeof b64}; ` +
      `payload likely missing a field (atlas/tile-server image mismatch?)`,
    );
  }
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
