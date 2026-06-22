/**
 * Built-in interaction handlers for the common interactable entity categories.
 *
 * Each handler declares which component presence identifies the entity type
 * and what to do on click.  Hover outlining is no longer a handler concern —
 * it's driven entirely by `outlineCategoryFor` in render/hover_outline.ts,
 * which keeps the rule "what is highlighted" co-located with the visual.
 *
 * Register all three in game.ts after constructing InteractionSystem:
 *   interactionSystem.register(workstationHandler);
 *   interactionSystem.register(resourceNodeHandler);
 *   interactionSystem.register(groundItemHandler);
 */
import type { EntityInteractionHandler } from "./types.ts";

/**
 * Crafting stations (workbench, forge, anvil, furnace, campfire, …).
 * Identified by the `workstationBuffer` networked component. Click opens
 * the workstation panel for that entity, gated on the player being within
 * `interactionRange` blocks.
 */
export function makeWorkstationHandler(
  open: (entityId: string) => void,
): EntityInteractionHandler {
  return {
    id: "workstation",
    priority: 10,
    interactionRange: 3,
    canHandle: (t) => t.entityState.workstationBuffer !== undefined,
    onClick: (t) => { open(t.entityId); return true; },
  };
}

/**
 * Trader NPCs. Identified by the `traderInventory` networked component. Click
 * opens the trade panel for that entity, gated on the player being within
 * `interactionRange` blocks (the server enforces `trade.rangeWorldUnits` too).
 */
export function makeTraderHandler(
  open: (entityId: string) => void,
): EntityInteractionHandler {
  return {
    id: "trader",
    priority: 10,
    interactionRange: 3,
    canHandle: (t) => t.entityState.traderInventory !== undefined,
    onClick: (t) => { open(t.entityId); return true; },
  };
}

/**
 * Hiring workbench (job board). Identified by the `jobBoard` networked
 * component (T-076). A job_board is a workbench-type prefab, so it also carries
 * `workstationBuffer` and would otherwise match the workstation handler — this
 * handler's higher priority (11 > 10) ensures the job-board panel wins. Click
 * opens the panel, gated on the player being within `interactionRange` blocks.
 */
export function makeJobBoardHandler(
  open: (entityId: string) => void,
): EntityInteractionHandler {
  return {
    id: "job_board",
    priority: 11,
    interactionRange: 3,
    canHandle: (t) => t.entityState.jobBoard !== undefined,
    onClick: (t) => { open(t.entityId); return true; },
  };
}

/**
 * Harvestable resource nodes — trees, rocks, ore veins, bushes, etc.
 * Identified by the "resource_node" networked component.
 * Gathering is driven by the server via the interact action; click falls through.
 */
export const resourceNodeHandler: EntityInteractionHandler = {
  id: "resource_node",
  priority: 5,
  interactionRange: 3,
  canHandle: (t) => t.entityState.raw.has("resource_node"),
  onClick: () => false,
};

/**
 * Items lying on the ground.
 * Identified by the "itemData" networked component.  Click sends a PickUp
 * command via the supplied callback; the server enforces the same range
 * configured in game_config.items.pickupRadius regardless of the
 * client-side `interactionRange` here.
 */
export function makeGroundItemHandler(
  pickup: (entityId: string) => void,
): EntityInteractionHandler {
  return {
    id: "ground_item",
    priority: 8,
    interactionRange: 2.5,
    canHandle: (t) => t.entityState.raw.has("itemData"),
    onClick: (t) => { pickup(t.entityId); return true; },
  };
}
