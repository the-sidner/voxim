/**
 * Shared helpers for recipe step handlers and the CraftingSystem.
 *
 * `resolveRecipe` is the common payoff path: consume buffer inputs, spawn the
 * output item, emit CraftingCompleted, and clear the active recipe. Used by
 * attack / assembly / time step handlers.
 */
import type { World, EntityId } from "@voxim/engine";
import { TileEvents } from "@voxim/protocol";
import type { ContentStore, Recipe } from "@voxim/content";
import type { EventEmitter } from "../system.ts";
import { WorkstationBuffer } from "../components/building.ts";
import type { WorkstationBufferData } from "../components/building.ts";
import {
  consumeFromBuffer,
  spawnOutputNear,
} from "../systems/crafting.ts";

export function resolveRecipe(
  world: World,
  content: ContentStore,
  events: EventEmitter,
  stationId: EntityId,
  buffer: WorkstationBufferData,
  recipe: Recipe,
  crafterId: EntityId | null,
): void {
  const newSlots = consumeFromBuffer(buffer.slots, recipe.inputs);
  // chainNextRecipeId carries the chain forward: keep the buffer primed with
  // the next recipe id so attack/assembly swings or the time-step auto-start
  // can pick it up. Without a chain, both fields clear.
  world.set(stationId, WorkstationBuffer, {
    ...buffer,
    slots: newSlots,
    activeRecipeId: recipe.chainNextRecipeId ?? null,
    progressTicks: null,
  });
  for (const output of recipe.outputs) {
    spawnOutputNear(world, content, stationId, output.itemType, output.quantity);
  }
  events.publish(TileEvents.CraftingCompleted, {
    crafterId: crafterId ?? stationId,
    recipeId: recipe.id,
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
