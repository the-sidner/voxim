/**
 * Stage 3 — interwoven chamber network.
 *
 * Plans corridors between chambers as a deliberate graph:
 *
 *   1. Delaunay triangulation over chamber centroids → candidate edges.
 *   2. Drop edges longer than `params.maxEdgeLength`.
 *   3. Kruskal MST → guaranteed connectivity.
 *   4. Braid: keep `params.loopRate` of the non-tree edges as loops.
 *   5. For each kept edge, ray-march from each centroid toward the
 *      partner using `chamberOf` to find the chamber-boundary entry/exit
 *      pixel. The corridor enters and exits the chamber walls instead
 *      of crossing the interior — chambers stay intact.
 *   6. Generate `segments + 1` waypoints between the two boundary
 *      endpoints with sin-tapered perpendicular perturbation, clipped
 *      to a tile-interior margin. Carve as a Catmull-Rom spline with a
 *      brush whose half-width is sampled per edge from `[widthMin,
 *      widthMax]`.
 *   7. Re-flood `roomOf` so portal placement / gate summary see the
 *      merged connected components.
 */

import { runRoomDetection } from "./room_detection.ts";
import { carveSpline, makeWaypoints } from "./bezier_carve.ts";
import type { Corridor, Room } from "../types.ts";
import type { GenParams } from "../../genparams.ts";

export interface NetworkInput {
  /** From chambers stage. Mutated in place by carves. */
  openMask: Uint8Array;
  /** From chambers stage. Read-only — used to locate chamber boundaries. */
  chamberOf: Uint16Array;
  /** From chambers stage. Read-only. */
  chambers: Room[];
  gridSize: number;
  px2world: number;
  tileSeed: number;
  params: GenParams["network"];
}

export interface NetworkOutput {
  /** Same buffer as input, with corridors carved. */
  openMask: Uint8Array;
  /** Re-flooded labels — fewer components than chambers (corridors merged some). */
  rooms: Room[];
  roomOf: Uint16Array;
  /** Carved corridor records, one per chosen edge. */
  corridors: Corridor[];
}

const NETWORK_SUB_SEED = 0x4e570001;

export function runNetwork(input: NetworkInput): NetworkOutput {
  const { openMask, chamberOf, chambers, gridSize, px2world, tileSeed, params } = input;

  // 0–1 chambers → no edges to carve. Re-flood and return.
  if (chambers.length < 2) {
    const det = runRoomDetection({ openMask, gridSize, px2world });
    return { openMask, rooms: det.rooms, roomOf: det.roomOf, corridors: [] };
  }

  // ---- 1. Delaunay over chamber centroids (in pixel space) ---------------
  const pts: Array<{ x: number; y: number }> = chambers.map(r => ({
    x: r.cx / px2world,
    y: r.cy / px2world,
  }));
  const tris = delaunay(pts);

  // ---- 2. Edges (deduped, length-capped) ---------------------------------
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
  edges.sort((p, q) => p.len - q.len);

  // ---- 3. MST + 4. Braid -------------------------------------------------
  const uf = new UnionFind(pts.length);
  const tree:   Edge[] = [];
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

  // ---- 5. Boundary endpoints + 6. carve segmented spline -----------------
  const corridors: Corridor[] = [];
  const chosen = tree.concat(braids);
  for (const e of chosen) {
    const a = chambers.find(c => c.id === e.a)!;
    const b = chambers.find(c => c.id === e.b)!;
    const halfWidth = sampleWidth(rng, params);
    // Walk centroid → partner-centroid in 1px steps; the last in-chamber
    // pixel is the boundary endpoint. If we never exit (degenerate
    // overlap), fall back to the centroid itself.
    const aStart = chamberBoundaryToward(a, b, chamberOf, gridSize, px2world);
    const bStart = chamberBoundaryToward(b, a, chamberOf, gridSize, px2world);
    const margin = halfWidth + 2;
    const waypoints = makeWaypoints(
      aStart, bStart, params.segments, params.curvature, margin, gridSize, rng,
    );
    corridors.push(carveSpline({
      waypoints,
      halfWidth,
      samplesPerSegment: params.bezierSamples,
      kind: "network",
      openMask,
      gridSize,
    }));
  }

  // ---- 6. Re-flood labels ------------------------------------------------
  const det = runRoomDetection({ openMask, gridSize, px2world });
  return { openMask, rooms: det.rooms, roomOf: det.roomOf, corridors };
}

