/**
 * Procedural zone naming (T-211).
 *
 * Each zone gets a human-readable name derived deterministically from
 * `(tileSeed, zoneId, biome, topologyRole, traversal)`. The name uses
 * an adjective + role-noun pattern, with adjectives biased by biome
 * and traversal class. The client displays "You are in: {name}" when
 * the player enters a zone.
 *
 *   "Whispering Grove"     — forest grove, calm-biased adj
 *   "Hollow Crag"          — wilderness crag, neutral adj
 *   "Bandit's Crossroads"  — path crossroads, dangerous-biased adj
 *
 * Adjective pools are seeded by the zone's tile + id so the same zone
 * always gets the same name. Only zones with `area >= NAMED_AREA_MIN`
 * receive a non-empty name; smaller zones (micro-thickets between
 * corridors, single-pixel crags) get `""` to avoid HUD spam.
 *
 * No POI-driven naming yet (e.g. "the Wolf Den" near a wolf_den POI).
 * That requires the namer to run AFTER the matcher; current pipeline
 * runs zone naming during `zoneGraph` (before POIs are chosen).
 * Adding poi-aware names is a follow-up.
 */

import { hashString, splitSeed } from "@voxim/levelgen";
import type { ZoneRole } from "@voxim/content";

/** Zones smaller than this stay anonymous (name = ""). */
export const NAMED_AREA_MIN = 60;

/**
 * Adjective pools split by traversal class. Path adjectives carry a
 * sense of motion / hazard; wilderness adjectives evoke standing
 * structures / hidden places.
 */
const PATH_ADJ = [
  "Whispering", "Forgotten", "Sunken", "Hidden", "Crooked", "Echoing",
  "Twisting", "Old", "Wild", "Bandit's", "Storm", "Bone",
  "Quiet", "Last", "Lonely", "Rover's",
];

const WILDERNESS_ADJ = [
  "Hollow", "Cursed", "Verdant", "Mossy", "Stony", "Sun-touched",
  "Shadow-veiled", "Brittlewatch", "Drowned", "Withered",
  "Riven", "Pale", "Crown", "Skybound", "Watchful",
];

/** Biome-flavoured adjective overrides; checked before the generic pools. */
const BIOME_ADJ: Record<string, string[]> = {
  forest:    ["Verdant", "Mossy", "Whispering", "Tangled", "Sunlit", "Bramble"],
  swamp:     ["Drowned", "Boggy", "Fetid", "Sodden", "Vine-strangled"],
  mountains: ["Crown", "Skybound", "Stony", "Brittlewatch", "Wind-cut", "Pale"],
  tundra:    ["Frost", "Hollow", "Pale", "Whispering", "Sun-touched"],
  desert:    ["Sun-touched", "Withered", "Bone", "Brittle", "Old"],
  shore:     ["Brine", "Sea-worn", "Tide", "Salt-pitted", "Drowned"],
  hills:     ["Rolling", "Watchful", "Riven", "Old", "Hidden"],
  plains:    ["Wide", "Quiet", "Endless", "Wind-swept", "Lonely"],
};

/** Role-specific noun pool. */
const ROLE_NOUN: Record<ZoneRole, string[]> = {
  arena:      ["Arena", "Field", "Court", "Grounds"],
  plaza:      ["Plaza", "Crossing", "Court", "Reach"],
  crossroads: ["Crossroads", "Junction", "Crux"],
  lobby:      ["Hall", "Antechamber", "Anteway", "Threshold"],
  corridor:   ["Passage", "Run", "Way", "Furrow"],
  pocket:     ["Nook", "Pocket", "Cove", "Cleft"],
  deadend:    ["End", "Hollow", "Dead-Reach"],
  crag:       ["Crag", "Spire", "Pinnacle", "Tor"],
  grove:      ["Grove", "Wood", "Stand", "Copse"],
  thicket:    ["Thicket", "Brake", "Tangle"],
  hollow:     ["Hollow", "Dell", "Basin", "Bowl"],
  outcrop:    ["Outcrop", "Knoll", "Mound", "Rise"],
  morass:     ["Mire", "Marsh", "Bog", "Slough"],
};

/**
 * Map biome params to a coarse tag for adjective lookup. Mirrors the
 * threshold logic in poi_network.ts/biomeMatches; the same tile reads
 * as the same biome from both views.
 */
function biomeTag(biome: {
  altitude: number; moisture: number; temperature: number; ruggedness: number;
}): string {
  if (biome.moisture > 0.6 && biome.altitude < 0.4)                return "swamp";
  if (biome.altitude > 0.7)                                         return "mountains";
  if (biome.temperature < 0.25)                                     return "tundra";
  if (biome.temperature > 0.65 && biome.moisture < 0.3)             return "desert";
  if (biome.altitude < 0.35 && biome.moisture > 0.4)                return "shore";
  if (biome.altitude > 0.4 && biome.altitude < 0.75)                return "hills";
  if (biome.altitude < 0.5 && biome.ruggedness < 0.4)               return "plains";
  if (biome.moisture > 0.45 && biome.altitude < 0.7)                return "forest";
  return "plains";
}

export function nameZone(
  tileSeed: number,
  zoneId: number,
  area: number,
  role: ZoneRole,
  traversal: "path" | "wilderness",
  biome: { altitude: number; moisture: number; temperature: number; ruggedness: number },
): string {
  if (area < NAMED_AREA_MIN) return "";

  const subSeed = splitSeed(tileSeed, `zoneName_${zoneId}`);
  const tag     = biomeTag(biome);

  // Adjective: 70% biome-flavoured, 30% generic traversal pool. The
  // seeded hash + division produces a stable bucket choice per zone.
  const generic = traversal === "wilderness" ? WILDERNESS_ADJ : PATH_ADJ;
  const biomePool = BIOME_ADJ[tag] ?? generic;
  const useBiome = (subSeed >>> 24) < (0.7 * 256);
  const adjPool  = useBiome ? biomePool : generic;
  const adj      = adjPool[hashString(`adj_${subSeed}`) % adjPool.length];

  const nounPool = ROLE_NOUN[role] ?? [role];
  const noun     = nounPool[hashString(`noun_${subSeed}`) % nounPool.length];

  return `${adj} ${noun}`;
}
