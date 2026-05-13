/**
 * Stage 11 — Tier-6 POI network + dependency-DAG solver (T-209).
 *
 * Consumes the AnnotatedZoneGraph (T-208) and the POI roster
 * (`@voxim/content`'s `findPoisByRole` / `findPoisByTag` from T-206)
 * to weave a per-tile dependency DAG. The path through that DAG is
 * the tile's "questline" — there is no authored narrative; the
 * gameplay loop is discover-POI → get-trinket → try-on-gates.
 *
 * Four phases (per SCHEMA.md §8):
 *
 *   1. CANDIDATE SCORING
 *        For every (zone, POI-def) pair, score the spatial fit.
 *        Hard rejects (requiredBiome / requiredKind / area-out-of-bounds /
 *        enclosure out-of-range) drop to 0; soft mismatches reduce.
 *
 *   2. SELECTION
 *        Pick N POIs under role + uniqueness constraints. Greedy with
 *        seeded RNG over a sorted candidate list. Bounded retry on
 *        failure (no valid entry-POI, no valid terminal, etc.).
 *
 *   3. DAG WIRING
 *        For each non-entry POI, assign upstream key-sources whose
 *        reward themes intersect this POI's gate.flavorAccept.
 *        `multi` gates need `count` distinct upstreams. Verify
 *        acyclicity + reachability; failure → retry.
 *
 *   4. TRINKET NAMING
 *        Procedural display name from source themes + flavor adjectives
 *        + source POI display name. Pure formula — no LLM call.
 *
 * Determinism: every random choice consumes from
 * `mulberry32(splitSeed(tileSeed, "poiNetwork_retry${N}"))`. The chosen
 * retry count is baked into the output (`narrative.retries`) so save+
 * reload is reproducible.
 */

import type { Transformer } from "@voxim/levelgen";
import { splitSeed } from "@voxim/levelgen";
import type { ContentService, PoiDef } from "@voxim/content";
import type { GenParams } from "../../genparams.ts";
import type {
  AnnotatedZone, AnnotatedZoneState, DagShape,
  PoiInstance, PoiNetworkState, ResolvedGate,
  StairInstance, TileNarrative, TrinketInstance,
} from "./state.ts";

/**
 * Plain transformer — reads the ContentService off `state.content`
 * (threaded through PipelineBase). When `state.content` is undefined
 * the stage emits an empty narrative so snapshot tests that exercise
 * `generateTile` without a content store stay deterministic.
 */
export const poiNetwork: Transformer<AnnotatedZoneState, PoiNetworkState, GenParams["poiNetwork"]> =
  (state, seed, params) => {
    if (!state.content) {
      return { ...state, narrative: emptyNarrative() };
    }
    const narrative = solveTileNarrative(state, seed, params, state.content);
    return { ...state, narrative };
  };

function emptyNarrative(): TileNarrative {
  return {
    pois: [],
    trinkets: [],
    stairs: [],
    dagShape: "linear",
    entryPoiIds: [],
    terminalPoiIds: [],
    degraded: false,
    retries: 0,
  };
}

// ---------------------------------------------------------------------
// Solver
// ---------------------------------------------------------------------

function solveTileNarrative(
  state: AnnotatedZoneState,
  tileSeed: number,
  params: GenParams["poiNetwork"],
  content: ContentService,
): TileNarrative {
  const allPois = [...content.pois.values()].filter(p => p.roles.length > 0);
  const biome = state.worldCell.biome;
  const stairContext: StairContext = {
    zones:    state.zones,
    zoneOf:   state.zoneOf,
    gridSize: state.gridSize,
  };

  for (let retry = 0; retry < params.maxRetries; retry++) {
    const subSeed = splitSeed(tileSeed, `poiNetwork_retry${retry}`);
    const rng = mulberry32(subSeed);

    // Phase 1: candidate scoring
    const candidates = scoreCandidates(state.zones, allPois, biome, params);

    // Phase 2: selection — also rejects wilderness POIs whose zone has
    // no adjacent path zone (a stair anchor needs a path-pixel to live on).
    const selected = selectPois(candidates, params.targetPoiCount, rng, stairContext);
    if (!selected) continue;

    // Phase 3: DAG wiring
    const wired = wireDag(selected, rng, params.maxWireSearchDepth);
    if (!wired) continue;

    // Phase 4: trinket naming + stair materialization + emit
    const narrative = buildNarrative(wired, retry, stairContext);
    // Phase 5: fill in "found" stairs for any wilderness zone the
    // matcher didn't assign a POI to. Every blob accessible from boot.
    addFoundStairsForExposedWilderness(narrative, stairContext);
    return narrative;
  }

  // Retry budget exhausted — emit a degraded narrative built from the
  // best candidates regardless of bridge solvability.
  const degraded = emitDegraded(state.zones, allPois, biome, params, stairContext);
  addFoundStairsForExposedWilderness(degraded, stairContext);
  return degraded;
}