function sampleWidth(rng: () => number, params: GenParams["network"]): number {
  const lo = Math.min(params.widthMin, params.widthMax);
  const hi = Math.max(params.widthMin, params.widthMax);
  if (lo === hi) return lo;
  return lo + Math.floor(rng() * (hi - lo + 1));
}

/**
 * Ray-march from chamber `from`'s centroid toward chamber `to`'s centroid
 * in 1px steps; return the last in-chamber pixel. This is where the
 * corridor leaves chamber `from` — using it as the bezier endpoint
 * means the carve enters/exits chamber walls instead of crossing
 * interiors.
 */
function chamberBoundaryToward(
  from: Room, to: Room,
  chamberOf: Uint16Array, gridSize: number, px2world: number,
): { x: number; y: number } {
  const fx = from.cx / px2world;
  const fy = from.cy / px2world;
  const tx = to.cx / px2world;
  const ty = to.cy / px2world;
  const dx = tx - fx;
  const dy = ty - fy;
  const len = Math.hypot(dx, dy);
  const steps = Math.max(1, Math.ceil(len));
  let lastInside = { x: fx, y: fy };
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const x = Math.round(fx + dx * t);
    const y = Math.round(fy + dy * t);
    if (x < 0 || x >= gridSize || y < 0 || y >= gridSize) break;
    if (chamberOf[y * gridSize + x] !== from.id) break;
    lastInside = { x, y };
  }
  return lastInside;
}


// ============================================================================
// Delaunay — incremental Bowyer–Watson.
// Returns triangles as triples of point indices into `pts`. O(n²) typical.
// ============================================================================

type Tri = [number, number, number];

function delaunay(pts: Array<{ x: number; y: number }>): Tri[] {
  const n = pts.length;
  if (n < 3) return [];

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
  const ext = pts.slice();
  ext.push({ x: midx - dmax, y: midy - dmax });
  ext.push({ x: midx + dmax, y: midy - dmax });
  ext.push({ x: midx,        y: midy + dmax });
  let triangles: Tri[] = [[n, n + 1, n + 2]];

  for (let pi = 0; pi < n; pi++) {
    const p = ext[pi];
    const bad: number[] = [];
    for (let ti = 0; ti < triangles.length; ti++) {
      if (inCircumcircle(p, ext[triangles[ti][0]], ext[triangles[ti][1]], ext[triangles[ti][2]])) {
        bad.push(ti);
      }
    }
    const edgeCount = new Map<string, number>();
    for (const ti of bad) {
      const t = triangles[ti];
      addEdge(edgeCount, t[0], t[1]);
      addEdge(edgeCount, t[1], t[2]);
      addEdge(edgeCount, t[2], t[0]);
    }
    for (let i = bad.length - 1; i >= 0; i--) triangles.splice(bad[i], 1);
    for (const [key, count] of edgeCount) {
      if (count !== 1) continue;
      const [a, b] = key.split(",").map(Number);
      triangles.push([a, b, pi]);
    }
  }

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
  union(a: number, b: number): boolean {
    const ra = this.find(a), rb = this.find(b);
    if (ra === rb) return false;
    if (this.rank[ra] < this.rank[rb])      this.parent[ra] = rb;
    else if (this.rank[ra] > this.rank[rb]) this.parent[rb] = ra;
    else { this.parent[rb] = ra; this.rank[ra]++; }
    return true;
  }
}

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
