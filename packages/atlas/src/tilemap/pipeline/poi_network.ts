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
  TileNarrative, TrinketInstance,
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

  for (let retry = 0; retry < params.maxRetries; retry++) {
    const subSeed = splitSeed(tileSeed, `poiNetwork_retry${retry}`);
    const rng = mulberry32(subSeed);

    // Phase 1: candidate scoring
    const candidates = scoreCandidates(state.zones, allPois, biome, params);

    // Phase 2: selection
    const selected = selectPois(candidates, params.targetPoiCount, rng);
    if (!selected) continue; // try again with a fresh seed

    // Phase 3: DAG wiring
    const wired = wireDag(selected, rng, params.maxWireSearchDepth);
    if (!wired) continue;

    // Phase 4: trinket naming + emit
    return buildNarrative(wired, retry);
  }

  // Retry budget exhausted — emit a degraded narrative built from the
  // best candidates regardless of bridge solvability.
  return emitDegraded(state.zones, allPois, biome, params);
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
): ScoredCandidate[] | null {
  if (candidates.length === 0) return null;

  const chosen: ScoredCandidate[] = [];
  const usedZones = new Set<number>();
  const usedPois = new Set<string>();
  let hasEntry = false;
  let hasTerminal = false;

  // Walk candidates in descending-score order; pick anything that maintains
  // the uniqueness and role-coverage invariants. Once we have `target`
  // POIs AND at least one entry AND at least one terminal, return.
  for (const c of candidates) {
    if (chosen.length >= target && hasEntry && hasTerminal) break;
    if (usedZones.has(c.zone.id)) continue;
    if (usedPois.has(c.poi.id)) continue;
    // Role coverage: when we're close to the target without entry/terminal,
    // be picky about what we accept.
    const isEntry    = c.poi.roles.includes("entry");
    const isTerminal = c.poi.roles.includes("terminal");
    const slotsLeft  = target - chosen.length;
    if (!hasEntry    && slotsLeft <= 1 && !isEntry)    continue;
    if (!hasTerminal && slotsLeft <= 1 && !isTerminal) continue;

    // Tiny randomized perturbation to break ties when many candidates
    // share the top score — keeps tile-to-tile output varied across
    // distinct seeds while staying deterministic per seed.
    if (chosen.length >= target && (rng() < 0.5)) break;

    chosen.push(c);
    usedZones.add(c.zone.id);
    usedPois.add(c.poi.id);
    if (isEntry)    hasEntry    = true;
    if (isTerminal) hasTerminal = true;
  }

  if (chosen.length < 2) return null;       // can't even build a 2-node DAG
  if (!hasEntry)         return null;       // can't get into the tile
  // Terminal is preferred but not strictly required for v1; tiles without
  // a terminal-eligible POI just don't have a "boss". Accept that.
  return chosen;
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

function buildNarrative(dag: WiredDag, retries: number): TileNarrative {
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

  // POI instances: every selected POI gets one. Drop one trinket per POI
  // by picking the first outgoing edge (rest are extras for multi-gated
  // dests — those reuse the SAME source trinket for now; v2 could vary).
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
    });
  }

  const entryPoiIds    = pois.filter(p => p.gate.kind === "open").map(p => p.id);
  const terminalPoiIds = pois.filter(p => !outgoing.has(p.id)).map(p => p.id);

  return {
    pois,
    trinkets,
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
  }));
  return {
    pois: poisOut,
    trinkets,
    dagShape: "linear",
    entryPoiIds: poisOut.length > 0 ? [poisOut[0].id] : [],
    terminalPoiIds: poisOut.length > 0 ? [poisOut[poisOut.length - 1].id] : [],
    degraded: true,
    retries: params.maxRetries,
  };
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