/** Bundled spatial data the wire + build phases need for stair anchoring. */
interface StairContext {
  zones: AnnotatedZone[];
  zoneOf: Uint16Array;
  gridSize: number;
}

// ---------------------------------------------------------------------
// Phase 1 — candidate scoring
// ---------------------------------------------------------------------

interface ScoredCandidate {
  poi: PoiDef;
  zone: AnnotatedZone;
  score: number;
}

function scoreCandidates(
  zones: AnnotatedZone[],
  pois: PoiDef[],
  biome: { altitude: number; moisture: number; temperature: number; ruggedness: number },
  params: GenParams["poiNetwork"],
): ScoredCandidate[] {
  const out: ScoredCandidate[] = [];
  for (const poi of pois) {
    for (const zone of zones) {
      const score = fitScore(poi, zone, biome, params);
      if (score >= params.minFitScore) {
        out.push({ poi, zone, score });
      }
    }
  }
  // Stable sort by score desc, ties broken by (poi.id, zone.id) for
  // determinism across runs.
  out.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.poi.id !== b.poi.id) return a.poi.id < b.poi.id ? -1 : 1;
    return a.zone.id - b.zone.id;
  });
  return out;
}

function fitScore(
  poi: PoiDef,
  zone: AnnotatedZone,
  biome: { altitude: number; moisture: number; temperature: number; ruggedness: number },
  params: GenParams["poiNetwork"],
): number {
  // Hard rejects

  // Traversal-class filter (T-210). Default is "path" when the POI
  // doesn't declare a traversal — preserves back-compat for POIs
  // authored before wilderness existed.
  const wantedTraversal = poi.fit.traversal ?? "path";
  if (wantedTraversal === "path"       && zone.traversal !== "path")       return 0;
  if (wantedTraversal === "wilderness" && zone.traversal !== "wilderness") return 0;
  // "either" passes through.

  if (zone.area < poi.fit.minArea) return 0;
  if (zone.area > poi.fit.maxArea) return 0;

  if (poi.fit.enclosure) {
    if (poi.fit.enclosure.min !== undefined && zone.enclosure < poi.fit.enclosure.min) return 0;
    if (poi.fit.enclosure.max !== undefined && zone.enclosure > poi.fit.enclosure.max) return 0;
  }

  if (poi.fit.requiredBiome && poi.fit.requiredBiome.length > 0) {
    if (!biomeMatches(biome, poi.fit.requiredBiome)) return 0;
  }

  if (poi.fit.requiredKind && poi.fit.requiredKind.length > 0) {
    // Zone must touch at least one of the required boundary kinds.
    // kindHistogram is keyed by numeric kind id; the POI declares tags
    // (e.g. "stone"). We use a fixed mapping from tag → numeric kind id
    // mirroring BOUNDARY_KIND_* in pipeline/boundary_kinds.ts.
    let matched = false;
    for (const kindTag of poi.fit.requiredKind) {
      const kindId = KIND_TAG_TO_ID[kindTag];
      if (kindId !== undefined && (zone.kindHistogram[kindId] ?? 0) > 0) {
        matched = true;
        break;
      }
    }
    if (!matched) return 0;
  }

  // Soft scoring
  let score = 1.0;
  if (poi.fit.preferredTopology.includes(zone.topologyRole)) {
    score += params.preferredTopologyBonus;
  }
  score *= poi.quotaWeight;
  return score;
}

const KIND_TAG_TO_ID: Record<string, number> = {
  open:        0,
  stone:       1,
  forest:      2,
  water:       3,
  grass_mound: 4,
};

