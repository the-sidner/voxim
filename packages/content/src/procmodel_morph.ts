/**
 * Corruption-morph param merge (T-311 P4). A ProcModelDef's `morphTiers` are
 * param-override objects deep-merged over the base `params` — the corrupted
 * form of a fern/tree is DATA (darker material, fewer blades, more gnarl),
 * never generator code or a hash. Pure + loader-adjacent so the client pool
 * builder and any future server consumer share one merge semantics:
 * plain objects merge recursively; arrays and primitives REPLACE.
 */

// deno-lint-ignore no-explicit-any
type Params = Record<string, any>;

function isPlainObject(v: unknown): v is Params {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Deep-merge `override` over `base` (non-mutating). */
export function mergeMorphTierParams(base: Params, override: Params): Params {
  const out: Params = { ...base };
  for (const [k, v] of Object.entries(override)) {
    out[k] = isPlainObject(v) && isPlainObject(base[k]) ? mergeMorphTierParams(base[k], v) : v;
  }
  return out;
}

/**
 * Resolve the effective generator params for `tier` (0 = base). Tiers > 0
 * merge `morphTiers[tier-1]` over the base params; out-of-range tiers clamp
 * to the last authored tier (defensive — the bucket math should never exceed).
 */
export function morphTierParams(
  params: Params,
  morphTiers: ReadonlyArray<Params> | undefined,
  tier: number,
): Params {
  if (tier <= 0 || !morphTiers?.length) return params;
  const t = Math.min(tier, morphTiers.length);
  return mergeMorphTierParams(params, morphTiers[t - 1]);
}
