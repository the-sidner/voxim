/**
 * equipment_stat rate modifier (T-238b; rewired T-239).
 *
 * Scales the running rate by a Status/Modifier `effective()` query —
 * `rate × effective(params.stat, base 1)`. The `equipment` ModifierSource
 * already composes worn-gear contributions live (e.g. `staminaRegen` as a
 * product of `1 − penalty` per slot), so this modifier no longer scans
 * Equipment itself: the per-consumer duplication is gone, one query path.
 * params: { stat: string }  (e.g. "staminaRegen").
 */

import type { ResourceRateModifier } from "../modifier.ts";
import { effective } from "../../modifiers/modifier.ts";

export const equipmentStatModifier: ResourceRateModifier = {
  id: "equipment_stat",
  rate(ctx, current) {
    const stat = ctx.params.stat;
    if (typeof stat !== "string") return current;
    return current * effective(
      ctx.sources,
      { world: ctx.world, content: ctx.content, entityId: ctx.entityId },
      stat,
      1,
    );
  },
};
