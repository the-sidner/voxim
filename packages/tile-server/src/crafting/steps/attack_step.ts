/**
 * Attack step — player swings at the workstation with a matching tool.
 * On hit, find any recipe (stepType="attack") for this station whose inputs
 * are present in the buffer and whose required tool matches the weapon.
 * Resolve instantly on match.
 */
import type { RecipeStepHandler, RecipeHitContext } from "../step_handler.ts";
import { findMatchingRecipe } from "../../systems/crafting.ts";
import { resolveRecipe, toolMatches } from "../util.ts";
import { createLogger } from "../../logger.ts";

const log = createLogger("AttackStep");

export const attackStep: RecipeStepHandler = {
  id: "attack",
  onHit(ctx: RecipeHitContext): void {
    const recipe = findMatchingRecipe(ctx.content, ctx.stationType, "attack", ctx.buffer.slots);
    if (!recipe) return;
    if (!toolMatches(ctx.hit.weaponStats.toolType, recipe.requiredTools)) {
      log.debug(
        "attack: attacker=%s station=%s wrong tool=%s accepts=[%s]",
        ctx.hit.attackerId, ctx.stationId,
        ctx.hit.weaponStats.toolType ?? "none",
        recipe.requiredTools.join(", ") || "any",
      );
      return;
    }
    resolveRecipe(ctx.world, ctx.content, ctx.events, ctx.stationId, ctx.buffer, recipe, ctx.hit.attackerId);
    log.info(
      "crafted: attacker=%s station=%s recipe=%s outputs=[%s]",
      ctx.hit.attackerId, ctx.stationId, recipe.id,
      recipe.outputs.map((o) => `${o.itemType}x${o.quantity}`).join(", "),
    );
  },
};
