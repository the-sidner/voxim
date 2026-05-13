/**
 * Stage 10 — AnnotatedZoneGraph (T-208 + T-210 + sector refactor).
 *
 * Partitions every pixel of the tile into exactly one **sector**:
 *
 *   PATH SECTORS (traversal: "path") — the connective tissue.
 *     · CHAMBERS — `chamberOf`-tagged open pixels (rooms grown by
 *       the rooms stage). One sector per chamber id.
 *     · CROSSROADS — small disks painted around every network
 *       junction of degree ≥ 3, over corridor pixels (junctions
 *       inside chambers don't carve — the chamber wins).
 *     · CORRIDOR SEGMENTS — remaining open pixels, flood-filled.
 *       Naturally split at the crossroads disks, so a corridor
 *       passing through three junctions becomes four segments.
 *
 *   WILDERNESS SECTORS (traversal: "wilderness") — closed-pixel
 *     blobs of a wilderness-eligible kind (STONE / FOREST /
 *     GRASS_MOUND). Reached only via stairs (T-210).
 *
 *   Every pixel maps to exactly one sector id — `zoneOf` is total
 *   over open + wilderness-closed pixels. Water blobs and OPEN-kind
 *   sentinels stay un-zoned (0xFFFF).
 *
 * Sectors are the working unit for everything downstream: the POI
 * matcher (T-209), stair placement (T-210), zone naming (T-211),
 * runtime POI triggers (T-212). No system below this stage thinks
 * in pixels — it walks the sector graph.
 *
 * Role assignment per sector class:
 *   chamber zone   → existing rules (plaza/lobby/pocket/arena/...)
 *                    based on degree + area + aspect
 *   crossroads zone→ always "crossroads" by construction
 *   corridor seg.  → "corridor" if degree ≥ 2, "deadend" otherwise,
 *                    "pocket" if it's a bulky degree-1 nub
 *   wilderness     → by dominant boundary kind + area
 *
 * Deterministic by construction — no RNG used.
 */

import type { Transformer } from "@voxim/levelgen";
import type { ZoneRole } from "@voxim/content";
import type { GenParams } from "../../genparams.ts";
import { ROOM_ID_NONE } from "./room_detection.ts";
import {
  BOUNDARY_KIND_OPEN, BOUNDARY_KIND_STONE,
  BOUNDARY_KIND_FOREST, BOUNDARY_KIND_GRASS_MOUND, BOUNDARY_KIND_WATER,
} from "./boundary_kinds.ts";
import {
  ZONE_ID_NONE, type AnnotatedZone, type AnnotatedZoneState, type MaterialsState,
} from "./state.ts";
import { nameZone } from "./zone_namer.ts";

/** Kinds that segment into wilderness zones. Water deliberately excluded. */
const WILDERNESS_KINDS = new Set<number>([
  BOUNDARY_KIND_STONE, BOUNDARY_KIND_FOREST, BOUNDARY_KIND_GRASS_MOUND,
]);

/**
 * Disk radius (atlas pixels) used to carve a crossroads sector around
 * each network junction of qualifying degree. Tuned so 3-way + 4-way
 * intersections produce a visible, named "place" rather than getting
 * absorbed into the surrounding corridor.
 */
const CROSSROADS_DISK_RADIUS = 3;
const CROSSROADS_DEGREE_MIN  = 3;

