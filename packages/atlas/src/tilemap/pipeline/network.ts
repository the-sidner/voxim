/**
 * Stage 3 — interwoven room network.
 *
 * Plans corridors between rooms so the tile reads as a deliberate net,
 * not as whatever shape the noise field happened to leave behind.
 *
 *   1. Delaunay triangulation over room centroids
 *        → candidate edges (planar, locally optimal triangulation).
 *   2. Drop edges longer than `params.maxEdgeLength` so we don't carve
 *      across the whole tile when a corner has a lonely room.
 *   3. Kruskal MST → guarantees every room connects to every other.
 *   4. Braid: keep `params.loopRate` of the remaining (non-tree) edges
 *      as loops. This is THE knob that makes the maze feel explorative
 *      vs. linear — at 0 you get a tree, at 1 the full Delaunay net.
 *   5. Carve each chosen edge via A* with NOISE-FLOW COST: closed pixels
 *      cost more the further their noise value sits past the threshold.
 *      The path naturally meanders along weak-wall regions instead of
 *      cutting straight lines.
 *   6. Widen each carved path by `params.corridorWidth` and re-flood so
 *      `roomOf` reflects the merged connected components.
 *
 * Mutates `openMask` and returns the refreshed `roomOf` / `rooms[]`.
 */

import { runRoomDetection } from "./room_detection.ts";
import { carveCorridor, clampPx, type CarveContext } from "./carve.ts";
import type { Room } from "../types.ts";
import type { GenParams } from "../../genparams.ts";

export interface NetworkInput {
  /** From the noise stage. Mutated in place by carves. */
  openMask: Uint8Array;
  /** From the noise stage. Read-only (drives A* cost). */
  noiseField: Float32Array;
  /** Threshold used to derive openMask. Carve cost is relative to this. */
  threshold: number;
  /** From roomify. Read-only here; we re-flood at the end. */
  rooms: Room[];
  /** From roomify. Read-only — we recompute after carving. */
  roomOf: Uint16Array;
  gridSize: number;
  px2world: number;
  tileSeed: number;
  params: GenParams["network"];
}

export interface NetworkOutput {
  /** Same buffer as input, with corridors carved. */
  openMask: Uint8Array;
  /** Re-flooded labels — fewer components than before (corridors merged some). */
  rooms: Room[];
  roomOf: Uint16Array;
}

const NETWORK_SUB_SEED = 0x4e570001;

export function runNetwork(input: NetworkInput): NetworkOutput {
  const { openMask, noiseField, threshold, rooms, gridSize, px2world, tileSeed, params } = input;

  // Edge case: 0–1 rooms — nothing to do.
  if (rooms.length < 2) {
    const det = runRoomDetection({ openMask, gridSize, px2world });
    return { openMask, rooms: det.rooms, roomOf: det.roomOf };
  }

  // ---- 1. Delaunay over room centroids (in pixel space) ------------------
  const pts: Array<{ x: number; y: number }> = rooms.map(r => ({
    x: r.cx / px2world,
    y: r.cy / px2world,
  }));
  const tris = delaunay(pts);

  // ---- 2. Edges from triangles, deduped, length-capped -------------------
  type Edge = { a: number; b: number; len: number };
  const seen = new Set<number>();
  const edges: Edge[] = [];
  const maxLen = params.maxEdgeLength;
  const pushEdge = (i: number, j: number) => {
    const a = i < j ? i : j;
    const b = i < j ? j : i;
    const key = a * pts.length + b;
    if (seen.has(key)) return;
    seen.add(key);
    const dx = pts[a].x - pts[b].x;
    const dy = pts[a].y - pts[b].y;
    const len = Math.hypot(dx, dy);
    if (len > maxLen) return;
    edges.push({ a, b, len });
  };
  for (const t of tris) {
    pushEdge(t[0], t[1]);
    pushEdge(t[1], t[2]);
    pushEdge(t[2], t[0]);
  }
  // Sort short→long for both MST and braid steps.
  edges.sort((p, q) => p.len - q.len);

  // ---- 3. Kruskal MST + 4. Braid -----------------------------------------
  const uf = new UnionFind(pts.length);
  const tree: Edge[] = [];
  const extras: Edge[] = [];
  for (const e of edges) {
    if (uf.union(e.a, e.b)) tree.push(e);
    else extras.push(e);
  }
  const rng = mulberry32(tileSeed ^ NETWORK_SUB_SEED);
  const braids: Edge[] = [];
  for (const e of extras) {
    if (rng() < params.loopRate) braids.push(e);
  }

  // ---- 5. Carve each chosen edge with noise-flow A* ----------------------
  // For each edge we pick the two centroid pixels as endpoints. A* may
  // pass through other open pixels (cheap) and only carves where it has
  // to. Each carve mutates openMask before the next runs, so later
  // carves see and prefer the rooms+corridors built earlier.
  const ctx: CarveContext = {
    openMask, noiseField, threshold, gridSize,
    noiseCostScale: params.noiseCostScale,
    corridorWidth:  params.corridorWidth,
  };
  const chosen = tree.concat(braids);
  for (const e of chosen) {
    const ax = clampPx(Math.round(pts[e.a].x), gridSize);
    const ay = clampPx(Math.round(pts[e.a].y), gridSize);
    const bx = clampPx(Math.round(pts[e.b].x), gridSize);
    const by = clampPx(Math.round(pts[e.b].y), gridSize);
    carveCorridor(ax, ay, bx, by, ctx);
  }

  // ---- 6. Re-flood labels ------------------------------------------------
  const det = runRoomDetection({ openMask, gridSize, px2world });
  return { openMask, rooms: det.rooms, roomOf: det.roomOf };
}

