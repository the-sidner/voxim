/**
 * Repair step (T-088) — restores durability to a worn item instead of producing
 * a new one. On a hit at the right station, with a `stepType: "repair"` recipe
 * selected: find the unique, Durability-bearing item in the buffer that's below
 * max, verify + consume the recipe's material inputs, and add `repairAmount` to
 * the item's `remaining` (capped at max). The item is kept — only the materials
 * are consumed — so a degraded sword left on the anvil with an iron ingot and a
 * hammer-swing comes back stronger, and repeated repairs compound the ingot cost.
 *
 * "Appropriate workstation" (anvil for metal, workbench for wood) is expressed
 * by the recipe's `stationType` + which material it asks for; the handler itself
 * is item-agnostic.
 */
import { TileEvents } from "@voxim/protocol";
import type { RecipeStepHandler, RecipeHitContext } from "../step_handler.ts";
import { tryAssignRoles, consumeFromBuffer } from "../../systems/crafting.ts";
import { toolMatches } from "../util.ts";
import { Durability } from "../../components/instance.ts";
import { WorkstationBuffer } from "../../components/building.ts";
import { createLogger } from "../../logger.ts";

const log = createLogger("RepairStep");
const ID = "repair";

export const repairStep: RecipeStepHandler = {
  id: ID,
  onHit(ctx: RecipeHitContext): void {
    if (!ctx.buffer.activeRecipeId) return;
    const recipe = ctx.content.recipes.get(ctx.buffer.activeRecipeId);
    if (!recipe || (recipe.stepType ?? "time") !== ID) return;
    if (recipe.stationType !== ctx.stationType) return;
    if (!toolMatches(ctx.hit.weaponStats.toolType, recipe.requiredTools)) return;

    // The item to repair: the first unique buffer item carrying Durability below
    // its max. (Recipe inputs are materials only, so role-assignment never claims it.)
    let itemId: string | null = null;
    for (const slot of ctx.buffer.slots) {
      if (slot?.kind !== "unique") continue;
      const dur = ctx.world.get(slot.entityId, Durability);
      if (dur && dur.remaining < dur.max) { itemId = slot.entityId; break; }
    }
    if (!itemId) return; // nothing worn enough to repair

    // Materials present? (assigns recipe input roles to the stack slots.)
    const assignment = tryAssignRoles(recipe, ctx.buffer.slots, ctx.content);
    if (!assignment) return;

    const dur = ctx.world.get(itemId, Durability)!;
    const restored = Math.min(dur.max, dur.remaining + (recipe.repairAmount ?? 0));
    if (restored <= dur.remaining) return; // recipe restores nothing — don't eat materials

    const newSlots = consumeFromBuffer(ctx.world, ctx.buffer.slots, recipe, assignment);
    ctx.world.set(itemId, Durability, { ...dur, remaining: restored });
    ctx.world.set(ctx.stationId, WorkstationBuffer, { ...ctx.buffer, slots: newSlots, activeRecipeId: null });

    ctx.events.publish(TileEvents.CraftingCompleted, { crafterId: ctx.hit.attackerId, recipeId: recipe.id });
    log.info("repaired: item=%s +%d → %d/%d station=%s recipe=%s",
      itemId, restored - dur.remaining, restored, dur.max, ctx.stationId, recipe.id);
  },
};