export const zoneGraph: Transformer<MaterialsState, AnnotatedZoneState, GenParams["zoneGraph"]> =
  (state, _stageSeed, params) => {
    const { openMask, chamberOf, kindOf, portals, gridSize } = state;
    const biome = state.worldCell.biome;
    const N = gridSize * gridSize;

    const zoneOf = new Uint16Array(N).fill(ZONE_ID_NONE);
    const traversalOf: ("path" | "wilderness")[] = [];
    // Tracks sector-construction-type so the role classifier can
    // override defaults (crossroads-by-construction must be
    // "crossroads" regardless of geometric measure).
    const carvedAsCrossroads = new Set<number>();
    const carvedAsCorridor   = new Set<number>();

    // ---- 1. CHAMBER SECTORS — chamberOf-tagged open pixels ------------
    let maxChamberId = -1;
    for (let i = 0; i < N; i++) {
      if (openMask[i] !== 1) continue;
      const cid = chamberOf[i];
      if (cid === ROOM_ID_NONE) continue;
      zoneOf[i] = cid;
      if (cid > maxChamberId) maxChamberId = cid;
    }
    for (let z = 0; z <= maxChamberId; z++) traversalOf[z] = "path";

    let nextZoneId = maxChamberId + 1;
    const stack: number[] = [];

    // ---- 2. CROSSROADS SECTORS — disks around high-degree junctions ---
    //         Painted BEFORE corridor flood so corridors naturally
    //         split at the disks. Junctions inside chambers don't
    //         carve — chamber sector wins.
    if (state.seeds && state.degrees) {
      for (let i = 0; i < state.seeds.length; i++) {
        if (state.degrees[i] < CROSSROADS_DEGREE_MIN) continue;
        const j = state.seeds[i];
        const jx = j.x | 0;
        const jy = j.y | 0;
        if (jx < 0 || jy < 0 || jx >= gridSize || jy >= gridSize) continue;
        const jIdx = jy * gridSize + jx;
        // Only carve if the junction pixel itself lies on a corridor
        // (open AND not a chamber AND not already a sector).
        if (openMask[jIdx] !== 1) continue;
        if (chamberOf[jIdx] !== ROOM_ID_NONE) continue;
        if (zoneOf[jIdx] !== ZONE_ID_NONE) continue;

        const zid = nextZoneId++;
        traversalOf[zid] = "path";
        carvedAsCrossroads.add(zid);
        const R = CROSSROADS_DISK_RADIUS;
        const R2 = R * R;
        for (let dy = -R; dy <= R; dy++) {
          const ny = jy + dy;
          if (ny < 0 || ny >= gridSize) continue;
          for (let dx = -R; dx <= R; dx++) {
            if (dx * dx + dy * dy > R2) continue;
            const nx = jx + dx;
            if (nx < 0 || nx >= gridSize) continue;
            const idx = ny * gridSize + nx;
            // Only repaint corridor pixels — chambers keep their tag,
            // and already-assigned pixels (e.g. another junction's
            // disk if junctions cluster) keep their first owner.
            if (openMask[idx] !== 1) continue;
            if (chamberOf[idx] !== ROOM_ID_NONE) continue;
            if (zoneOf[idx] !== ZONE_ID_NONE) continue;
            zoneOf[idx] = zid;
          }
        }
      }
    }

    // ---- 3. CORRIDOR SEGMENTS — remaining open pixels -----------------
    //         Bounded by chambers + crossroads disks, so each chain
    //         between junctions becomes its own sector.
    for (let pixelIdx = 0; pixelIdx < N; pixelIdx++) {
      if (openMask[pixelIdx] !== 1) continue;
      if (zoneOf[pixelIdx] !== ZONE_ID_NONE) continue;
      const zid = nextZoneId++;
      traversalOf[zid] = "path";
      carvedAsCorridor.add(zid);
      zoneOf[pixelIdx] = zid;
      stack.push(pixelIdx);
      while (stack.length > 0) {
        const idx = stack.pop()!;
        const x = idx % gridSize;
        const y = (idx - x) / gridSize;
        if (x > 0)            floodCorridor(idx - 1,        zid, zoneOf, openMask, chamberOf, stack);
        if (x < gridSize - 1) floodCorridor(idx + 1,        zid, zoneOf, openMask, chamberOf, stack);
        if (y > 0)            floodCorridor(idx - gridSize, zid, zoneOf, openMask, chamberOf, stack);
        if (y < gridSize - 1) floodCorridor(idx + gridSize, zid, zoneOf, openMask, chamberOf, stack);
      }
    }

    // ---- 4. WILDERNESS SECTORS — closed-pixel blobs -------------------
    for (let pixelIdx = 0; pixelIdx < N; pixelIdx++) {
      if (openMask[pixelIdx] !== 0) continue;
      if (zoneOf[pixelIdx] !== ZONE_ID_NONE) continue;
      if (!WILDERNESS_KINDS.has(kindOf[pixelIdx])) continue;
      const zid = nextZoneId++;
      traversalOf[zid] = "wilderness";
      zoneOf[pixelIdx] = zid;
      stack.push(pixelIdx);
      while (stack.length > 0) {
        const idx = stack.pop()!;
        const x = idx % gridSize;
        const y = (idx - x) / gridSize;
        if (x > 0)            floodWilderness(idx - 1,        zid, zoneOf, openMask, kindOf, stack);
        if (x < gridSize - 1) floodWilderness(idx + 1,        zid, zoneOf, openMask, kindOf, stack);
        if (y > 0)            floodWilderness(idx - gridSize, zid, zoneOf, openMask, kindOf, stack);
        if (y < gridSize - 1) floodWilderness(idx + gridSize, zid, zoneOf, openMask, kindOf, stack);
      }
    }

    // ---- 5. Allocate per-sector accumulators --------------------------
    const zoneCount = nextZoneId;
    const zonesRaw: Array<MutableZone | undefined> = new Array(zoneCount);
    const adjSet: Set<number>[] = new Array(zoneCount);
    const oppositeBoundary = new Uint32Array(zoneCount);
    const totalBoundary    = new Uint32Array(zoneCount);

    // ---- 6. Walk pixels, accumulate metrics + adjacency ---------------
    for (let idx = 0; idx < N; idx++) {
      const zid = zoneOf[idx];
      if (zid === ZONE_ID_NONE) continue;

      const traversal = traversalOf[zid];
      let z = zonesRaw[zid];
      if (!z) {
        z = makeMutableZone(zid, traversal, carvedAsCorridor.has(zid));
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

      if (traversal === "wilderness") {
        const k = kindOf[idx];
        z.kindHistogram[k] = (z.kindHistogram[k] ?? 0) + 1;
      }

      const neighbours = [
        x > 0              ? idx - 1        : -1,
        x < gridSize - 1   ? idx + 1        : -1,
        y > 0              ? idx - gridSize : -1,
        y < gridSize - 1   ? idx + gridSize : -1,
      ];
      for (const nb of neighbours) {
        if (nb < 0) continue;
        const otherZ = zoneOf[nb];
        const opposite = (traversal === "path" && openMask[nb] === 0) ||
                         (traversal === "wilderness" && openMask[nb] === 1);
        totalBoundary[zid]++;
        if (opposite) oppositeBoundary[zid]++;
        if (otherZ !== ZONE_ID_NONE && otherZ !== zid) {
          adjSet[zid].add(otherZ);
        }
        if (traversal === "path" && openMask[nb] === 0) {
          const k = kindOf[nb];
          z.kindHistogram[k] = (z.kindHistogram[k] ?? 0) + 1;
        }
      }
    }

    // ---- 7. Portal-touching zones = entries ---------------------------
    for (const p of portals) {
      const idx = p.pixelY * gridSize + p.pixelX;
      const zid = zoneOf[idx];
      if (zid !== ZONE_ID_NONE && zonesRaw[zid]) {
        zonesRaw[zid]!.isEntry = true;
      }
    }

    // ---- 8. Role assignment + final emit ------------------------------
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
        : oppositeBoundary[zid] / totalBoundary[zid];
      const neighbors = [...adjSet[zid]].sort((a, b) => a - b);

      let role: ZoneRole;
      if (z.traversal === "wilderness") {
        role = classifyWildernessRole(z.area, z.kindHistogram);
      } else if (carvedAsCrossroads.has(zid)) {
        role = "crossroads";
      } else if (z.startedAsCorridor) {
        role = classifyCorridorRole(z.area, aspect, neighbors.length, params);
      } else {
        // Chamber-derived: existing degree+area+aspect rules.
        role = classifyChamberRole(z.area, aspect, neighbors.length, params);
      }

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
        isCorridor: z.startedAsCorridor,
        traversal: z.traversal,
        name: nameZone(_stageSeed, zid, z.area, role, z.traversal, biome),
      });
    }
    zones.sort((a, b) => a.id - b.id);

    return { ...state, zoneOf, zones };
  };

