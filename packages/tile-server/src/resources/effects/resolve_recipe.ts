/**
 * resolve_recipe resource effect (T-238f) — the crafting time-step payoff.
 *
 * A `cross@0` threshold on the workstation entity's `crafting_timer`
 * Resource fires this once the countdown hits zero (the Resource integrates
 * `rate -20/s` → exactly −1 per tick from the seeded `recipe.ticks`). It
 * does what the retired TimeStep "advance & resolve" loop did: re-derive
 * the role assignment against the *current* buffer (the player may have
 * added/removed items mid-cook) and either resolve the recipe (consume
 * inputs + spawn outputs + emit CraftingCompleted, via the shared
 * `resolveRecipe`) or abandon it if it no longer matches.
 *
 * The timer is left at rest at 0 (bounds.min) — `cross` only fires on
 * entry, so it does not re-fire while parked there; the TimeStep
 * auto-start overwrites `crafting_timer` with the next recipe's ticks when
 * a fresh input set lands. Auto-start (inputs → start) stays recipe logic
 * in time_step.ts; this effect owns only completion.
 */

import type { ResourceEffect } from "../effect.ts";
import { WorkstationBuffer } from "../../components/building.ts";
import { tryAssignRoles } from "../../systems/crafting.ts";
import { resolveRecipe } from "../../crafting/util.ts";
import { createLogger } from "../../logger.ts";

const log = createLogger("ResolveRecipe");

export const resolveRecipeEffect: ResourceEffect = {
  id: "resolve_recipe",
  resolve(ctx) {
    const { world, events, content, entityId: stationId } = ctx;

    const buffer = world.get(stationId, WorkstationBuffer);
    if (!buffer) return; // not a workstation (or destroyed) — nothing to do

    const recipe = buffer.activeRecipeId
      ? content.recipes.get(buffer.activeRecipeId)
      : null;
    if (!recipe) {
      // Stale / cleared active recipe — drop the binding, leave the timer
      // parked at 0 (idle).
      world.set(stationId, WorkstationBuffer, { ...buffer, activeRecipeId: null });
      return;
    }

    const assignment = tryAssignRoles(recipe, buffer.slots, content);
    if (!assignment) {
      // Inputs changed mid-cook and no longer match — abandon the cook.
      world.set(stationId, WorkstationBuffer, { ...buffer, activeRecipeId: null });
      return;
    }

    resolveRecipe(world, content, events, stationId, buffer, { recipe, assignment }, null);
    log.info(
      "time-recipe done: station=%s recipe=%s outputs=[%s]",
      stationId, recipe.id,
      recipe.outputs.map((o) => `${o.itemType}x${o.quantity}`).join(", "),
    );
  },
};
