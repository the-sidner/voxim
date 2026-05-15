/**
 * request_action — name a specific action for a slot (T-234).
 *
 * Spec: `{ "type": "request_action", "slot": "primary", "action": "swing_light" }`
 *
 * Writes the request into `BTOutput.requestedActions`; NpcAiSystem mirrors
 * it onto the entity's `RequestedActions` component and the dispatcher's
 * `RequestedActionIntentResolver` runs it on that slot. This is the
 * data-driven path for an NPC's signature moves — any action id, not just
 * the InputState-bit subset. Always succeeds (the request is advisory; the
 * dispatcher still enforces the action's own preconditions/costs).
 */
import type { BTNode, BTNodeFactory, BTContext, BTOutput, NodeResult } from "../behavior_tree.ts";

export const requestActionFactory: BTNodeFactory = {
  id: "request_action",
  build(spec: unknown): BTNode {
    const s = spec as { slot?: unknown; action?: unknown };
    if (typeof s.slot !== "string" || s.slot.length === 0) {
      throw new Error(`request_action: "slot" must be a non-empty string`);
    }
    if (typeof s.action !== "string" || s.action.length === 0) {
      throw new Error(`request_action: "action" must be a non-empty string`);
    }
    const slot = s.slot;
    const action = s.action;
    return {
      tick(_ctx: BTContext, out: BTOutput): NodeResult {
        (out.requestedActions ??= {})[slot] = action;
        return "success";
      },
    };
  },
};
