/**
 * World-map generator.
 *
 * Produces a deterministic WorldMapPayload from a seed. For the dev
 * vertical slice we generate a small grid (default 2×2 = 4 tiles)
 * matching the compose-declared tile slots. The actual tile ids are
 * passed in so the generator stays decoupled from naming convention.
 *
 * This is the macro-scale counterpart to seedFromTileId — the map says
 * what KIND of tile each one is, the per-tile generator (in
 * @voxim/world) decides the concrete heightmap from that.
 *
 * T-138 ships a tiny rule-driven generator. T-056..T-060 will replace
 * this with proper noise-driven biome / river / road / city seeding.
 */
import {
  WORLD_MAP_VERSION,
  type WorldMapPayload,
  type WorldMapCell,
  type GatePosition,
} from "@voxim/protocol";

export interface GenerateWorldMapInput {
  seed: number;
  /** Tile ids to generate cells for. Their order maps onto a row-major grid. */
  tileIds: string[];
  /** Grid width. tileIds.length must equal width × height. */
  width: number;
  height: number;
}

const BIOMES = ["plains", "forest", "hills", "swamp", "desert", "tundra", "badlands"];

/** Tiny LCG so the map is fully deterministic per seed. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

export function generateWorldMap(input: GenerateWorldMapInput): WorldMapPayload {
  const { seed, tileIds, width, height } = input;
  if (tileIds.length !== width * height) {
    throw new Error(
      `world map requires ${width * height} tile ids (got ${tileIds.length})`,
    );
  }
  const rand = lcg(seed);
  const cells: Record<string, WorldMapCell> = {};

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      const tileId = tileIds[idx];

      const biome = BIOMES[Math.floor(rand() * BIOMES.length)];
      const elevationTier = Math.floor(rand() * 4);
      const riverFlag = rand() < 0.25;
      const roadFlag = rand() < 0.4;
      const citySeedFlag = rand() < 0.2;
      const corruptionLevel = Math.round(rand() * 100) / 100;

      // Edge gates: every internal border has a gate. This gives full
      // connectivity in the dev grid; a real generator would gate roads
      // and rivers selectively.
      const gates: GatePosition[] = [];
      if (y > 0)          gates.push({ edge: "north", toTileId: tileIds[(y - 1) * width + x] });
      if (y < height - 1) gates.push({ edge: "south", toTileId: tileIds[(y + 1) * width + x] });
      if (x > 0)          gates.push({ edge: "west",  toTileId: tileIds[y * width + (x - 1)] });
      if (x < width - 1)  gates.push({ edge: "east",  toTileId: tileIds[y * width + (x + 1)] });

      cells[tileId] = {
        tileId,
        cellX: x,
        cellY: y,
        biome,
        elevationTier,
        riverFlag,
        roadFlag,
        citySeedFlag,
        corruptionLevel,
        gatePositions: gates,
      };
    }
  }

  return {
    version: WORLD_MAP_VERSION,
    seed,
    width,
    height,
    cells,
  };
}
