/**
 * Stage 10 — AnnotatedZoneGraph (T-208).
 *
 * Partitions the tile's open space into zones, annotates each with
 * geometric and topological metadata, and classifies them into
 * canonical roles (plaza / pocket / deadend / corridor / crossroads /
 * lobby / arena). The Tier-6 POI generator (T-209) consumes this graph
 * to score and place POI candidates.
 *
 *   Zone segmentation: every open pixel belongs to either
 *     (a) its chamber id (chamberOf[i] !== ROOM_ID_NONE), or
 *     (b) a corridor segment — flood-fill of contiguous open pixels
 *         whose chamberOf is ROOM_ID_NONE. Two corridor pixels
 *         separated by a chamber count as different segments.
 *   Result: one zone per chamber + one zone per corridor segment.
 *
 *   Adjacency: two zones are neighbours iff there is an open-pixel pair
 *   in different zones that share a 4-connected edge.
 *
 *   Per-zone metrics:
 *     area, centroid, bbox, aspectRatio, enclosure, kindHistogram
 *
 *   Role assignment: rule-based, hard-threshold, declaration order
 *   (first match wins). All thresholds live in GenParams.zoneGraph.
 *
 * Deterministic by construction — no RNG used. The transformer takes
 * `seed` for signature uniformity but ignores it.
 */

import type { Transformer } from "@voxim/levelgen";
import type { ZoneRole } from "@voxim/content";
import type { GenParams } from "../../genparams.ts";
import { ROOM_ID_NONE } from "./room_detection.ts";
import { ZONE_ID_NONE, type AnnotatedZone, type AnnotatedZoneState, type MaterialsState } from "./state.ts";

export const zoneGraph: Transformer<MaterialsState, AnnotatedZoneState, GenParams["zoneGraph"]> =
  (state, _seed, params) => {
    const { openMask, chamberOf, kindOf, portals, gridSize } = state;
    const N = gridSize * gridSize;

    // ---- 1. Segment open pixels into zones ------------------------------
    const zoneOf = new Uint16Array(N).fill(ZONE_ID_NONE);

    // 1a. Every chamber id becomes its own zone. Chamber ids are dense
    //     starting at 0, so we copy them directly into the leading zone
    //     id space and remember the highest chamber id seen.
    let maxChamberId = -1;
    for (let i = 0; i < N; i++) {
      if (openMask[i] !== 1) continue;
      const cid = chamberOf[i];
      if (cid === ROOM_ID_NONE) continue;
      zoneOf[i] = cid;
      if (cid > maxChamberId) maxChamberId = cid;
    }
    // 1b. Corridor pixels: flood-fill connected components, starting
    //     zone ids at maxChamberId + 1.
    let nextZoneId = maxChamberId + 1;
    const stack: number[] = [];
    for (let seed = 0; seed < N; seed++) {
      if (openMask[seed] !== 1) continue;
      if (zoneOf[seed] !== ZONE_ID_NONE) continue;
      // BFS/DFS via a stack — recursion would blow at 512².
      const zid = nextZoneId++;
      zoneOf[seed] = zid;
      stack.push(seed);
      while (stack.length > 0) {
        const idx = stack.pop()!;
        const x = idx % gridSize;
        const y = (idx - x) / gridSize;
        if (x > 0)              tryFloodCorridor(idx - 1,        zid, zoneOf, openMask, chamberOf, stack);
        if (x < gridSize - 1)   tryFloodCorridor(idx + 1,        zid, zoneOf, openMask, chamberOf, stack);
        if (y > 0)              tryFloodCorridor(idx - gridSize, zid, zoneOf, openMask, chamberOf, stack);
        if (y < gridSize - 1)   tryFloodCorridor(idx + gridSize, zid, zoneOf, openMask, chamberOf, stack);
      }
    }

    // ---- 2. Allocate per-zone metric accumulators ----------------------
    // zones[zid] is left undefined for any zone id that wasn't touched
    // (chamber ids that exist in the table but had no open pixels left
    // after rivers, for example).
    const zoneCount = nextZoneId;
    const zonesRaw: Array<MutableZone | undefined> = new Array(zoneCount);

    // ---- 3. Walk every open pixel, accumulate area / centroid / bbox / kind hist
    // ---- 4. Walk neighbour edges to populate adjacency and enclosure
    const adjSet: Set<number>[] = new Array(zoneCount);
    const closedBoundary = new Uint32Array(zoneCount);
    const totalBoundary  = new Uint32Array(zoneCount);

    for (let idx = 0; idx < N; idx++) {
      if (openMask[idx] !== 1) continue;
      const zid = zoneOf[idx];
      let z = zonesRaw[zid];
      if (!z) {
        z = makeMutableZone(zid, zid <= maxChamberId);
        zonesRaw[zid] = z;
        adjSet[zid] = new Set<number>();
      }
      const x = idx % gridSize;
      const y = (idx - x) / gridSize;
      z.area++;
      z.sumX += x;
      z.sumY += y;
      if (x < z.bbox.minX) z.bbox.minX = x;
      if (x > z.bbox.maxX) z.bbox.maxX = x;
      if (y < z.bbox.minY) z.bbox.minY = y;
      if (y > z.bbox.maxY) z.bbox.maxY = y;

      // Walk 4 neighbours: closed neighbour → enclosure + kind hist;
      // open neighbour with different zid → adjacency.
      const neighbours = [
        x > 0              ? idx - 1        : -1,
        x < gridSize - 1   ? idx + 1        : -1,
        y > 0              ? idx - gridSize : -1,
        y < gridSize - 1   ? idx + gridSize : -1,
      ];
      for (const nb of neighbours) {
        if (nb < 0) continue;
        if (openMask[nb] === 0) {
          totalBoundary[zid]++;
          closedBoundary[zid]++;
          const k = kindOf[nb];
          z.kindHistogram[k] = (z.kindHistogram[k] ?? 0) + 1;
        } else {
          const otherZ = zoneOf[nb];
          if (otherZ !== zid) {
            totalBoundary[zid]++;
            adjSet[zid].add(otherZ);
          }
        }
      }
    }

    // ---- 5. Mark portal-touching zones as entries ---------------------
    for (const p of portals) {
      const idx = p.pixelY * gridSize + p.pixelX;
      const zid = zoneOf[idx];
      if (zid !== ZONE_ID_NONE && zonesRaw[zid]) {
        zonesRaw[zid]!.isEntry = true;
      }
    }

    // ---- 6. Finalize per-zone metrics + role assignment ---------------
    const zones: AnnotatedZone[] = [];
    for (let zid = 0; zid < zoneCount; zid++) {
      const z = zonesRaw[zid];
      if (!z) continue;
      const cx = z.sumX / z.area;
      const cy = z.sumY / z.area;
      const w  = z.bbox.maxX - z.bbox.minX + 1;
      const h  = z.bbox.maxY - z.bbox.minY + 1;
      const aspect = Math.min(w, h) / Math.max(w, h);
      const enclosure = totalBoundary[zid] === 0
        ? 0
        : closedBoundary[zid] / totalBoundary[zid];
      const neighbors = [...adjSet[zid]].sort((a, b) => a - b);
      const role = classifyRole(z.area, aspect, neighbors.length, params);

      zones.push({
        id: zid,
        area: z.area,
        centroid: { x: cx, y: cy },
        bbox: { ...z.bbox },
        aspectRatio: aspect,
        enclosure,
        topologyRole: role,
        kindHistogram: z.kindHistogram,
        neighbors,
        isEntry: z.isEntry,
        isCorridor: z.isCorridor,
      });
    }
    // Sort by id for deterministic JSON output.
    zones.sort((a, b) => a.id - b.id);

    return { ...state, zoneOf, zones };
  };

