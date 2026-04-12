/**
 * ModelRef — ECS component carried by renderable entities.
 *
 * Entities carry a lean ModelRef (ID + scale) rather than the full
 * ModelDefinition.  The client resolves modelId against the ContentStore
 * to obtain voxels and sub-objects for geometry baking.
 *
 * The server attaches this component at entity creation so that clients
 * can render all entities generically without hard-coded model lookups.
 */
import { defineComponent } from "@voxim/engine";
import { modelRefCodec } from "@voxim/codecs";
import type { ModelRefData } from "./types.ts";

export type { ModelRefData };

export const ModelRef = defineComponent({
  name: "modelRef" as const,
  networked: false,
  codec: modelRefCodec,
  default: (): ModelRefData => ({
    modelId: "",
    scaleX: 1.0,
    scaleY: 1.0,
    scaleZ: 1.0,
    seed: 0,
  }),
});