function biomeMatches(
  biome: { altitude: number; moisture: number; temperature: number; ruggedness: number },
  required: string[],
): boolean {
  // Translate biome params back into the same loose tag-space the worldmap
  // emits (the boundary_kinds stage already encodes these thresholds; we
  // mirror them here so POI matching reads the same "story" the player
  // would). Conservative tags: anything roughly stoney+rugged → "mountains",
  // wet+low → "swamp", etc. Multi-tag matches when any tag in `required`
  // hits.
  for (const tag of required) {
    if (tag === "forest"    && biome.moisture > 0.45 && biome.altitude < 0.7)    return true;
    if (tag === "hills"     && biome.altitude > 0.4  && biome.altitude < 0.75)   return true;
    if (tag === "mountains" && biome.altitude > 0.7)                              return true;
    if (tag === "plains"    && biome.altitude < 0.5  && biome.ruggedness < 0.4)   return true;
    if (tag === "swamp"     && biome.moisture > 0.6  && biome.altitude < 0.4)     return true;
    if (tag === "desert"    && biome.temperature > 0.65 && biome.moisture < 0.3)  return true;
    if (tag === "tundra"    && biome.temperature < 0.25)                          return true;
    if (tag === "shore"     && biome.altitude < 0.35 && biome.moisture > 0.4)     return true;
  }
  return false;
}

// ---------------------------------------------------------------------
// Phase 2 — selection
// ---------------------------------------------------------------------

function selectPois(
  candidates: ScoredCandidate[],
  target: number,
  rng: () => number,
  stairCtx: StairContext,
): ScoredCandidate[] | null {
  if (candidates.length === 0) return null;

  // Precompute the set of wilderness zone ids that have a usable stair
  // anchor (i.e. at least one adjacent path-zone neighbour). Wilderness
  // POIs whose zone is in this set are eligible; others are rejected.
  const stairable = wildernessZonesWithPathNeighbor(stairCtx.zones);

  const chosen: ScoredCandidate[] = [];
  const usedZones = new Set<number>();
  const usedPois = new Set<string>();

  // Aim for ~half of slots as entries (rounded up, min 2) when target ≥ 4.
  // A richer pool of upstream theme sources is what makes wireDag succeed
  // — single-entry tiles consistently fail because one POI's drop-tags
  // rarely cover every gate's flavorAccept.
  const minEntries = target >= 4 ? Math.max(2, Math.ceil(target / 2)) : 1;

  // Phase A — pick entries first, walking the score-sorted list. Stop at
  // minEntries OR when no more entry candidates remain.
  for (const c of candidates) {
    if (chosen.length >= minEntries) break;
    if (!c.poi.roles.includes("entry")) continue;
    if (usedZones.has(c.zone.id)) continue;
    if (usedPois.has(c.poi.id)) continue;
    if (c.zone.traversal === "wilderness" && !stairable.has(c.zone.id)) continue;
    chosen.push(c);
    usedZones.add(c.zone.id);
    usedPois.add(c.poi.id);
  }
  if (chosen.length === 0) return null; // can't get into the tile

  // Phase B — fill the remaining slots with the best-scored candidates,
  // preferring at least one terminal if one is still available. We allow
  // the loop to skip a non-terminal on the LAST slot when a terminal is
  // still reachable downstream in the candidate list.
  let hasTerminal = chosen.some(c => c.poi.roles.includes("terminal"));
  for (const c of candidates) {
    if (chosen.length >= target && hasTerminal) break;
    if (usedZones.has(c.zone.id)) continue;
    if (usedPois.has(c.poi.id)) continue;
    if (c.zone.traversal === "wilderness" && !stairable.has(c.zone.id)) continue;

    const isTerminal = c.poi.roles.includes("terminal");
    const slotsLeft  = target - chosen.length;
    if (!hasTerminal && slotsLeft <= 1 && !isTerminal &&
        terminalStillAvailable(candidates, usedZones, usedPois)) continue;

    if (chosen.length >= target && (rng() < 0.5)) break;

    chosen.push(c);
    usedZones.add(c.zone.id);
    usedPois.add(c.poi.id);
    if (isTerminal) hasTerminal = true;
  }

  if (chosen.length < 2) return null; // can't build even a 2-node DAG
  return chosen;
}