// ---- flood helpers ---------------------------------------------------

function floodCorridor(
  idx: number,
  zid: number,
  zoneOf: Uint16Array,
  openMask: Uint8Array,
  chamberOf: Uint16Array,
  stack: number[],
): void {
  if (openMask[idx] !== 1) return;
  if (zoneOf[idx] !== ZONE_ID_NONE) return;
  if (chamberOf[idx] !== ROOM_ID_NONE) return;
  zoneOf[idx] = zid;
  stack.push(idx);
}

function floodWilderness(
  idx: number,
  zid: number,
  zoneOf: Uint16Array,
  openMask: Uint8Array,
  kindOf: Uint16Array,
  stack: number[],
): void {
  if (openMask[idx] !== 0) return;
  if (zoneOf[idx] !== ZONE_ID_NONE) return;
  if (!WILDERNESS_KINDS.has(kindOf[idx])) return;
  zoneOf[idx] = zid;
  stack.push(idx);
}

// ---- mutable accumulator ---------------------------------------------

interface MutableZone {
  id: number;
  area: number;
  sumX: number;
  sumY: number;
  bbox: { minX: number; minY: number; maxX: number; maxY: number };
  kindHistogram: Record<number, number>;
  isEntry: boolean;
  traversal: "path" | "wilderness";
  /** True for corridor-flood sectors; false for chambers + crossroads + wilderness. */
  startedAsCorridor: boolean;
}

