/**
 * check_tick_interval (T-327) — success once every `intervalTicks` server
 * ticks, failure otherwise. Stateless (per the BT doctrine: "no cross-tick
 * running state") — the gate is a pure function of `ctx.currentTick`, no
 * component or scratch needed.
 *
 * Built for the training-dummy's fixed-cadence swing loop (a predictable
 * telegraph to practise blocks/dodges/i-frames against, T-327), but generic:
 * any tree can gate a `request_action` behind a metronome instead of a
 * reactive condition.
 *
 * Spec: { type: "check_tick_interval", intervalTicks: 40, offset?: 0 }
 */
import type { BTNode, BTNodeFactory, BTContext, NodeResult } from "../behavior_tree.ts";

export const checkTickIntervalFactory: BTNodeFactory = {
  id: "check_tick_interval",
  build(spec: unknown): BTNode {
    const s = spec as { intervalTicks?: unknown; offset?: unknown };
    if (typeof s.intervalTicks !== "number" || s.intervalTicks <= 0) {
      throw new Error(`check_tick_interval: "intervalTicks" must be a positive number, got ${s.intervalTicks}`);
    }
    const intervalTicks = s.intervalTicks;
    const offset = typeof s.offset === "number" ? s.offset : 0;
    return {
      tick(ctx: BTContext): NodeResult {
        return (ctx.currentTick + offset) % intervalTicks === 0 ? "success" : "failure";
      },
    };
  },
};