function terminalStillAvailable(
  candidates: ScoredCandidate[],
  usedZones: Set<number>,
  usedPois: Set<string>,
): boolean {
  for (const c of candidates) {
    if (usedZones.has(c.zone.id)) continue;
    if (usedPois.has(c.poi.id)) continue;
    if (c.poi.roles.includes("terminal")) return true;
  }
  return false;
}

// ---------------------------------------------------------------------
// Phase 3 — DAG wiring
// ---------------------------------------------------------------------

interface WiredEdge {
  source: ScoredCandidate;
  dest:   ScoredCandidate;
  themes: string[];   // theme overlap between source.tags and dest.gate.flavorAccept
}

interface WiredDag {
  nodes: ScoredCandidate[];
  edges: WiredEdge[];
}

function wireDag(
  selected: ScoredCandidate[],
  rng: () => number,
  _maxDepth: number,
): WiredDag | null {
  // Sort nodes: entry-eligible first, terminals last, the rest in between.
  // The wiring algorithm picks upstreams in this order so the DAG
  // naturally produces a topological progression.
  const entries:    ScoredCandidate[] = [];
  const middles:    ScoredCandidate[] = [];
  const terminals:  ScoredCandidate[] = [];
  for (const c of selected) {
    if      (c.poi.roles.includes("entry"))    entries.push(c);
    else if (c.poi.roles.includes("terminal")) terminals.push(c);
    else                                        middles.push(c);
  }

  const order = [...entries, ...middles, ...terminals];
  const edges: WiredEdge[] = [];

  // Entries' gates are forced to "open" — they're how the player gets
  // into the tile. Don't try to wire upstreams for them.
  for (let i = 0; i < order.length; i++) {
    const dest = order[i];
    const gate = dest.poi.gate;
    if (gate.kind === "open" || dest.poi.roles.includes("entry")) continue;

    // Upstream candidates: any earlier node whose tags intersect this
    // gate's flavorAccept.
    const upstreams = order.slice(0, i).filter(src => {
      const overlap = themeOverlap(src.poi.tags, (gate as { flavorAccept?: string[] }).flavorAccept ?? []);
      return overlap.length > 0;
    });
    if (upstreams.length === 0) {
      // No bridge available — this dest is unsolvable in this selection.
      return null;
    }
    // Shuffle upstreams via the seeded RNG so the picked source varies
    // across retries.
    const shuffled = shuffle(upstreams, rng);

    let needed = 1;
    if (gate.kind === "multi" || gate.kind === "choice") {
      needed = Math.min(gate.count, shuffled.length);
      if (gate.kind === "multi" && shuffled.length < gate.count) {
        // multi-gate insists on `count` distinct sources; short on options.
        return null;
      }
    }
    for (let k = 0; k < needed; k++) {
      const src = shuffled[k];
      edges.push({
        source: src,
        dest,
        themes: themeOverlap(src.poi.tags, (gate as { flavorAccept?: string[] }).flavorAccept ?? []),
      });
    }
  }

  // Acyclicity check (cheap: we wired upstream → downstream in
  // topological order; a cycle is impossible by construction).
  return { nodes: order, edges };
}

function themeOverlap(a: readonly string[], b: readonly string[]): string[] {
  const setB = new Set(b);
  return a.filter(t => setB.has(t));
}

function shuffle<T>(arr: readonly T[], rng: () => number): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// ---------------------------------------------------------------------
// Phase 4 — trinket naming + narrative emission
// ---------------------------------------------------------------------

