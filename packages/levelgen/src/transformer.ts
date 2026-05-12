/**
 * Transformer pipeline primitives.
 *
 * A `Transformer<TIn, TOut, TParams>` is a pure function
 * `(state, seed, params) → state`. It is the unit of work in a generator:
 * one slice of `GenParams`, one sub-seed, one input → output transition.
 *
 * `bindStage` partially applies the seed and params, yielding a `Stage`
 * — a single-argument state transition that `pipe()` can compose by type.
 * Separating Transformer (config-bearing) from Stage (config-bound) keeps
 * the pipe combinator's type signatures readable: a piped pipeline is just
 * `Stage<A, Z>`, not an n-tuple of params.
 */

import { splitSeed } from "./seed.ts";

export type Transformer<TIn, TOut, TParams> = (
  state: TIn,
  seed: number,
  params: TParams,
) => TOut;

export type Stage<TIn, TOut> = (state: TIn) => TOut;

/**
 * Bind a transformer's params and a stage-local sub-seed (derived from the
 * global seed + stage id) into a single-argument Stage.
 *
 * The stage id is the deterministic discriminator for `splitSeed` — two
 * different ids in the same pipeline get independent RNG streams; the same
 * id in two runs with the same global seed gets the same stream.
 */
export function bindStage<TIn, TOut, TParams>(
  stageId: string,
  transformer: Transformer<TIn, TOut, TParams>,
  params: TParams,
  globalSeed: number,
): Stage<TIn, TOut> {
  const seed = splitSeed(globalSeed, stageId);
  return (state) => transformer(state, seed, params);
}

// Type-aware composition. Overloads go up to 10 stages — the current atlas
// tilemap pipeline has 9. Extend if more stages stack up. Each successive
// overload chains TOut of stage N into TIn of stage N+1; mismatches are
// compile errors at the pipe() call site.

export function pipe<A, B>(a: Stage<A, B>): Stage<A, B>;
export function pipe<A, B, C>(a: Stage<A, B>, b: Stage<B, C>): Stage<A, C>;
export function pipe<A, B, C, D>(
  a: Stage<A, B>, b: Stage<B, C>, c: Stage<C, D>,
): Stage<A, D>;
export function pipe<A, B, C, D, E>(
  a: Stage<A, B>, b: Stage<B, C>, c: Stage<C, D>, d: Stage<D, E>,
): Stage<A, E>;
export function pipe<A, B, C, D, E, F>(
  a: Stage<A, B>, b: Stage<B, C>, c: Stage<C, D>, d: Stage<D, E>,
  e: Stage<E, F>,
): Stage<A, F>;
export function pipe<A, B, C, D, E, F, G>(
  a: Stage<A, B>, b: Stage<B, C>, c: Stage<C, D>, d: Stage<D, E>,
  e: Stage<E, F>, f: Stage<F, G>,
): Stage<A, G>;
export function pipe<A, B, C, D, E, F, G, H>(
  a: Stage<A, B>, b: Stage<B, C>, c: Stage<C, D>, d: Stage<D, E>,
  e: Stage<E, F>, f: Stage<F, G>, g: Stage<G, H>,
): Stage<A, H>;
export function pipe<A, B, C, D, E, F, G, H, I>(
  a: Stage<A, B>, b: Stage<B, C>, c: Stage<C, D>, d: Stage<D, E>,
  e: Stage<E, F>, f: Stage<F, G>, g: Stage<G, H>, h: Stage<H, I>,
): Stage<A, I>;
export function pipe<A, B, C, D, E, F, G, H, I, J>(
  a: Stage<A, B>, b: Stage<B, C>, c: Stage<C, D>, d: Stage<D, E>,
  e: Stage<E, F>, f: Stage<F, G>, g: Stage<G, H>, h: Stage<H, I>,
  i: Stage<I, J>,
): Stage<A, J>;
export function pipe<A, B, C, D, E, F, G, H, I, J, K>(
  a: Stage<A, B>, b: Stage<B, C>, c: Stage<C, D>, d: Stage<D, E>,
  e: Stage<E, F>, f: Stage<F, G>, g: Stage<G, H>, h: Stage<H, I>,
  i: Stage<I, J>, j: Stage<J, K>,
): Stage<A, K>;
export function pipe(...stages: Array<Stage<unknown, unknown>>): Stage<unknown, unknown> {
  return (input) => stages.reduce<unknown>((s, stage) => stage(s), input);
}
