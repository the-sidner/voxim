/**
 * World-map types (T-138).
 *
 * The macro world map is a fixed grid of cells, one cell per 512×512
 * playable tile. The coordinator generates it once from `WORLD_SEED` and
 * writes it to `world_map.payload` (JSON-encoded). Tile-servers read
 * their own cell at boot and use it as input to terrain generation.
 *
 * Mutability: the world map is immutable post-generation. Player-scale
 * edits live in `tile_saves`; macro-scale state changes (city falls,
 * trade route severed) live in `cities` — never here.
 */

export interface WorldMapCell {
  /** Canonical tile id this cell belongs to (matches TILE_ID env). */
  tileId: string;
  /** Macro-grid coordinate. */
  cellX: number;
  cellY: number;
  /** Biome name (matches a BiomeDef in @voxim/content). */
  biome: string;
  /**
   * Coarse elevation tier:
   *   0 — coast / lowland
   *   1 — plains
   *   2 — hills
   *   3 — mountain
   * Drives terrain generation height curves.
   */
  elevationTier: number;
  /** True if a river runs through this tile (terrain gen carves a channel). */
  riverFlag: boolean;
  /** True if a road passes through (terrain gen flattens a path). */
  roadFlag: boolean;
  /** True if a city is seeded in this tile (T-142 spawns CityState here). */
  citySeedFlag: boolean;
  /** 0..1 corruption level for the post-apocalyptic overlay. */
  corruptionLevel: number;
  /** Gate placements on the tile's edges (T-140 wires them as entities). */
  gatePositions: GatePosition[];
}

export interface GatePosition {
  /** "north" | "south" | "east" | "west" — which edge the gate sits on. */
  edge: "north" | "south" | "east" | "west";
  /** Tile id on the other side of the gate (the destination). */
  toTileId: string;
}

export interface WorldMapPayload {
  /** Schema version — bump when shape changes. */
  version: number;
  /** Seed used to generate this map (mirrors world_map.seed for sanity). */
  seed: number;
  /** Macro grid dimensions. */
  width: number;
  height: number;
  /** Indexed by tileId. */
  cells: Record<string, WorldMapCell>;
}

export const WORLD_MAP_VERSION = 1;

/** Encode a WorldMapPayload to bytea-suitable bytes (JSON UTF-8). */
export function encodeWorldMap(payload: WorldMapPayload): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(payload));
}

/** Decode a bytea payload back into a WorldMapPayload. */
export function decodeWorldMap(bytes: Uint8Array): WorldMapPayload {
  const obj = JSON.parse(new TextDecoder().decode(bytes)) as WorldMapPayload;
  if (obj.version !== WORLD_MAP_VERSION) {
    throw new Error(`world map version mismatch: got ${obj.version}, expected ${WORLD_MAP_VERSION}`);
  }
  return obj;
}