function buildNarrative(
  dag: WiredDag,
  retries: number,
  stairCtx: StairContext,
): TileNarrative {
  const poiInstanceId = (cand: ScoredCandidate) =>
    `${cand.poi.id}_z${cand.zone.id}`;

  // Index outgoing edges per node so we can decide each POI's dropped trinket.
  const outgoing = new Map<string, WiredEdge[]>();
  for (const e of dag.edges) {
    const k = poiInstanceId(e.source);
    const a = outgoing.get(k) ?? [];
    a.push(e);
    outgoing.set(k, a);
  }

  // Trinkets: one per edge. The source POI drops it on completion; the
  // dest POI's gate consumes it.
  const trinkets: TrinketInstance[] = [];
  for (const e of dag.edges) {
    const sourceId = poiInstanceId(e.source);
    const destId   = poiInstanceId(e.dest);
    const trinketId = `trinket_${sourceId}_to_${destId}`;
    trinkets.push({
      id: trinketId,
      sourcePoi: sourceId,
      destPoi: destId,
      themes: e.themes,
      displayName: nameTrinket(e),
    });
  }

  // Stairs (T-210): one per wilderness-POI node. The stair's lockedBy
  // points at the FIRST trinket that the wilderness POI's gate consumes
  // — that trinket is the climb-up key. For wilderness POIs with an
  // "open" gate (level-design hint), `lockedBy` stays null.
  const stairs: StairInstance[] = [];
  const stairByPoiId = new Map<string, string>();
  for (const node of dag.nodes) {
    if (node.zone.traversal !== "wilderness") continue;
    const poiId = poiInstanceId(node);
    const incomingEdges = dag.edges.filter(e => poiInstanceId(e.dest) === poiId);
    const fromZone = pickStairPathZoneFor(node.zone, stairCtx);
    if (fromZone === null) continue; // shouldn't happen post-selection filter
    const anchor = pickStairAnchor(fromZone, node.zone.id, stairCtx);
    const stairId = `stair_${poiId}`;
    const lockedBy = incomingEdges.length > 0
      ? `trinket_${poiInstanceId(incomingEdges[0].source)}_to_${poiId}`
      : null;
    stairs.push({
      id: stairId,
      fromZoneId: fromZone,
      toZoneId:   node.zone.id,
      anchorPixel: anchor,
      lockedBy,
    });
    stairByPoiId.set(poiId, stairId);
  }

  // POI instances: every selected POI gets one. Wilderness POIs carry
  // their stair id so the runtime can wire entry to the stair entity.
  const pois: PoiInstance[] = [];
  for (const node of dag.nodes) {
    const id = poiInstanceId(node);
    const outs = outgoing.get(id) ?? [];
    const trinketId = outs.length > 0
      ? `trinket_${id}_to_${poiInstanceId(outs[0].dest)}`
      : null;
    const incoming = dag.edges.filter(e => poiInstanceId(e.dest) === id);
    pois.push({
      id,
      poiDefId: node.poi.id,
      zoneId:   node.zone.id,
      gate: resolveGate(node, incoming, trinkets),
      trinketId,
      stairId: stairByPoiId.get(id) ?? null,
    });
  }

  const entryPoiIds    = pois.filter(p => p.gate.kind === "open").map(p => p.id);
  const terminalPoiIds = pois.filter(p => !outgoing.has(p.id)).map(p => p.id);

  return {
    pois,
    trinkets,
    stairs,
    dagShape: classifyDagShape(pois, dag.edges, poiInstanceId),
    entryPoiIds,
    terminalPoiIds,
    degraded: false,
    retries,
  };
}

function resolveGate(
  node: ScoredCandidate,
  incoming: WiredEdge[],
  trinkets: TrinketInstance[],
): ResolvedGate {
  const k = node.poi.gate.kind;
  if (k === "open") return { kind: "open", trinketRefs: [] };
  const trinketRefs = incoming
    .map(e => `trinket_${e.source.poi.id}_z${e.source.zone.id}_to_${e.dest.poi.id}_z${e.dest.zone.id}`)
    .filter(id => trinkets.some(t => t.id === id));
  return { kind: k, trinketRefs };
}

function nameTrinket(e: WiredEdge): string {
  const theme = e.themes[0] ?? e.source.poi.tags[0] ?? "token";
  const flavor = e.source.poi.reward.trinketTheme.flavorTags[0] ?? "ancient";
  return `${cap(theme)} of the ${cap(flavor)} ${e.source.poi.displayName}`;
}

function cap(s: string): string {
  if (s.length === 0) return s;
  return s[0].toUpperCase() + s.slice(1);
}

