/**
 * Per-stage transformer lookup.
 *
 * A stage with multiple competing implementations (e.g. segmentation by
 * Voronoi vs. WFC) registers each one under a stable id. The orchestrator
 * picks one by id at pipeline-construction time. This is the pluggability
 * seam — adding a new implementation is a `register()` call, not a switch
 * statement in the orchestrator.
 *
 * Wraps `@voxim/engine`'s generic `Registry` rather than reinventing it;
 * the engine class already handles dup-detection and unknown-id errors.
 */

import { Registry } from "@voxim/engine";
import type { Transformer } from "./transformer.ts";

interface Entry<TIn, TOut, TParams> {
  id: string;
  transformer: Transformer<TIn, TOut, TParams>;
}

export class TransformerRegistry<TIn, TOut, TParams> {
  private inner = new Registry<Entry<TIn, TOut, TParams>>();

  register(id: string, transformer: Transformer<TIn, TOut, TParams>): void {
    this.inner.register({ id, transformer });
  }

  get(id: string): Transformer<TIn, TOut, TParams> {
    return this.inner.get(id).transformer;
  }

  has(id: string): boolean {
    return this.inner.has(id);
  }

  ids(): string[] {
    return this.inner.ids();
  }
}
