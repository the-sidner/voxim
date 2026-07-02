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