// ---- helpers ---------------------------------------------------------

interface MutableZone {
  id: number;
  area: number;
  sumX: number;
  sumY: number;
  bbox: { minX: number; minY: number; maxX: number; maxY: number };
  kindHistogram: Record<number, number>;
  isEntry: boolean;
  isCorridor: boolean;
}

function makeMutableZone(id: number, isCorridor: boolean): MutableZone {
  return {
    id,
    area: 0,
    sumX: 0,
    sumY: 0,
    bbox: { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity },
    kindHistogram: {},
    isEntry: false,
    isCorridor,
  };
}

function tryFloodCorridor(
  idx: number,
  zid: number,
  zoneOf: Uint16Array,
  openMask: Uint8Array,
  chamberOf: Uint16Array,
  stack: number[],
): void {
  if (openMask[idx] !== 1) return;
  if (zoneOf[idx] !== ZONE_ID_NONE) return;
  if (chamberOf[idx] !== ROOM_ID_NONE) return; // chamber pixel — already its own zone
  zoneOf[idx] = zid;
  stack.push(idx);
}

function classifyRole(
  area: number,
  aspectRatio: number,
  degree: number,
  p: GenParams["zoneGraph"],
): ZoneRole {
  if (area > p.arenaAreaMin) return "arena";
  if (degree >= 3 && aspectRatio > p.plazaAspectRatioMin && area > p.plazaAreaMin) return "plaza";
  if (degree >= 3 && area <= p.crossroadsAreaMax) return "crossroads";
  if (degree === 2 && area > p.lobbyAreaMin) return "lobby";
  if (degree === 2 && area <= p.corridorAreaMax && aspectRatio < p.corridorAspectRatioMax) return "corridor";
  if (degree === 1 && area > p.pocketAreaMin) return "pocket";
  // Fallback: small isolated regions, single-connection tails.
  return "deadend";
}
