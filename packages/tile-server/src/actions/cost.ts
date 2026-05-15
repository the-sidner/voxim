/**
 * StaminaCostHandler (T-229) — the dispatcher's `CostHandler`.
 *
 * Action `costs` are a resource→amount map. Today the only live resource is
 * `stamina`; an action that can't afford its costs fails its `canStart`
 * check (preconditions + costs) and never begins. Other cost resources
 * (health, mana, …) become real with the Resources arc (T-238) — until
 * then they're treated as free, so authoring them now is forward-safe.
 *
 * Wiring this makes every existing `costs.stamina` (swings, dodge) actually
 * spend stamina — previously inert because no handler was injected.
 */

import type { World, EntityId } from "@voxim/engine";
import { staminaValue, spendStamina } from "../combat/helpers.ts";
import type { CostHandler } from "./dispatcher.ts";

export const StaminaCostHandler: CostHandler = {
  affordable(world: World, entityId: EntityId, costs: Record<string, number>): boolean {
    const need = costs.stamina ?? 0;
    if (need <= 0) return true;
    return staminaValue(world, entityId) >= need;
  },
  deduct(world: World, entityId: EntityId, costs: Record<string, number>): void {
    const need = costs.stamina ?? 0;
    if (need > 0) spendStamina(world, entityId, need);
  },
};
