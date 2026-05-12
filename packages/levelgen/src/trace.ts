/**
 * Tracing wrapper for transformers.
 *
 * Atlas's inspector needs to see what each stage consumed, produced, how
 * long it took, and which params drove it. The tile-server does not.
 *
 * Rather than baking instrumentation into every Transformer, `withTrace`
 * wraps one and publishes a `TraceEvent` per invocation to a sink. The
 * underlying transformer remains pure. Production code uses transformers
 * raw; Atlas wraps before composing the pipeline.
 *
 * Input/output hashing is consumer-supplied because hash strategies are
 * domain-specific (Float32Array tile masks, plain JSON params, etc.) and
 * levelgen does not assume a shape.
 */

import type { Transformer } from "./transformer.ts";

export interface TraceEvent<TParams> {
  stageId: string;
  inputHash: number;
  outputHash: number;
  params: TParams;
  durationMs: number;
}

export type TraceSink<TParams = unknown> = (event: TraceEvent<TParams>) => void;

export function withTrace<TIn, TOut, TParams>(
  stageId: string,
  transformer: Transformer<TIn, TOut, TParams>,
  sink: TraceSink<TParams>,
  hashInput: (state: TIn) => number,
  hashOutput: (state: TOut) => number,
): Transformer<TIn, TOut, TParams> {
  return (state, seed, params) => {
    const inputHash = hashInput(state);
    const t0 = performance.now();
    const out = transformer(state, seed, params);
    const durationMs = performance.now() - t0;
    sink({
      stageId,
      inputHash,
      outputHash: hashOutput(out),
      params,
      durationMs,
    });
    return out;
  };
}