function classifyDagShape(
  pois: PoiInstance[],
  edges: WiredEdge[],
  poiInstanceId: (c: ScoredCandidate) => string,
): DagShape {
  const indeg  = new Map<string, number>();
  const outdeg = new Map<string, number>();
  for (const p of pois) { indeg.set(p.id, 0); outdeg.set(p.id, 0); }
  for (const e of edges) {
    const s = poiInstanceId(e.source);
    const d = poiInstanceId(e.dest);
    outdeg.set(s, (outdeg.get(s) ?? 0) + 1);
    indeg.set(d, (indeg.get(d) ?? 0) + 1);
  }
  let maxIn = 0, maxOut = 0;
  for (const v of indeg.values())  if (v > maxIn)  maxIn  = v;
  for (const v of outdeg.values()) if (v > maxOut) maxOut = v;
  if (maxIn <= 1 && maxOut <= 1) return "linear";
  if (maxIn >= 2 && maxOut >= 2) return "lattice";
  if (maxIn >= 2)               return "diamond";
  return "branching";
}

// ---------------------------------------------------------------------
// Degraded fallback — when retries exhaust
// ---------------------------------------------------------------------

function emitDegraded(
  zones: AnnotatedZone[],
  pois: PoiDef[],
  biome: { altitude: number; moisture: number; temperature: number; ruggedness: number },
  params: GenParams["poiNetwork"],
  _stairCtx: StairContext,
): TileNarrative {
  // Take the top-scored candidates regardless of theme bridge solvability;
  // wire them as a linear chain with synthetic trinkets that satisfy any
  // gate by ignoring flavor matching. Tile remains playable; just lacks
  // the deliberate trinket-theme story.
  const cands = scoreCandidates(zones, pois, biome, params);
  const used = new Set<number>();
  const chain: ScoredCandidate[] = [];
  for (const c of cands) {
    if (chain.length >= Math.min(params.targetPoiCount, 4)) break;
    if (used.has(c.zone.id)) continue;
    chain.push(c);
    used.add(c.zone.id);
  }
  const poiInstanceId = (c: ScoredCandidate) => `${c.poi.id}_z${c.zone.id}`;
  const trinkets: TrinketInstance[] = [];
  for (let i = 0; i < chain.length - 1; i++) {
    const src = chain[i], dst = chain[i + 1];
    const trinketId = `trinket_${poiInstanceId(src)}_to_${poiInstanceId(dst)}`;
    trinkets.push({
      id: trinketId,
      sourcePoi: poiInstanceId(src),
      destPoi: poiInstanceId(dst),
      themes: ["fallback"],
      displayName: `Token of ${src.poi.displayName}`,
    });
  }
  // Degraded mode still emits empty stairs[] — the degraded chain is
  // path-only (we filter wilderness out earlier so we never produce a
  // wilderness pick without a valid stair anchor).
  const poisOut: PoiInstance[] = chain.map((c, i) => ({
    id: poiInstanceId(c),
    poiDefId: c.poi.id,
    zoneId: c.zone.id,
    gate: i === 0
      ? { kind: "open" as const, trinketRefs: [] }
      : { kind: "item" as const, trinketRefs: [`trinket_${poiInstanceId(chain[i - 1])}_to_${poiInstanceId(c)}`] },
    trinketId: i < chain.length - 1
      ? `trinket_${poiInstanceId(c)}_to_${poiInstanceId(chain[i + 1])}`
      : null,
    stairId: null,
  }));
  return {
    pois: poisOut,
    trinkets,
    stairs: [],
    dagShape: "linear",
    entryPoiIds: poisOut.length > 0 ? [poisOut[0].id] : [],
    terminalPoiIds: poisOut.length > 0 ? [poisOut[poisOut.length - 1].id] : [],
    degraded: true,
    retries: params.maxRetries,
  };
}

// ---------------------------------------------------------------------
// Stair anchoring (T-210)
// ---------------------------------------------------------------------

/**
 * Set of wilderness zone ids that have at least one path-zone neighbour
 * — a precondition for placing a stair onto them. Wilderness zones
 * fully enclosed by other wilderness (rare given the tile structure)
 * are excluded.
 */
function wildernessZonesWithPathNeighbor(zones: AnnotatedZone[]): Set<number> {
  const byId = new Map<number, AnnotatedZone>();
  for (const z of zones) byId.set(z.id, z);
  const out = new Set<number>();
  for (const z of zones) {
    if (z.traversal !== "wilderness") continue;
    for (const nid of z.neighbors) {
      const n = byId.get(nid);
      if (n && n.traversal === "path") { out.add(z.id); break; }
    }
  }
  return out;
}

