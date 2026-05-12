// @voxim/levelgen — typed transformer pipeline for level generation.
// Pure infrastructure: pipeline composition, seed splitting, registry,
// tracing, memoization. No algorithms. Consumed by atlas and tile-server.

export type { Transformer, Stage } from "./src/transformer.ts";
export { bindStage, pipe } from "./src/transformer.ts";

export { splitSeed, hashString } from "./src/seed.ts";

export { TransformerRegistry } from "./src/registry.ts";

export type { TraceEvent, TraceSink } from "./src/trace.ts";
export { withTrace } from "./src/trace.ts";

export type { MemoStats, MemoizedTransformer } from "./src/memoize.ts";
export { memoize } from "./src/memoize.ts";
