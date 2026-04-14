/**
 * Built-in interaction handlers for the common interactable entity categories.
 *
 * Each handler opts into the hover silhouette outline (showHoverOutline: true)
 * and declares which component presence identifies the entity type.  onClick
 * returns false so the click falls through to normal input handling; replace
 * with real behaviour once UI exists for that category.
 *
 * Register all three in game.ts after constructing InteractionSystem:
 *   interactionSystem.register(workstationHandler);
 *   interactionSystem.register(resourceNodeHandler);
 *   interactionSystem.register(groundItemHandler);
 */
import type { EntityInteractionHandler } from "./types.ts";

/**
 * Crafting stations (workbench, forge, anvil, furnace, campfire, …).
 * Identified by the "workstationBuffer" networked component.
 * TODO: onClick → open workbench UI.
 */
export const workstationHandler: EntityInteractionHandler = {
  id: "workstation",
  priority: 10,
  interactionRange: 4,
  showHoverOutline: true,
  canHandle: (t) => t.entityState.raw.has("workstationBuffer"),
  onClick: () => false,
};

/**
 * Harvestable resource nodes — trees, rocks, ore veins, bushes, etc.
 * Identified by the "resource_node" networked component.
 * Gathering is driven by the server via the interact action; click falls through.
 */
export const resourceNodeHandler: EntityInteractionHandler = {
  id: "resource_node",
  priority: 5,
  interactionRange: 3,
  showHoverOutline: true,
  canHandle: (t) => t.entityState.raw.has("resource_node"),
  onClick: () => false,
};

/**
 * Items lying on the ground.
 * Identified by the "itemData" networked component.
 * TODO: onClick → send pick-up command.
 */
export const groundItemHandler: EntityInteractionHandler = {
  id: "ground_item",
  priority: 8,
  interactionRange: 2,
  showHoverOutline: true,
  canHandle: (t) => t.entityState.raw.has("itemData"),
  onClick: () => false,
};