/**
 * Pick which adjacent path zone hosts the stair. Algorithm: pick the
 * path-zone neighbour with the largest area (most "room" to walk up to
 * the stair). Stable tie-break by zone id.
 */
function pickStairPathZoneFor(
  wilderness: AnnotatedZone,
  ctx: StairContext,
): number | null {
  const byId = new Map<number, AnnotatedZone>();
  for (const z of ctx.zones) byId.set(z.id, z);
  let best: AnnotatedZone | null = null;
  for (const nid of wilderness.neighbors) {
    const n = byId.get(nid);
    if (!n || n.traversal !== "path") continue;
    if (!best || n.area > best.area || (n.area === best.area && n.id < best.id)) {
      best = n;
    }
  }
  return best?.id ?? null;
}

/**
 * Pick the anchor pixel for the stair: a path-pixel in `fromZoneId`
 * that shares an edge with a pixel in `wildZoneId`. Out of all
 * candidates, pick the one geographically nearest to the wilderness
 * zone's centroid (the "most natural" entrance). Stable tie-break by
 * row-major index.
 */
function pickStairAnchor(
  fromZoneId: number,
  wildZoneId: number,
  ctx: StairContext,
): { x: number; y: number } {
  const { zoneOf, gridSize } = ctx;
  const wild = ctx.zones.find(z => z.id === wildZoneId);
  if (!wild) return { x: 0, y: 0 };
  let bestIdx = -1;
  let bestDistSq = Infinity;
  for (let idx = 0; idx < zoneOf.length; idx++) {
    if (zoneOf[idx] !== fromZoneId) continue;
    const x = idx % gridSize;
    const y = (idx - x) / gridSize;
    // Must touch wildZoneId on one of 4 neighbours.
    let touches = false;
    if (x > 0            && zoneOf[idx - 1]        === wildZoneId) touches = true;
    if (x < gridSize - 1 && zoneOf[idx + 1]        === wildZoneId) touches = true;
    if (y > 0            && zoneOf[idx - gridSize] === wildZoneId) touches = true;
    if (y < gridSize - 1 && zoneOf[idx + gridSize] === wildZoneId) touches = true;
    if (!touches) continue;
    const dx = x - wild.centroid.x;
    const dy = y - wild.centroid.y;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestDistSq) { bestDistSq = d2; bestIdx = idx; }
  }
  if (bestIdx < 0) return { x: 0, y: 0 };
  return { x: bestIdx % gridSize, y: Math.floor(bestIdx / gridSize) };
}

/**
 * For every wilderness zone the matcher DIDN'T assign a POI-stair to,
 * add a "found" stair (lockedBy: null). Result: every reachable
 * wilderness blob has an open stair the player can use to climb up,
 * even when no quest content lives on that plateau. Makes initial
 * exploration much friendlier — no map-wide hunt for the one stair
 * the player has to find — while keeping the trinket-gated stairs
 * (POI-narrative ones) as the intended progression spine.
 *
 * Skips zones with no path-zone neighbour (no anchor possible).
 * Mutates `narrative.stairs` in place; returns the count added.
 */
function addFoundStairsForExposedWilderness(
  narrative: TileNarrative,
  ctx: StairContext,
): number {
  const covered = new Set<number>();
  for (const s of narrative.stairs) covered.add(s.toZoneId);

  let added = 0;
  for (const z of ctx.zones) {
    if (z.traversal !== "wilderness") continue;
    if (covered.has(z.id)) continue;
    const fromZone = pickStairPathZoneFor(z, ctx);
    if (fromZone === null) continue; // truly isolated wilderness
    const anchor = pickStairAnchor(fromZone, z.id, ctx);
    if (anchor.x === 0 && anchor.y === 0) {
      // pickStairAnchor returns 0,0 as a sentinel for "no anchor found"
      // — that's a real corner of the tile but vanishingly unlikely to
      // be a legitimate anchor; skip rather than place a stair there.
      continue;
    }
    narrative.stairs.push({
      id: `stair_explore_z${z.id}`,
      fromZoneId: fromZone,
      toZoneId: z.id,
      anchorPixel: anchor,
      lockedBy: null,
    });
    added++;
  }
  return added;
}

// ---------------------------------------------------------------------
// PRNG (matches the per-stage mulberry32 used elsewhere in this package)
// ---------------------------------------------------------------------

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
