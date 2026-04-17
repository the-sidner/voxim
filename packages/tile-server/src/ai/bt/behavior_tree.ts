/**
 * Behavior tree core — node interface, context, output, and spec builder.
 *
 * BT evaluates top-to-bottom each tick. Nodes are stateless: each tick starts
 * from the root; no cross-tick "running" state. Composite nodes (sequence,
 * selector) short-circuit on the usual rules. Action leaves write to
 * `BTOutput` (queue transitions); the NpcAiSystem reads the output after
 * evaluation and applies it.
 *
 * Adding a new node type:
 *   1. Implement `BTNodeFactory` in a file under `nodes/`.
 *   2. Register it in `bt/mod.ts` via `registerBuiltinBTNodes(...)`.
 *   3. Use its `type` string in any behavior tree JSON.
 *
 * Validated at startup by `buildBehaviorTree`: unknown node `type` throws.
 */
import type { World, EntityId } from "@voxim/engine";
import type { ContentStore, GameConfig } from "@voxim/content";
import type { SpatialGrid } from "../../spatial_grid.ts";
import type { Job, NpcJobQueueData, NpcPlanData } from "../../components/npcs.ts";
import type { NpcTuning } from "../job_handler.ts";

export type NodeResult = "success" | "failure";

export interface BTContext {
  readonly world: World;
  readonly spatial: SpatialGrid;
  readonly content: ContentStore;
  readonly currentTick: number;
  readonly entityId: EntityId;
  readonly pos: { readonly x: number; readonly y: number };
  readonly tuning: NpcTuning;
  readonly defaults: GameConfig["npcAiDefaults"];

  /** Current entity state, read eagerly before BT evaluation. */
  readonly hunger: number;
  readonly thirst: number;
  readonly healthCurrent: number;
  readonly healthMax: number;
  /** Snapshot of queue at BT entry. Action nodes MUST write to BTOutput, not mutate this. */
  readonly queue: NpcJobQueueData;
}

/**
 * Mutable sink for BT action nodes. After BT evaluation, NpcAiSystem reads
 * this to apply the requested transition — at most one of the fields is
 * meaningful per tick.
 */
export interface BTOutput {
  /** Replace queue.current with this job for next tick. */
  replaceCurrent?: Job;
  /**
   * Set queue.plan to a cooldown plan (empty steps, given expiry) to throttle
   * repeated scans. Used by aggro-scan-with-no-target.
   */
  cooldownPlan?: NpcPlanData;
}

export interface BTNode {
  tick(ctx: BTContext, out: BTOutput): NodeResult;
}

/**
 * One BT node factory. `id` matches the `type` string in the JSON spec and
 * is unique in the registry. `build` takes the raw JSON spec and recursively
 * builds composite children via the `buildChild` callback.
 */
export interface BTNodeFactory {
  readonly id: string;
  build(spec: unknown, buildChild: (child: unknown) => BTNode): BTNode;
}

/**
 * Build a full behavior tree from its JSON spec. Throws on unknown node types.
 */
export function buildBehaviorTree(
  spec: unknown,
  registry: import("@voxim/engine").Registry<BTNodeFactory>,
): BTNode {
  const build = (s: unknown): BTNode => {
    if (s === null || typeof s !== "object") {
      throw new Error(`BT spec must be an object, got ${typeof s}`);
    }
    const type = (s as { type?: unknown }).type;
    if (typeof type !== "string") {
      throw new Error(`BT spec missing "type" field: ${JSON.stringify(s)}`);
    }
    const factory = registry.get(type);
    return factory.build(s, build);
  };
  return build(spec);
}
