/**
 * Resource component (T-238) — every tick-scalar an entity carries.
 *
 * One component holds all of an entity's resources (`values[id] =
 * { value, max }`), matching `ActiveActions`' multi-slot shape so the
 * query + delta stay cheap. `ResourceSystem` is the only writer:
 * integrates each `ResourceDef.rate`, clamps to `[def.bounds.min, max]`
 * (max is per-entity — seeded at spawn, e.g. heritage-scaled stamina),
 * and dispatches threshold effects.
 *
 * Networked (T-262): the client HUD reads the local player's
 * stamina/hunger/thirst/poise from here. The per-tick delta churn is bounded
 * — `ResourceSystem` only emits a change when the integrated value actually
 * moves and isn't bound-clamped, so a rested actor (stamina/poise at max)
 * ships nothing. A continuously-drifting resource with no bound nearby
 * (hunger/thirst rising toward their thresholds) has no such fixpoint —
 * `nextVal !== prev` is true almost every tick just from float accumulation
 * — so `wireEquals` (T-363) additionally quantises each key to 0.1% of its
 * `max` (matching the HUD bar's `toFixed(1)`% rendering, `theme.css`'s
 * 120-300ms fill transition absorbs the coarser cadence) before comparing:
 * the committed `value` stays exact every tick (thresholds and affordability
 * checks always read the true number), only the wire delta is held back
 * until the drift crosses a bucket the client could actually see.
 * Installed at spawn (stamina/hunger/thirst/poise on actors) and by
 * start_buff (buff_timer) / workstations (crafting_timer).
 */

import { defineComponent } from "@voxim/engine";
import { ComponentType, networkedCodec } from "@voxim/protocol";
import type { ResourceData, ResourceValue } from "@voxim/codecs";

export type { ResourceData, ResourceValue };

/** 0.1% of a key's range — the HUD bar's rendered precision (`toFixed(1)` of a %). */
function quantizedBucket(v: ResourceValue): number {
  return v.max > 0 ? Math.round((v.value / v.max) * 1000) : v.value;
}

function resourceWireEqual(a: ResourceData, b: ResourceData): boolean {
  const aKeys = Object.keys(a.values);
  const bKeys = Object.keys(b.values);
  if (aKeys.length !== bKeys.length) return false;
  for (const id of aKeys) {
    const av = a.values[id];
    const bv = b.values[id];
    if (!bv) return false;
    if (av.max !== bv.max) return false;
    if (quantizedBucket(av) !== quantizedBucket(bv)) return false;
  }
  return true;
}

export const Resource = defineComponent({
  name: "resource" as const,
  wireId: ComponentType.resource,
  codec: networkedCodec<ResourceData>(ComponentType.resource),
  default: (): ResourceData => ({ values: {} }),
  wireEquals: resourceWireEqual,
});
