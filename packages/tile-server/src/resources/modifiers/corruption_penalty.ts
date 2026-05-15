/**
 * corruption_penalty rate modifier (T-238b).
 *
 * When the entity's corruption exposure is at/over `threshold`, scale the
 * running rate by `(1 − factor)` — the corruption→stamina-regen coupling.
 *
 * **Bridge:** reads the still-extant `CorruptionExposure` component. When
 * T-238e turns corruption into a `Resource`, this is replaced by a generic
 * `resource_gate` modifier (cross-resource scale) — a one-file swap, not
 * inline logic, because it is a registered closed `kind`.
 */

import type { ResourceRateModifier } from "../modifier.ts";
import { CorruptionExposure } from "../../components/world.ts";

export const corruptionPenaltyModifier: ResourceRateModifier = {
  id: "corruption_penalty",
  rate(ctx, current) {
    const threshold = ctx.params.threshold as number;
    const factor = ctx.params.factor as number;
    const level = ctx.world.get(ctx.entityId, CorruptionExposure)?.level ?? 0;
    return level >= threshold ? current * (1 - factor) : current;
  },
};
