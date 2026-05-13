/**
 * Stage 10 — AnnotatedZoneGraph (T-208 + T-210).
 *
 * Partitions the tile's entire surface into **zones across two
 * traversal classes**:
 *
 *   PATH ZONES — open pixels (openMask = 1). Chambers + corridor
 *     segments. Default-walkable; this is the connective tissue of
 *     the tile.
 *
 *   WILDERNESS ZONES — closed-pixel blobs (openMask = 0) of a
 *     wilderness-eligible kind (STONE / FOREST / GRASS_MOUND).
 *     Elevated plateaus reachable only via stairs (T-210). The
 *     dominant boundary kind in the blob picks the topology role
 *     (crag / grove / thicket / hollow / outcrop). Water blobs
 *     stay outside the zone graph for v1 — no bridge mechanic yet.
 *
 *   Adjacency:
 *     path↔path        — direct open-pixel-to-open-pixel
 *     path↔wilderness  — open-pixel-to-closed-pixel boundary
 *     wilderness↔wild  — never (always separated by path)
 *
 *   Per-zone metrics:
 *     area, centroid, bbox, aspectRatio, enclosure, kindHistogram
 *
 *   Role assignment: rule-based per class. Path roles by topology
 *   (degree, area, aspect); wilderness roles by dominant kind + area.
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

export const zoneGraph: Transformer<MaterialsState, AnnotatedZoneState, GenParams["zoneGraph"]> =
  (state, seed, params) => {
    const { openMask, chamberOf, kindOf, portals, gridSize } = state;
    const biome = state.worldCell.biome;
    const N = gridSize * gridSize;

    // ---- 1. Segment open pixels into PATH zones ------------------------
    // Chamber ids occupy the leading zone-id range; corridor flood-fill
    // continues from there.
    const zoneOf = new Uint16Array(N).fill(ZONE_ID_NONE);
    const traversalOf: ("path" | "wilderness")[] = [];

    let maxChamberId = -1;
    for (let i = 0; i < N; i++) {
      if (openMask[i] !== 1) continue;
      const cid = chamberOf[i];
      if (cid === ROOM_ID_NONE) continue;
      zoneOf[i] = cid;
      if (cid > maxChamberId) maxChamberId = cid;
    }
    for (let z = 0; z <= maxChamberId; z++) traversalOf[z] = "path";

    // Corridor flood-fill (open pixels with no chamber tag).
    let nextZoneId = maxChamberId + 1;
    const stack: number[] = [];
    for (let seed = 0; seed < N; seed++) {
      if (openMask[seed] !== 1) continue;
      if (zoneOf[seed] !== ZONE_ID_NONE) continue;
      const zid = nextZoneId++;
      traversalOf[zid] = "path";
      zoneOf[seed] = zid;
      stack.push(seed);
      while (stack.length > 0) {
        const idx = stack.pop()!;
        const x = idx % gridSize;
        const y = (idx - x) / gridSize;
        if (x > 0)            floodPath(idx - 1,        zid, zoneOf, openMask, chamberOf, stack);
        if (x < gridSize - 1) floodPath(idx + 1,        zid, zoneOf, openMask, chamberOf, stack);
        if (y > 0)            floodPath(idx - gridSize, zid, zoneOf, openMask, chamberOf, stack);
        if (y < gridSize - 1) floodPath(idx + gridSize, zid, zoneOf, openMask, chamberOf, stack);
      }
    }

    // ---- 2. Segment closed pixels into WILDERNESS zones (T-210) -------
    // Only WILDERNESS_KINDS (stone / forest / grass mound) participate.
    // Water and any other closed-kind stay zone-less so the matcher
    // doesn't try to put POIs into rivers.
    for (let seed = 0; seed < N; seed++) {
      if (openMask[seed] !== 0) continue;
      if (zoneOf[seed] !== ZONE_ID_NONE) continue;
      if (!WILDERNESS_KINDS.has(kindOf[seed])) continue;

      const zid = nextZoneId++;
      traversalOf[zid] = "wilderness";
      zoneOf[seed] = zid;
      stack.push(seed);
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

    // ---- 3. Allocate per-zone metric accumulators ---------------------
    const zoneCount = nextZoneId;
    const zonesRaw: Array<MutableZone | undefined> = new Array(zoneCount);
    const adjSet: Set<number>[] = new Array(zoneCount);
    const oppositeBoundary = new Uint32Array(zoneCount);
    const totalBoundary    = new Uint32Array(zoneCount);

    // ---- 4. Walk every zoned pixel; accumulate area, centroid, bbox,
    //         adjacency, enclosure, kind histogram.
    //
    // For path zones: kindHistogram counts neighbouring closed-pixel
    // kinds (what's around me). enclosure = closed-neighbour fraction.
    //
    // For wilderness zones: kindHistogram counts the zone's own pixels'
    // kindOf (what am I made of). enclosure = open-neighbour fraction
    // (how exposed my edges are to paths).
    for (let idx = 0; idx < N; idx++) {
      const zid = zoneOf[idx];
      if (zid === ZONE_ID_NONE) continue;

      const traversal = traversalOf[zid];
      let z = zonesRaw[zid];
      if (!z) {
        z = makeMutableZone(zid, traversal);
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

      // Wilderness zones histogram themselves.
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
        // Path zones histogram their neighbouring closed pixels.
        if (traversal === "path" && openMask[nb] === 0) {
          const k = kindOf[nb];
          z.kindHistogram[k] = (z.kindHistogram[k] ?? 0) + 1;
        }
      }
    }

    // ---- 5. Portal-touching zones are entries (paths only). -----------
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
        : oppositeBoundary[zid] / totalBoundary[zid];
      const neighbors = [...adjSet[zid]].sort((a, b) => a - b);
      const role = z.traversal === "path"
        ? classifyPathRole(z.area, aspect, neighbors.length, params)
        : classifyWildernessRole(z.area, z.kindHistogram);

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
        isCorridor: z.traversal === "path" && !z.startedAsChamber,
        traversal: z.traversal,
        name: nameZone(seed, zid, z.area, role, z.traversal, biome),
      });
    }
    zones.sort((a, b) => a.id - b.id);

    return { ...state, zoneOf, zones };
  };

// ---- flood helpers ---------------------------------------------------

function floodPath(
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
  if (!WILDERNESS_KINDS.has(kindOf[idx])) return; // water / OPEN stop the flood
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
  /** chamber-derived path zone? (drives `isCorridor` finalization) */
  startedAsChamber: boolean;
}

