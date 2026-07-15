/**
 * RebakePlanner — dedupes the terrain neighbour-rebake fan-out.
 *
 * A chunk's bake reads exactly ONE thing from each cardinal neighbour: the
 * adjacent edge row/column of that neighbour's heightmap (`buildChunkAtoms`'s
 * `neigh()` — cliff column floors). So a neighbour only needs re-baking when
 * the edge it CONSUMED at its own last bake no longer matches the changed
 * chunk's current heightmap. Blindly rebaking all four neighbours (the old
 * behaviour) baked every interior chunk ~5× at the load-time flush and
 * re-baked 5 chunks for every single interior dig.
 *
 * The planner records, per baked chunk, a copy of the four edges it consumed;
 * `staleNeighbours(cx, cy, hm)` then answers "which already-baked neighbours
 * of (cx,cy) are now stale?". Never-baked neighbours are skipped — they bake
 * through their own updateTerrain call (the load flush visits every chunk)
 * or the content-hydration deferral queue. A neighbour that baked BEFORE
 * (cx,cy)'s heightmap streamed in has a `null` consumed edge on that side,
 * which counts as stale — it baked a no-wall fallback edge that must now be
 * corrected to the true cliff.
 */
import type { HeightmapData } from "@voxim/codecs";

/** Chunk edge length in cells — matches terrain_voxels.ts's bake grid. */
const CHUNK = 32;

export interface NeighbourHeightmaps {
  N: HeightmapData | null;
  E: HeightmapData | null;
  S: HeightmapData | null;
  W: HeightmapData | null;
}

/** Edges consumed FROM each neighbour at bake time (null = neighbour was
 *  absent, i.e. the bake used the no-wall `h` fallback on that side). */
interface ConsumedEdges {
  N: Float32Array | null;
  E: Float32Array | null;
  S: Float32Array | null;
  W: Float32Array | null;
}

/** The neighbour's row/column a bake reads, per buildChunkAtoms's neigh(). */
function edgeRow(hm: HeightmapData, cy: number): Float32Array {
  return hm.data.slice(cy * CHUNK, cy * CHUNK + CHUNK);
}
function edgeCol(hm: HeightmapData, cx: number): Float32Array {
  const out = new Float32Array(CHUNK);
  for (let cy = 0; cy < CHUNK; cy++) out[cy] = hm.data[cx + cy * CHUNK];
  return out;
}

function edgesEqual(consumed: Float32Array | null, current: Float32Array): boolean {
  if (!consumed) return false; // baked against the no-wall fallback → stale
  for (let i = 0; i < CHUNK; i++) {
    if (consumed[i] !== current[i]) return false;
  }
  return true;
}

const key = (cx: number, cy: number): string => `${cx},${cy}`;

export class RebakePlanner {
  private readonly consumed = new Map<string, ConsumedEdges>();

  /** Record what chunk (cx,cy)'s bake consumed from each neighbour — call
   *  with the same neighbour heightmaps handed to buildChunkAtoms. */
  recordBake(cx: number, cy: number, nb: NeighbourHeightmaps): void {
    this.consumed.set(key(cx, cy), {
      N: nb.N ? edgeRow(nb.N, CHUNK - 1) : null, // north neighbour's southernmost row
      S: nb.S ? edgeRow(nb.S, 0) : null,         // south neighbour's northernmost row
      E: nb.E ? edgeCol(nb.E, 0) : null,         // east neighbour's westernmost column
      W: nb.W ? edgeCol(nb.W, CHUNK - 1) : null, // west neighbour's easternmost column
    });
  }

  /** Which already-baked neighbours of (cx,cy) consumed an edge that no
   *  longer matches (cx,cy)'s current heightmap? */
  staleNeighbours(cx: number, cy: number, hm: HeightmapData): [number, number][] {
    const out: [number, number][] = [];
    // North neighbour (cy-1) consumed us as ITS south neighbour: our row 0.
    const north = this.consumed.get(key(cx, cy - 1));
    if (north && !edgesEqual(north.S, edgeRow(hm, 0))) out.push([cx, cy - 1]);
    const south = this.consumed.get(key(cx, cy + 1));
    if (south && !edgesEqual(south.N, edgeRow(hm, CHUNK - 1))) out.push([cx, cy + 1]);
    const east = this.consumed.get(key(cx + 1, cy));
    if (east && !edgesEqual(east.W, edgeCol(hm, CHUNK - 1))) out.push([cx + 1, cy]);
    const west = this.consumed.get(key(cx - 1, cy));
    if (west && !edgesEqual(west.E, edgeCol(hm, 0))) out.push([cx - 1, cy]);
    return out;
  }

  /** The chunk's mesh set was torn down (removeTerrain). */
  forget(cx: number, cy: number): void {
    this.consumed.delete(key(cx, cy));
  }

  /** Whole-world teardown (tile transition). */
  clear(): void {
    this.consumed.clear();
  }
}