function makeMutableZone(id: number, traversal: "path" | "wilderness", startedAsCorridor: boolean): MutableZone {
  return {
    id,
    area: 0,
    sumX: 0,
    sumY: 0,
    bbox: { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity },
    kindHistogram: {},
    isEntry: false,
    traversal,
    startedAsCorridor,
  };
}

// ---- role classifiers ------------------------------------------------

/**
 * Chamber-derived path zones (the noise-flooded room blobs). Existing
 * geometric rules — these sectors have variable shapes and the degree
 * + area + aspect heuristic still picks the player-readable role.
 */
function classifyChamberRole(
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
  return "deadend";
}

/**
 * Corridor-flood sectors are by construction the chains between
 * junctions / chambers. Their degree tells us almost everything:
 *
 *   degree ≥ 2 — through-corridor between sectors. Role: "corridor".
 *                Lobby override when the segment is unusually wide
 *                (a "lobby" mid-section between two crossroads).
 *   degree = 1 — terminus. "pocket" if substantial, "deadend" otherwise.
 *   degree = 0 — isolated bubble (shouldn't happen but defend).
 */
function classifyCorridorRole(
  area: number,
  _aspect: number,
  degree: number,
  p: GenParams["zoneGraph"],
): ZoneRole {
  // Arena threshold applies regardless of derivation — a 60K-area
  // path sector is an arena whether the rooms stage flagged it as a
  // chamber or not (open_plains tiles have mostly corridor-derived
  // big spaces because their roomChanceBase is low).
  if (area > p.arenaAreaMin) return "arena";
  if (degree === 0) return "deadend";
  if (degree === 1) return area > p.pocketAreaMin ? "pocket" : "deadend";
  if (area > p.lobbyAreaMin) return "lobby";
  return "corridor";
}

/**
 * Wilderness zones are picked by their dominant pixel kind.
 * Tie-breaking: stone > forest > grass.
 */
function classifyWildernessRole(area: number, hist: Record<number, number>): ZoneRole {
  const stone   = hist[BOUNDARY_KIND_STONE]       ?? 0;
  const forest  = hist[BOUNDARY_KIND_FOREST]      ?? 0;
  const grass   = hist[BOUNDARY_KIND_GRASS_MOUND] ?? 0;
  const total   = stone + forest + grass;
  if (total === 0) return "outcrop";
  const dominant = stone >= forest && stone >= grass ? "stone"
                 : forest >= grass ? "forest"
                 : "grass";
  if (dominant === "stone")  return "crag";
  if (dominant === "forest") return area > 500 ? "grove"  : "thicket";
  return                          area > 300 ? "hollow" : "outcrop";
}

// (suppress unused-var warnings for kind ids referenced only in type checks)
void BOUNDARY_KIND_OPEN;
void BOUNDARY_KIND_WATER;
