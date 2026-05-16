/**
 * Shared helpers for recipe step handlers and the CraftingSystem.
 *
 * `resolveRecipe` is the common payoff path: consume buffer inputs, spawn the
 * output item, emit CraftingCompleted, and clear the active recipe. Used by
 * attack / assembly / time step handlers.
 */
import type { World, EntityId } from "@voxim/engine";
import { TileEvents } from "@voxim/protocol";
import type { ContentService } from "@voxim/content";
import type { EventEmitter } from "../system.ts";
import { WorkstationBuffer } from "../components/building.ts";
import type { WorkstationBufferData } from "../components/building.ts";
import {
  consumeFromBuffer,
  spawnOutputNear,
} from "../systems/crafting.ts";
import type { RecipeMatch } from "../systems/crafting.ts";

export function resolveRecipe(
  world: World,
  content: ContentService,
  events: EventEmitter,
  stationId: EntityId,
  buffer: WorkstationBufferData,
  match: RecipeMatch,
  crafterId: EntityId | null,
): void {
  // Spawn outputs *before* consuming so formulas can read the input slots'
  // prefab stats (the matcher's assignment maps each role to a slot index;
  // the same slots survive into spawnOutputNear).
  for (const output of match.recipe.outputs) {
    spawnOutputNear(world, content, stationId, output, match, buffer.slots);
  }
  const newSlots = consumeFromBuffer(world, buffer.slots, match.recipe, match.assignment);
  // chainNextRecipeId carries the chain forward: keep the buffer primed with
  // the next recipe id so attack/assembly swings or the time-step auto-start
  // can pick it up. Without a chain, the binding clears. The countdown is
  // a `crafting_timer` Resource now (T-238f) — it parks at 0 on its own.
  world.set(stationId, WorkstationBuffer, {
    ...buffer,
    slots: newSlots,
    activeRecipeId: match.recipe.chainNextRecipeId ?? null,
  });
  events.publish(TileEvents.CraftingCompleted, {
    crafterId: crafterId ?? stationId,
    recipeId: match.recipe.id,
  });
}

/**
 * `requiredTools` matches when the array is empty (any tool, including
 * unarmed) or when the weapon's toolType is in the list.
 */
export function toolMatches(weaponToolType: string | null | undefined, requiredTools: readonly string[]): boolean {
  if (requiredTools.length === 0) return true;
  if (!weaponToolType) return false;
  return requiredTools.includes(weaponToolType);
}
