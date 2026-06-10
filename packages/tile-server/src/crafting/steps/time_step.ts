/**
 * Time step — timer-based recipes that auto-start when inputs land in the
 * buffer. The countdown + completion is no longer here: it is a
 * `crafting_timer` Resource on the workstation entity (T-238f) ticked by
 * ResourceSystem, whose `cross@0` threshold fires the `resolve_recipe`
 * effect. This handler owns only the start half:
 *
 *   - station idle (no running `crafting_timer`), slots present, inputs
 *     match a time recipe for this station → seed the timer Resource with
 *     `recipe.ticks` and bind `activeRecipeId`.
 *
 * "Idle" = no `crafting_timer` value > 0. A finished timer parks at 0
 * (Resource bounds.min); starting a new cook overwrites it.
 */
import type { RecipeStepHandler, RecipeTickContext } from "../step_handler.ts";
import { WorkstationBuffer } from "../../components/building.ts";
import { Resource } from "../../components/resource.ts";
import { upsertResourceKey } from "../../resources/mutate.ts";
import { findMatchingRecipe } from "../../systems/crafting.ts";
import { createLogger } from "../../logger.ts";

const log = createLogger("TimeStep");

export const timeStep: RecipeStepHandler = {
  id: "time",
  onTick(ctx: RecipeTickContext): void {
    const { world, stationId, stationType, buffer, content } = ctx;

    // Busy iff a countdown is still running on this station.
    const timer = world.get(stationId, Resource)?.values.crafting_timer;
    if (timer && timer.value > 0) return;

    if (buffer.slots.length === 0) return;
    const match = findMatchingRecipe(content, stationType, "time", buffer.slots);
    if (!match) return;

    // Composing upsert (T-249); creates Resource on a fresh station.
    upsertResourceKey(world, stationId, "crafting_timer", match.recipe.ticks, match.recipe.ticks);
    world.set(stationId, WorkstationBuffer, { ...buffer, activeRecipeId: match.recipe.id });
    log.info(
      "time-recipe started: station=%s recipe=%s ticks=%d",
      stationId, match.recipe.id, match.recipe.ticks,
    );
  },
};
