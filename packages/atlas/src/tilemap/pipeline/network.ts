/**
 * Stage 3 — interwoven path network.
 *
 * Plans corridors over the junction graph:
 *
 *   1. Delaunay triangulation over junction positions → candidate edges.
 *   2. Drop edges longer than `params.maxEdgeLength`.
 *   3. Kruskal MST → guaranteed connectivity (every junction reachable).
 *   4. Braid: keep `params.loopRate` of the non-tree edges as loops.
 *   5. For each kept edge, generate `segments + 1` waypoints between the
 *      two junction positions with sin-tapered perpendicular perturbation,
 *      clipped to a tile-interior margin. Carve as a Catmull-Rom spline
 *      with a brush whose half-width is sampled per edge from
 *      `[widthMin, widthMax]`.
 *   6. Recursive branch-paths off each main corridor (see `spawnBranches`).
 *
 * Allocates the tile's `openMask` (default fully-closed) since this is the
 * first stage that needs one, then mutates it through every carve.
 *
 * Returns `degrees[]` — one entry per junction, count of chosen edges
 * incident on that junction. The rooms stage uses it to decide which
 * junctions get rooms.
 */

import type { Transformer } from "@voxim/levelgen";
import { carveSpline, makeWaypoints, samplePoint, sampleTangent } from "./bezier_carve.ts";
import type { Corridor } from "../types.ts";
import type { GenParams } from "../../genparams.ts";
import type { JunctionsState, NetworkState } from "./state.ts";

const NETWORK_SUB_SEED = 0x4e570001;

export const network: Transformer<JunctionsState, NetworkState, GenParams["network"]> =
  (state, seed, params) => {
    const { seeds, gridSize } = state;
    const openMask = new Uint8Array(gridSize * gridSize);

    // 0–1 junctions → no edges to carve.
    if (seeds.length < 2) {
      return { ...state, openMask, corridors: [], degrees: new Uint8Array(seeds.length) };
    }

    // ---- 1. Delaunay over junction positions ---------------------------------
    const pts: Array<{ x: number; y: number }> = seeds.map(s => ({ x: s.x, y: s.y }));
    const tris = delaunay(pts);

    // ---- 2. Edges (deduped, length-capped) -----------------------------------
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

    // ---- 3. MST + 4. Braid ---------------------------------------------------
    const uf = new UnionFind(pts.length);
    const tree:   Edge[] = [];
    const extras: Edge[] = [];
    for (const e of edges) {
      if (uf.union(e.a, e.b)) tree.push(e);
      else extras.push(e);
    }
    const rng = mulberry32(seed ^ NETWORK_SUB_SEED);
    const braids: Edge[] = [];
    for (const e of extras) {
      if (rng() < params.loopRate) braids.push(e);
    }

    // ---- 5. Carve segmented spline + accumulate degrees ----------------------
    const corridors: Corridor[] = [];
    const degrees   = new Uint8Array(seeds.length);
    const chosen = tree.concat(braids);
    for (const e of chosen) {
      const a = pts[e.a];
      const b = pts[e.b];
      degrees[e.a]++;
      degrees[e.b]++;
      const halfWidth = sampleWidth(rng, params);
      const margin = halfWidth + 2;
      const waypoints = makeWaypoints(
        a, b, params.segments, params.curvature, margin, gridSize, rng,
      );
      const corridor = carveSpline({
        waypoints,
        halfWidth,
        samplesPerSegment: params.bezierSamples,
        kind: "network",
        openMask,
        gridSize,
      });
      corridors.push(corridor);
      // ---- 6. Recursive branch-paths off this corridor -----------------------
      const parentLen = Math.hypot(b.x - a.x, b.y - a.y);
      spawnBranches(corridor, parentLen, 0, params, gridSize, openMask, rng, corridors);
    }

    return { ...state, openMask, corridors, degrees };
  };

function sampleWidth(rng: () => number, params: GenParams["network"]): number {
  const lo = Math.min(params.widthMin, params.widthMax);
  const hi = Math.max(params.widthMin, params.widthMax);
  if (lo === hi) return lo;
  return lo + Math.floor(rng() * (hi - lo + 1));
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

/**
 * Recursive branch-paths pass. With probability `branchRate`, picks a
 * random t ∈ [0.2, 0.8] along the parent corridor's spline, takes the
 * local tangent + perpendicular, and carves a new spline that veers off
 * into the wall space. Branches recurse up to `branchMaxDepth` levels,
 * shrinking by `branchLengthFraction` each level. Branches that
 * coincidentally hit other corridors / chambers form natural junctions;
 * ones that don't form dead-end paths.
 *
 * Mutates `openMask` and appends every carved branch to `out`.
 */
function spawnBranches(
  parent: Corridor,
  parentLen: number,
  depth: number,
  params: GenParams["network"],
  gridSize: number,
  openMask: Uint8Array,
  rng: () => number,
  out: Corridor[],
): void {
  if (depth >= params.branchMaxDepth) return;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (rng() >= params.branchRate) continue;
    const t = 0.2 + rng() * 0.6;
    const start = samplePoint(parent.waypoints, t);
    const tang  = sampleTangent(parent.waypoints, t);
    let nx = -tang.y;
    let ny =  tang.x;
    if (rng() < 0.5) { nx = -nx; ny = -ny; }
    const angleJitter = (rng() - 0.5) * Math.PI * 0.5;
    const cos = Math.cos(angleJitter), sin = Math.sin(angleJitter);
    const dirX = nx * cos - ny * sin;
    const dirY = nx * sin + ny * cos;
    const branchLen = parentLen * params.branchLengthFraction * (0.7 + rng() * 0.6);
    const halfWidth = sampleWidth(rng, params);
    const margin = halfWidth + 2;
    const endX = clamp(start.x + dirX * branchLen, margin, gridSize - 1 - margin);
    const endY = clamp(start.y + dirY * branchLen, margin, gridSize - 1 - margin);
    const waypoints = makeWaypoints(
      start, { x: endX, y: endY },
      params.segments, params.curvature, margin, gridSize, rng,
    );
    const branch = carveSpline({
      waypoints,
      halfWidth,
      samplesPerSegment: params.bezierSamples,
      kind: "network",
      openMask,
      gridSize,
    });
    out.push(branch);
    const branchActualLen = Math.hypot(endX - start.x, endY - start.y);
    spawnBranches(branch, branchActualLen, depth + 1, params, gridSize, openMask, rng, out);
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
