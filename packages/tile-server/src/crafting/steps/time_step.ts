/**
 * Time step — timer-based recipes that auto-start when inputs land in the
 * buffer, then complete when progressTicks reaches 0.
 *
 * Per tick:
 *   - If buffer has no active recipe and an input set matches a time recipe
 *     for this station, start the timer.
 *   - Otherwise decrement the timer; on reaching zero, resolve.
 */
import type { RecipeStepHandler, RecipeTickContext } from "../step_handler.ts";
import { WorkstationBuffer } from "../../components/building.ts";
import { findMatchingRecipe } from "../../systems/crafting.ts";
import { resolveRecipe } from "../util.ts";
import { createLogger } from "../../logger.ts";

const log = createLogger("TimeStep");

export const timeStep: RecipeStepHandler = {
  id: "time",
  onTick(ctx: RecipeTickContext): void {
    const { world, events, stationId, stationType, buffer, content } = ctx;

    // Auto-start: no recipe running, slots present, inputs match a time recipe.
    if (buffer.progressTicks === null) {
      if (buffer.slots.length === 0) return;
      const recipe = findMatchingRecipe(content, stationType, "time", buffer.slots);
      if (!recipe) return;
      world.set(stationId, WorkstationBuffer, {
        ...buffer,
        progressTicks: recipe.ticks,
        activeRecipeId: recipe.id,
      });
      log.info("time-recipe started: station=%s recipe=%s ticks=%d", stationId, recipe.id, recipe.ticks);
      return;
    }

    // Advance timer; on zero, resolve.
    if (buffer.progressTicks <= 0) return;
    const nextTicks = buffer.progressTicks - 1;
    if (nextTicks > 0) {
      world.set(stationId, WorkstationBuffer, { ...buffer, progressTicks: nextTicks });
      return;
    }

    const recipe = buffer.activeRecipeId ? content.getRecipe(buffer.activeRecipeId) : null;
    if (!recipe) {
      // Stale activeRecipeId — clear and continue.
      world.set(stationId, WorkstationBuffer, { ...buffer, progressTicks: null, activeRecipeId: null });
      return;
    }
    resolveRecipe(world, events, stationId, buffer, recipe, null);
    log.info(
      "time-recipe done: station=%s recipe=%s output=%sx%d",
      stationId, recipe.id, recipe.outputType, recipe.outputQuantity,
    );
  },
};
