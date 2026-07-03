/**
 * Ordered biome-tag ladder — shared by zone_namer (wants the single
 * best-matching tag) and poi_network (wants "does biome satisfy ANY
 * required tag"). First-match-wins order matters for biomeTag(); order
 * is irrelevant for biomeMatches() (pure membership test).
 *
 * Values are eyeballed against the boundary_kinds stage's own biome
 * thresholds — not GenParams-promoted (this table is a code-dedup pass,
 * not a tuning promotion; see T-315 plan's phase D/E split).
 */
import type { BiomeParams } from "../../worldmap/types.ts";

export const BIOME_TAG_RULES: ReadonlyArray<{ tag: string; test: (b: BiomeParams) => boolean }> = [
  { tag: "swamp",     test: (b) => b.moisture > 0.6  && b.altitude < 0.4 },
  { tag: "mountains", test: (b) => b.altitude > 0.7 },
  { tag: "tundra",    test: (b) => b.temperature < 0.25 },
  { tag: "desert",    test: (b) => b.temperature > 0.65 && b.moisture < 0.3 },
  { tag: "shore",     test: (b) => b.altitude < 0.35 && b.moisture > 0.4 },
  { tag: "hills",     test: (b) => b.altitude > 0.4  && b.altitude < 0.75 },
  { tag: "plains",    test: (b) => b.altitude < 0.5  && b.ruggedness < 0.4 },
  { tag: "forest",    test: (b) => b.moisture > 0.45 && b.altitude < 0.7 },
];

/** Single best-matching tag, first-rule-wins; "plains" if none match. */
export function biomeTag(biome: BiomeParams): string {
  for (const r of BIOME_TAG_RULES) if (r.test(biome)) return r.tag;
  return "plains";
}

/** True if biome satisfies ANY of the required tags (order-independent). */
export function biomeMatches(biome: BiomeParams, required: string[]): boolean {
  return required.some((tag) => BIOME_TAG_RULES.some((r) => r.tag === tag && r.test(biome)));
}