// ============================================================================
// Delaunay — incremental Bowyer–Watson.
//
// Returns triangles as triples of point indices into `pts`. Robust enough
// for the small (≤ ~120) point sets a single tile produces. O(n²) typical.
// ============================================================================

type Tri = [number, number, number];

function delaunay(pts: Array<{ x: number; y: number }>): Tri[] {
  const n = pts.length;
  if (n < 3) return [];

  // Super-triangle: big enough that all input points sit comfortably inside.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  const dx = (maxX - minX) || 1;
  const dy = (maxY - minY) || 1;
  const dmax = Math.max(dx, dy) * 20;
  const midx = (minX + maxX) / 2;
  const midy = (minY + maxY) / 2;
  // Three super-triangle points indexed n, n+1, n+2 in an extended pts list.
  const ext = pts.slice();
  ext.push({ x: midx - dmax, y: midy - dmax });
  ext.push({ x: midx + dmax, y: midy - dmax });
  ext.push({ x: midx,        y: midy + dmax });
  let triangles: Tri[] = [[n, n + 1, n + 2]];

  for (let pi = 0; pi < n; pi++) {
    const p = ext[pi];
    // Find triangles whose circumcircle contains p ("bad triangles").
    const bad: number[] = [];
    for (let ti = 0; ti < triangles.length; ti++) {
      if (inCircumcircle(p, ext[triangles[ti][0]], ext[triangles[ti][1]], ext[triangles[ti][2]])) {
        bad.push(ti);
      }
    }
    // Polygonal hole = edges that appear exactly once across bad triangles.
    const edgeCount = new Map<string, number>();
    for (const ti of bad) {
      const t = triangles[ti];
      addEdge(edgeCount, t[0], t[1]);
      addEdge(edgeCount, t[1], t[2]);
      addEdge(edgeCount, t[2], t[0]);
    }
    // Remove bad triangles (descending so indices stay valid).
    for (let i = bad.length - 1; i >= 0; i--) triangles.splice(bad[i], 1);
    // Re-triangulate the hole against p.
    for (const [key, count] of edgeCount) {
      if (count !== 1) continue;
      const [a, b] = key.split(",").map(Number);
      triangles.push([a, b, pi]);
    }
  }

  // Drop triangles touching the super-triangle.
  triangles = triangles.filter(t => t[0] < n && t[1] < n && t[2] < n);
  return triangles;
}

function addEdge(m: Map<string, number>, a: number, b: number): void {
  const key = a < b ? `${a},${b}` : `${b},${a}`;
  m.set(key, (m.get(key) ?? 0) + 1);
}

function inCircumcircle(
  p: { x: number; y: number },
  a: { x: number; y: number },
  b: { x: number; y: number },
  c: { x: number; y: number },
): boolean {
  const ax = a.x - p.x, ay = a.y - p.y;
  const bx = b.x - p.x, by = b.y - p.y;
  const cx = c.x - p.x, cy = c.y - p.y;
  // Standard incircle determinant: p is inside iff det > 0 for CCW (a,b,c).
  // We don't know triangle orientation, so test |det| > 0 with sign-aware
  // result: take the sign of the orientation of (a,b,c) and require det
  // and orientation to agree.
  const det =
    (ax * ax + ay * ay) * (bx * cy - cx * by) -
    (bx * bx + by * by) * (ax * cy - cx * ay) +
    (cx * cx + cy * cy) * (ax * by - bx * ay);
  const orient = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  return orient > 0 ? det > 0 : det < 0;
}

// ============================================================================
// Union-Find for Kruskal.
// ============================================================================

class UnionFind {
  private parent: Int32Array;
  private rank:   Int8Array;
  constructor(n: number) {
    this.parent = new Int32Array(n);
    this.rank   = new Int8Array(n);
    for (let i = 0; i < n; i++) this.parent[i] = i;
  }
  find(x: number): number {
    while (this.parent[x] !== x) {
      this.parent[x] = this.parent[this.parent[x]];
      x = this.parent[x];
    }
    return x;
  }
  /** Returns true if the two were in different sets (i.e. an edge was added). */
  union(a: number, b: number): boolean {
    const ra = this.find(a), rb = this.find(b);
    if (ra === rb) return false;
    if (this.rank[ra] < this.rank[rb])      this.parent[ra] = rb;
    else if (this.rank[ra] > this.rank[rb]) this.parent[rb] = ra;
    else { this.parent[rb] = ra; this.rank[ra]++; }
    return true;
  }
}

// Mulberry32 — small, deterministic PRNG. Good enough for braid sampling.
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