function makeMutableZone(id: number, traversal: "path" | "wilderness"): MutableZone {
  return {
    id,
    area: 0,
    sumX: 0,
    sumY: 0,
    bbox: { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity },
    kindHistogram: {},
    isEntry: false,
    traversal,
    startedAsChamber: false,
  };
}

// ---- role classifiers ------------------------------------------------

function classifyPathRole(
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
 * Wilderness zones are picked by their dominant pixel kind.
 * Tie-breaking: stone wins over forest wins over grass-mound — only
 * matters when a blob straddles kind boundaries (rare given how
 * boundary_kinds.ts paints them).
 */
function classifyWildernessRole(area: number, hist: Record<number, number>): ZoneRole {
  const stone   = hist[BOUNDARY_KIND_STONE]       ?? 0;
  const forest  = hist[BOUNDARY_KIND_FOREST]      ?? 0;
  const grass   = hist[BOUNDARY_KIND_GRASS_MOUND] ?? 0;
  const total   = stone + forest + grass;
  if (total === 0) return "outcrop"; // fallback for empty histograms
  const dominant = stone >= forest && stone >= grass ? "stone"
                 : forest >= grass ? "forest"
                 : "grass";
  if (dominant === "stone")  return "crag";
  if (dominant === "forest") return area > 500 ? "grove"  : "thicket";
  return                          area > 300 ? "hollow" : "outcrop";
}

// (used to suppress an unused-var warning until terrain modulation lands)
void BOUNDARY_KIND_OPEN;
void BOUNDARY_KIND_WATER;
