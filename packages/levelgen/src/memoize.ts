/**
 * Memoization wrapper for transformers.
 *
 * Inspector use case: a user drags a late-stage slider. Without caching,
 * every upstream stage recomputes; with caching keyed on
 * `(inputHash, seed, paramsHash)`, the upstream stages hit and only the
 * tweaked stage and its descendants rerun.
 *
 * Opt-in by wrapping at pipeline-construction time. Production code that
 * runs each tile exactly once skips the wrapper and pays no cache cost.
 *
 * Cache is a bounded FIFO — `maxEntries` defaults to 32 (enough for
 * iterative slider use; not enough to leak memory on long sessions).
 * Hash strategies are consumer-supplied for the same reason as `withTrace`.
 */

import type { Transformer } from "./transformer.ts";

export interface MemoStats {
  hits: number;
  misses: number;
  size: number;
}

export interface MemoizedTransformer<TIn, TOut, TParams>
  extends Transformer<TIn, TOut, TParams> {
  stats(): MemoStats;
  clear(): void;
}

export function memoize<TIn, TOut, TParams>(
  transformer: Transformer<TIn, TOut, TParams>,
  hashInput: (state: TIn) => number,
  hashParams: (params: TParams) => number,
  maxEntries = 32,
): MemoizedTransformer<TIn, TOut, TParams> {
  const cache = new Map<string, TOut>();
  let hits = 0;
  let misses = 0;

  const wrapped = ((state, seed, params) => {
    const key = `${hashInput(state)}|${seed >>> 0}|${hashParams(params)}`;
    const cached = cache.get(key);
    if (cached !== undefined) {
      hits++;
      // Refresh LRU position by re-inserting.
      cache.delete(key);
      cache.set(key, cached);
      return cached;
    }
    misses++;
    const out = transformer(state, seed, params);
    cache.set(key, out);
    if (cache.size > maxEntries) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    return out;
  }) as MemoizedTransformer<TIn, TOut, TParams>;

  wrapped.stats = () => ({ hits, misses, size: cache.size });
  wrapped.clear = () => {
    cache.clear();
    hits = 0;
    misses = 0;
  };
  return wrapped;
}
