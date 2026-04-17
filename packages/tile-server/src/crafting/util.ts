/**
 * Shared helpers for recipe step handlers and the CraftingSystem.
 *
 * `resolveRecipe` is the common payoff path: consume buffer inputs, spawn the
 * output item, emit CraftingCompleted, and clear the active recipe. Used by
 * attack / assembly / time step handlers.
 */
import type { World, EntityId } from "@voxim/engine";
import { TileEvents } from "@voxim/protocol";
import type { Recipe } from "@voxim/content";
import type { EventEmitter } from "../system.ts";
import { WorkstationBuffer } from "../components/building.ts";
import type { WorkstationBufferData } from "../components/building.ts";
import {
  consumeFromBuffer,
  spawnOutputNear,
} from "../systems/crafting.ts";

export function resolveRecipe(
  world: World,
  events: EventEmitter,
  stationId: EntityId,
  buffer: WorkstationBufferData,
  recipe: Recipe,
  crafterId: EntityId | null,
): void {
  const newSlots = consumeFromBuffer(buffer.slots, recipe.inputs);
  world.set(stationId, WorkstationBuffer, {
    ...buffer,
    slots: newSlots,
    activeRecipeId: null,
    progressTicks: null,
  });
  spawnOutputNear(world, stationId, recipe.outputType, recipe.outputQuantity);
  events.publish(TileEvents.CraftingCompleted, {
    crafterId: crafterId ?? stationId,
    recipeId: recipe.id,
  });
}

export function toolMatches(weaponToolType: string | null | undefined, requiredTool: string | null | undefined): boolean {
  if (!requiredTool) return true;
  return weaponToolType === requiredTool;
}
