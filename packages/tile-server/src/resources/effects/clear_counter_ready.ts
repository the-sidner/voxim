/**
 * clear_counter_ready resource effect (T-250) — the parrier's
 * `counter_window` Resource hits 0 (`cross@0`, the buff_timer / lifetime
 * shape) and the unconsumed `CounterReady` flag is dropped. The window is
 * re-armed (value reset to the full duration) on every parry, so a fresh
 * parry extends the window rather than stacking timers. If the counter is
 * consumed first (health_hit_handler removes CounterReady on the bonus hit),
 * this fires later as a harmless no-op remove of an absent component.
 */

import type { ResourceEffect } from "../effect.ts";
import { CounterReady } from "../../components/combat.ts";

export const clearCounterReadyEffect: ResourceEffect = {
  id: "clear_counter_ready",
  resolve(ctx) {
    ctx.world.remove(ctx.entityId, CounterReady);
  },
};
