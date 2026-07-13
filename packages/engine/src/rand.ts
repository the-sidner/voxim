/**
 * Shared PRNG / seed-mixing primitives.
 *
 * Byte-parity is load-bearing here: client scatter placement must match
 * server placement bit-for-bit given the same seed (T-311), and atlas's
 * tilemap pipeline stages must reproduce identical output across runs
 * (the 48-test snapshot matrix). Every consumer imports from here rather
 * than hand-rolling its own copy — a single textual drift (operand order,
 * accumulator init) is invisible in review but breaks that parity.
 */

/**
 * mulberry32 — a fast, small-state 32-bit PRNG. Returns a generator
 * function producing floats in [0, 1).
 */
export function mulberry32(seed: number): () => number {
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
 * 32-bit seed mixer (Murmur3-style finalizer). Combines two 32-bit seeds
 * (e.g. tile seed + variant index) into one well-avalanched seed.
 */
export function mix32(a: number, b: number): number {
  let x = (a ^ b) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b) >>> 0;
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35) >>> 0;
  return (x ^ (x >>> 16)) >>> 0;
}

/**
 * A single seeded pool/probability selection point (T-334). The vocabulary
 * `@voxim/content`'s `SubObjectRef` already used (`resolveSubObjects`) and
 * `Prefab.children`'s `ChildPrefabRef` both converge on: an optional
 * inclusion roll, then an optional pool pick.
 */
export interface SeededPoolEntry {
  /** 0–1 probability this entry is included at all. Omitted/1.0 ⇒ always included. */
  probability?: number;
  /** Variant pool — one id is chosen at random when present and non-empty. */
  pool?: string[];
}

/**
 * Resolve ONE seeded pool/probability entry against a shared `rand` stream,
 * returning the chosen id or `undefined` if the probability roll excluded it
 * (or it resolves to nothing at all).
 *
 * This is the ONE place this selection happens — every consumer that derives
 * geometry from a `pool`/`probability` entry (content's `resolveSubObjects`,
 * `hitbox_derive.ts`'s capsule derivation, the engine's `spawnPrefab`
 * subtree walk over `Prefab.children`) calls this once per entry, in list
 * order, off ONE seeded generator. That is load-bearing: a hitbox derived
 * from a different draw sequence than the geometry actually spawned/rendered
 * silently drifts from what's drawn (the wolf-legs bug class, T-323).
 *
 * Draw order (fixed, do not reorder):
 *   1. IF `probability < 1.0`: draw one `rand()` for the inclusion roll.
 *   2. IF `pool` is non-empty: draw one more `rand()` to index into it.
 * Both draws are skipped when their guard is false, so an entry with neither
 * `probability` nor `pool` consumes ZERO draws from the stream — it doesn't
 * shift any other entry's roll.
 */
export function resolveSeededPick(
  entry: SeededPoolEntry,
  fallbackId: string | undefined,
  rand: () => number,
): string | undefined {
  const prob = entry.probability ?? 1.0;
  if (prob < 1.0 && rand() >= prob) return undefined;
  if (entry.pool && entry.pool.length > 0) {
    return entry.pool[Math.floor(rand() * entry.pool.length)];
  }
  return fallbackId;
}
