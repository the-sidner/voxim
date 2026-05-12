/**
 * Deterministic seed splitting for staged generators.
 *
 * A pipeline that threads one global seed through every stage couples them:
 * tweak a late-stage param and you've shifted the RNG stream every earlier
 * stage consumes, so they all reroll. Each stage instead derives its own
 * sub-seed from `(globalSeed, stageId)` and consumes that — frozen upstream
 * outputs survive downstream edits.
 *
 * `hashString` is FNV-1a 32-bit: small, stable across engines, well-mixed
 * for short identifiers. `splitSeed` then folds the hash into the global
 * seed with a Murmur3-style finalizer for extra avalanche.
 *
 * Both functions return unsigned 32-bit integers.
 */

export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function splitSeed(globalSeed: number, stageId: string): number {
  let s = (globalSeed ^ hashString(stageId)) >>> 0;
  s = Math.imul(s ^ (s >>> 16), 0x85ebca6b);
  s = Math.imul(s ^ (s >>> 13), 0xc2b2ae35);
  return (s ^ (s >>> 16)) >>> 0;
}
