/**
 * Assembly step — the player must have explicitly selected the recipe
 * (buffer.activeRecipeId is set). On hit, if the selected recipe is an
 * assembly recipe for this station and its inputs + tool match, resolve.
 * Otherwise skip and let the attack step try.
 */
import type { RecipeStepHandler, RecipeHitContext } from "../step_handler.ts";
import { recipeInputsMatch } from "../../systems/crafting.ts";
import { resolveRecipe, toolMatches } from "../util.ts";
import { createLogger } from "../../logger.ts";

const log = createLogger("AssemblyStep");

const ID = "assembly";

export const assemblyStep: RecipeStepHandler = {
  id: ID,
  onHit(ctx: RecipeHitContext): void {
    if (!ctx.buffer.activeRecipeId) return;
    const recipe = ctx.content.getRecipe(ctx.buffer.activeRecipeId);
    if (!recipe) return;
    if ((recipe.stepType ?? "time") !== ID) return;
    if (recipe.stationType !== ctx.stationType) return;
    if (!toolMatches(ctx.hit.weaponStats.toolType, recipe.requiredTool)) return;

    const bufferMap = new Map<string, number>();
    for (const s of ctx.buffer.slots) {
      if (s !== null) bufferMap.set(s.itemType, (bufferMap.get(s.itemType) ?? 0) + s.quantity);
    }
    if (!recipeInputsMatch(recipe.inputs, bufferMap)) return;

    resolveRecipe(ctx.world, ctx.events, ctx.stationId, ctx.buffer, recipe, ctx.hit.attackerId);
    log.info(
      "assembled: attacker=%s station=%s recipe=%s output=%sx%d",
      ctx.hit.attackerId, ctx.stationId, recipe.id, recipe.outputType, recipe.outputQuantity,
    );
  },
};
