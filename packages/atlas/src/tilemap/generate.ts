/**
 * Tilemap orchestrator — runs the per-tile pipeline against one worldmap cell.
 *
 * Pipeline (phase 2A):
 *   1. NoiseField        — biome-driven fbm + threshold → openMask
 *   2. PortalPlacement   — carve gate corridors + re-derive rooms → rooms[], portals[]
 *      (room detection is invoked internally by portal placement so the
 *      labelling already accounts for the carved corridors)
 *
 * Boundary filling and feature placement are deferred to phase 2B; their
 * slots in TileInit start empty.
 *
 * Pure function: same (worldCell, tileSeed, options) always yields the
 * same TileInit.
 */

import { runNoiseField } from "./pipeline/noise_field.ts";
import { runPortalPlacement } from "./pipeline/portal_placement.ts";
import { runTerrain } from "./pipeline/terrain.ts";
import { runMaterials } from "./pipeline/materials.ts";
import { runBoundaryKinds } from "./pipeline/boundary_kinds.ts";
import { deriveGateSummary } from "./summary.ts";
import type { TileInit, TileInitWire } from "./types.ts";
import type { WorldCellRecord } from "../worldmap/types.ts";

const DEFAULT_TILE_SIZE = 512;
const DEFAULT_GRID_SIZE = 128;

export interface GenerateTileOptions {
  /** Side length of the playable tile in world units. Default 512. */
  tileSize?: number;
  /** Sample-grid resolution. Default 128 → 4 world units per pixel. */
  gridSize?: number;
}

export function generateTile(
  worldCell: WorldCellRecord,
  tileSeed: number,
  options: GenerateTileOptions = {},
): TileInit {
  const tileSize = options.tileSize ?? DEFAULT_TILE_SIZE;
  const gridSize = options.gridSize ?? DEFAULT_GRID_SIZE;
  const px2world = tileSize / gridSize;

  const noise = runNoiseField({
    biome: worldCell.biome,
    tileSeed,
    gridSize,
  });

  const placed = runPortalPlacement({
    openMask: noise.openMask,
    gridSize,
    px2world,
    tileSize,
    gates: worldCell.gates,
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
  });

  const terrain = runTerrain({
    openMask: placed.openMask,
    kindOf:   kinds.kindOf,
    biome:    worldCell.biome,
    tileSeed,
    gridSize,
  });

  const mats = runMaterials({
    biome: worldCell.biome,
    tileSeed,
    gridSize,
  });

  return {
    cellX:    worldCell.cellX,
    cellY:    worldCell.cellY,
    tileSize,
    gridSize,
    openMask: placed.openMask,
    roomOf:   placed.roomOf,
    rooms:    placed.rooms,
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
    openMaskB64: bytesToBase64(t.openMask),
    roomOfB64:   bytesToBase64(new Uint8Array(t.roomOf.buffer, t.roomOf.byteOffset, t.roomOf.byteLength)),
    heightMapB64: bytesToBase64(new Uint8Array(t.heightMap.buffer, t.heightMap.byteOffset, t.heightMap.byteLength)),
    materialsB64: bytesToBase64(new Uint8Array(t.materials.buffer, t.materials.byteOffset, t.materials.byteLength)),
    kindOfB64:    bytesToBase64(new Uint8Array(t.kindOf.buffer,    t.kindOf.byteOffset,    t.kindOf.byteLength)),
    rooms:    t.rooms,
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
    heightMap,
    materials,
    kindOf,
    rooms:    w.rooms,
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
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
