/**
 * Deterministic worldmap generation.
 *
 * Pure function: same (seed, width, height) always yields the same WorldMap.
 *
 *   1. For every cell, sample fbm at four offsets to produce continuous
 *      biome parameters (temperature, moisture, altitude, ruggedness).
 *   2. For every shared edge between two cells, deterministically pick a
 *      gate offset from a hash of the edge identity. Both cells receive
 *      the same offset (mirror invariant Q6).
 *   3. World-perimeter edges have no gate.
 */

import { fbm, hash2 } from "../common/noise.ts";
import { generateRivers } from "./rivers.ts";
import type { Edge, GateSpec, WorldCellRecord, WorldMap } from "./types.ts";

/**
 * Tile size in world units. Must match the runtime tile size; today
 * that's protocol's TILE_WORLD_SIZE (512). Held locally so atlas isn't
 * coupled to the legacy WorldMapPayload types in protocol — those will
 * be retired once tile-server reads tile_init from atlas.
 */
const TILE_WORLD_SIZE = 512;
/** Margin from tile corners where gates are clamped, in world units. */
const GATE_INSET = 8;

// Distinct sub-seeds per biome field so they don't correlate trivially.
const SEED_TEMP    = 0x10001001;
const SEED_MOIST   = 0x10001003;
const SEED_ALT     = 0x10001005;
const SEED_RUGGED  = 0x10001007;
const SEED_GATE_NS = 0x20002001;
const SEED_GATE_EW = 0x20002003;

/** Cell-grid spacing of the biome noise. ~6 cells per "biome blob". */
const BIOME_FREQUENCY = 1 / 6;
/** Octaves of fbm for biome fields. More = more detail boundaries. */
const BIOME_OCTAVES = 3;

export function generateWorldMap(
  seed: number,
  width: number,
  height: number,
): WorldMap {
  const cells: WorldCellRecord[] = [];

  for (let cellY = 0; cellY < height; cellY++) {
    for (let cellX = 0; cellX < width; cellX++) {
      cells.push(makeCell(seed, cellX, cellY, width, height));
    }
  }

  // Linear features run after every cell exists so the river walker can
  // peek at neighbours' altitudes when picking the downhill direction.
  generateRivers(cells, width, height, seed);

  return { seed, width, height, cells };
}

// ---- per-cell ---------------------------------------------------------

function makeCell(
  seed: number,
  cellX: number,
  cellY: number,
  width: number,
  height: number,
): WorldCellRecord {
  const fx = cellX * BIOME_FREQUENCY;
  const fy = cellY * BIOME_FREQUENCY;

  return {
    cellX,
    cellY,
    biome: {
      temperature: fbm(fx, fy, seed ^ SEED_TEMP,   BIOME_OCTAVES),
      moisture:    fbm(fx, fy, seed ^ SEED_MOIST,  BIOME_OCTAVES),
      altitude:    fbm(fx, fy, seed ^ SEED_ALT,    BIOME_OCTAVES),
      ruggedness:  fbm(fx, fy, seed ^ SEED_RUGGED, BIOME_OCTAVES),
    },
    gates: {
      north: gateOnEdge(seed, cellX, cellY, width, height, "north"),
      east:  gateOnEdge(seed, cellX, cellY, width, height, "east"),
      south: gateOnEdge(seed, cellX, cellY, width, height, "south"),
      west:  gateOnEdge(seed, cellX, cellY, width, height, "west"),
    },
    // Filled in by generateRivers() after every cell exists.
    rivers: [],
  };
}

// ---- gate placement ---------------------------------------------------

function gateOnEdge(
  seed: number,
  cellX: number,
  cellY: number,
  width: number,
  height: number,
  edge: Edge,
): GateSpec | null {
  const neighbour = neighbourOf(cellX, cellY, edge);
  if (!inBounds(neighbour.x, neighbour.y, width, height)) return null;

  const offset = sharedEdgeOffset(seed, cellX, cellY, edge);
  return {
    offset,
    toCellX: neighbour.x,
    toCellY: neighbour.y,
  };
}

function neighbourOf(cellX: number, cellY: number, edge: Edge): { x: number; y: number } {
  switch (edge) {
    case "north": return { x: cellX,     y: cellY - 1 };
    case "south": return { x: cellX,     y: cellY + 1 };
    case "east":  return { x: cellX + 1, y: cellY     };
    case "west":  return { x: cellX - 1, y: cellY     };
  }
}

function inBounds(x: number, y: number, w: number, h: number): boolean {
  return x >= 0 && y >= 0 && x < w && y < h;
}

/**
 * Hash that's symmetric across the shared edge: cell A's east edge and
 * cell B's west edge produce the same offset because the canonical edge
 * key is built from the lower-coordinate cell's position.
 */
function sharedEdgeOffset(
  seed: number,
  cellX: number,
  cellY: number,
  edge: Edge,
): number {
  // Canonicalise: every shared edge has one "owner" cell — the one with
  // the lower coordinate on the perpendicular axis. North/south edges
  // share with the cell above/below; east/west with the cell right/left.
  let kx: number, ky: number, axisSeed: number;
  switch (edge) {
    case "north": kx = cellX;     ky = cellY - 1; axisSeed = SEED_GATE_NS; break;
    case "south": kx = cellX;     ky = cellY;     axisSeed = SEED_GATE_NS; break;
    case "east":  kx = cellX;     ky = cellY;     axisSeed = SEED_GATE_EW; break;
    case "west":  kx = cellX - 1; ky = cellY;     axisSeed = SEED_GATE_EW; break;
  }
  // hash2 returns [0, 1); scale into the safe gate band.
  const h = hash2(kx, ky, seed ^ axisSeed);
  const span = TILE_WORLD_SIZE - 2 * GATE_INSET;
  return GATE_INSET + h * span;
}
