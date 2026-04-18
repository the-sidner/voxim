/**
 * setJobCraftAtWorkbench — emits a craftAtWorkbench job with the given
 * workbench type and input list. The job handler drives the full approach
 * → place → hit sequence.
 *
 * Static-config form (hand-authored BT): the spec carries workbenchType and
 * inputs directly. The W3 dispatcher uses a dynamic variant that pulls the
 * params from the NPC's current CraftingPlan step — see that phase for how
 * the same job shape is wired under planner-driven control.
 */
import type { BTNode, BTNodeFactory, BTContext, BTOutput, NodeResult } from "../behavior_tree.ts";

interface SetJobCraftAtWorkbenchSpec {
  type: "set_job_craft_at_workbench";
  workbenchType: string;
  inputs: Array<{ itemType: string; quantity: number }>;
  /** Tick-expiry override; defaults to currentTick + 600 (30s at 20 Hz). */
  expiryTicks?: number;
}

export const setJobCraftAtWorkbenchFactory: BTNodeFactory = {
  id: "set_job_craft_at_workbench",
  build(spec: unknown): BTNode {
    const s = spec as SetJobCraftAtWorkbenchSpec;
    if (typeof s.workbenchType !== "string" || s.workbenchType === "") {
      throw new Error(`set_job_craft_at_workbench: "workbenchType" must be a non-empty string`);
    }
    if (!Array.isArray(s.inputs)) {
      throw new Error(`set_job_craft_at_workbench: "inputs" must be an array`);
    }
    const inputs = s.inputs.map((inp) => ({ itemType: inp.itemType, quantity: inp.quantity }));
    const expiryTicks = s.expiryTicks ?? 600;

    return {
      tick(ctx: BTContext, out: BTOutput): NodeResult {
        out.replaceCurrent = {
          type: "craftAtWorkbench",
          workbenchType: s.workbenchType,
          inputs,
          workbenchId: null,
          phase: "approach",
          expiresAt: ctx.currentTick + expiryTicks,
        };
        return "success";
      },
    };
  },
};
