/**
 * tryProduce — BT node with a static (JSON-configured) production target.
 * Delegates to dispatchProduce for the per-tick planner invocation and
 * step-to-sub-job translation. W5's execute_assigned_job uses the same
 * helper but with a target pulled dynamically from a JobBoard entry.
 *
 * Returns:
 *   success when the goal is already met or a sub-job was emitted
 *   failure when the planner cannot find any path (selector falls through)
 */
import type { BTNode, BTNodeFactory, BTContext, BTOutput, NodeResult } from "../behavior_tree.ts";
import { dispatchProduce } from "../../produce_dispatch.ts";

interface TryProduceSpec {
  type: "try_produce";
  targetItem: string;
  quantity?: number;
  /** Range in world units used to test "nearby resource node of this type". */
  gatherScanRadius?: number;
}

const DEFAULT_QUANTITY = 1;
const DEFAULT_SCAN_RADIUS = 64;

export const tryProduceFactory: BTNodeFactory = {
  id: "try_produce",
  build(spec: unknown): BTNode {
    const s = spec as TryProduceSpec;
    if (typeof s.targetItem !== "string" || s.targetItem === "") {
      throw new Error(`try_produce: "targetItem" must be a non-empty string`);
    }
    const targetItem = s.targetItem;
    const quantity   = s.quantity         ?? DEFAULT_QUANTITY;
    const scanRadius = s.gatherScanRadius ?? DEFAULT_SCAN_RADIUS;

    return {
      tick(ctx: BTContext, out: BTOutput): NodeResult {
        const outcome = dispatchProduce(
          ctx.world, ctx.content, ctx.entityId,
          ctx.pos.x, ctx.pos.y,
          ctx.queue.current,
          targetItem, quantity,
          scanRadius, ctx.currentTick,
        );
        switch (outcome.kind) {
          case "alreadyHave":
          case "unreachable":
            return "failure";
          case "sameAsCurrent":
            return "success";
          case "emit":
            out.replaceCurrent = outcome.job;
            return "success";
        }
      },
    };
  },
};
