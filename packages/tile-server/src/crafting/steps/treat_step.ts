/**
 * Treat step (T-009) — heals an injury on the *crafter* instead of producing or
 * repairing an item. On a swing at the recipe's station (alchemy/supernatural)
 * with a `stepType: "treat"` recipe selected and its materials present, consume
 * the materials and reduce the crafter's first `Injury` by one severity, removing
 * the entry at zero (and the whole component once the last injury clears). So a
 * deeply-broken leg takes several poultices — repeated treatment compounds the
 * material cost, mirroring repair (T-088).
 *
 * The patient is `ctx.hit.attackerId` (whoever swung). Injuries are applied by
 * the severe-hit roll in T-008; this is their cure.
 */
import { TileEvents } from "@voxim/protocol";
import type { RecipeStepHandler, RecipeHitContext } from "../step_handler.ts";
import { tryAssignRoles, consumeFromBuffer } from "../../systems/crafting.ts";
import { toolMatches } from "../util.ts";
import { Injury } from "../../components/injury.ts";
import { WorkstationBuffer } from "../../components/building.ts";
import { createLogger } from "../../logger.ts";

const log = createLogger("TreatStep");
const ID = "treat";

export const treatStep: RecipeStepHandler = {
  id: ID,
  onHit(ctx: RecipeHitContext): void {
    if (!ctx.buffer.activeRecipeId) return;
    const recipe = ctx.content.recipes.get(ctx.buffer.activeRecipeId);
    if (!recipe || (recipe.stepType ?? "time") !== ID) return;
    if (recipe.stationType !== ctx.stationType) return;
    if (!toolMatches(ctx.hit.weaponStats.toolType, recipe.requiredTools)) return;

    const patient = ctx.hit.attackerId;
    const injury = ctx.world.get(patient, Injury);
    if (!injury || injury.injuries.length === 0) return; // nothing to treat

    const assignment = tryAssignRoles(recipe, ctx.buffer.slots, ctx.content);
    if (!assignment) return; // materials missing

    const newSlots = consumeFromBuffer(ctx.world, ctx.buffer.slots, recipe, assignment);

    const [treated, ...rest] = injury.injuries;
    const nextSeverity = treated.severity - 1;
    const remaining = nextSeverity > 0 ? [{ ...treated, severity: nextSeverity }, ...rest] : rest;
    if (remaining.length > 0) ctx.world.set(patient, Injury, { injuries: remaining });
    else ctx.world.remove(patient, Injury);

    ctx.world.set(ctx.stationId, WorkstationBuffer, { ...ctx.buffer, slots: newSlots, activeRecipeId: null });
    ctx.events.publish(TileEvents.CraftingCompleted, { crafterId: patient, recipeId: recipe.id });
    log.info("treated: patient=%s injury=%s → severity=%d station=%s",
      patient, treated.typeId, nextSeverity, ctx.stationId);
  },
};
