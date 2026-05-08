/**
 * Assembly step — the player must have explicitly selected the recipe
 * (buffer.activeRecipeId is set). On hit, if the selected recipe is an
 * assembly recipe for this station and its inputs + tool match, resolve.
 * Otherwise skip and let the attack step try.
 */
import type { RecipeStepHandler, RecipeHitContext } from "../step_handler.ts";
import { tryAssignRoles } from "../../systems/crafting.ts";
import { resolveRecipe, toolMatches } from "../util.ts";
import { createLogger } from "../../logger.ts";

const log = createLogger("AssemblyStep");

const ID = "assembly";

export const assemblyStep: RecipeStepHandler = {
  id: ID,
  onHit(ctx: RecipeHitContext): void {
    if (!ctx.buffer.activeRecipeId) return;
    const recipe = ctx.content.recipes.get(ctx.buffer.activeRecipeId);
    if (!recipe) return;
    if ((recipe.stepType ?? "time") !== ID) return;
    if (recipe.stationType !== ctx.stationType) return;
    if (!toolMatches(ctx.hit.weaponStats.toolType, recipe.requiredTools)) return;

    const assignment = tryAssignRoles(recipe, ctx.buffer.slots, ctx.content);
    if (!assignment) return;

    resolveRecipe(ctx.world, ctx.content, ctx.events, ctx.stationId, ctx.buffer, { recipe, assignment }, ctx.hit.attackerId);
    log.info(
      "assembled: attacker=%s station=%s recipe=%s outputs=[%s]",
      ctx.hit.attackerId, ctx.stationId, recipe.id,
      recipe.outputs.map((o) => `${o.itemType}x${o.quantity}`).join(", "),
    );
  },
};
