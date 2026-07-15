/**
 * Built-in interaction handlers for the common interactable entity categories.
 *
 * Each handler declares which component presence identifies the entity type
 * and what to do on click.  Hover outlining is no longer a handler concern —
 * it's driven entirely by `outlineCategoryFor` in render/hover_outline.ts,
 * which keeps the rule "what is highlighted" co-located with the visual.
 *
 * `interactionRange` is threaded in at registration (game.ts, post-bootstrap)
 * from the SAME game_config values the server enforces on the corresponding
 * command — crafting.interactRange for stations/chests/boards/POIs,
 * trade.rangeWorldUnits for traders, items.pickupRadius for ground items —
 * never a hardcoded constant, so tuning the server value moves the client
 * gate with it. This range (checked in InteractionSystem.activateNearest) is
 * the ONE client-side reach gate; the server re-checks every command anyway.
 */
import type { EntityInteractionHandler } from "./types.ts";

/**
 * Crafting stations (workbench, forge, anvil, furnace, campfire, …).
 * Identified by the `workstationBuffer` networked component. Click opens
 * the workstation panel for that entity.
 */
export function makeWorkstationHandler(
  open: (entityId: string) => void,
  interactionRange: number,
): EntityInteractionHandler {
  return {
    id: "workstation",
    priority: 10,
    interactionRange,
    canHandle: (t) => t.entityState.workstationBuffer !== undefined,
    onClick: (t) => { open(t.entityId); return true; },
  };
}

/**
 * Family chests — the library (tomes) and treasury (gear), T-077/T-078.
 * Identified by the `container` networked component. Click opens the
 * deposit/withdraw panel for that entity (the server re-checks reach on
 * every command).
 */
export function makeContainerHandler(
  open: (entityId: string) => void,
  interactionRange: number,
): EntityInteractionHandler {
  return {
    id: "container",
    priority: 10,
    interactionRange,
    canHandle: (t) => t.entityState.container !== undefined,
    onClick: (t) => { open(t.entityId); return true; },
  };
}

/**
 * Trader NPCs. Identified by the `traderInventory` networked component. Click
 * opens the trade panel for that entity — range should be the server's own
 * `trade.rangeWorldUnits`, which gates every TradeBuy/TradeSell command.
 */
export function makeTraderHandler(
  open: (entityId: string) => void,
  interactionRange: number,
): EntityInteractionHandler {
  return {
    id: "trader",
    priority: 10,
    interactionRange,
    canHandle: (t) => t.entityState.traderInventory !== undefined,
    onClick: (t) => { open(t.entityId); return true; },
  };
}

/**
 * Hiring workbench (job board). Identified by the `jobBoard` networked
 * component (T-076). A job_board is a workbench-type prefab, so it also carries
 * `workstationBuffer` and would otherwise match the workstation handler — this
 * handler's higher priority (11 > 10) ensures the job-board panel wins.
 */
export function makeJobBoardHandler(
  open: (entityId: string) => void,
  interactionRange: number,
): EntityInteractionHandler {
  return {
    id: "job_board",
    priority: 11,
    interactionRange,
    canHandle: (t) => t.entityState.jobBoard !== undefined,
    onClick: (t) => { open(t.entityId); return true; },
  };
}

/**
 * Harvestable resource nodes — trees, rocks, ore veins, bushes, etc.
 * Identified by the "resource_node" networked component.
 * Gathering is driven by the server via the interact action; click falls through.
 */
export function makeResourceNodeHandler(
  interactionRange: number,
): EntityInteractionHandler {
  return {
    id: "resource_node",
    priority: 5,
    interactionRange,
    canHandle: (t) => t.entityState.raw.has("resource_node"),
    onClick: () => false,
  };
}

/**
 * Items lying on the ground.
 * Identified by the "itemData" networked component.  Click sends a PickUp
 * command via the supplied callback — range should be the server's own
 * `items.pickupRadius`, which gates the PickUp command.
 */
export function makeGroundItemHandler(
  pickup: (entityId: string) => void,
  interactionRange: number,
): EntityInteractionHandler {
  return {
    id: "ground_item",
    priority: 8,
    interactionRange,
    canHandle: (t) => t.entityState.itemData !== undefined,
    onClick: (t) => { pickup(t.entityId); return true; },
  };
}

/**
 * `action`/`puzzle` POI world props (chalice pedestal, signal brazier,
 * lever, …). Identified by the "poiInteractable" networked component
 * (T-212 v2). Click sends CommandType.UseEntity directly — these are
 * one-shot verbs ("drink"/"light"/"pull"), not inventory UIs, so no panel.
 */
export function makePoiInteractableHandler(
  use: (entityId: string) => void,
  interactionRange: number,
): EntityInteractionHandler {
  return {
    id: "poi_interactable",
    priority: 8,
    interactionRange,
    canHandle: (t) => t.entityState.poiInteractable !== undefined,
    onClick: (t) => { use(t.entityId); return true; },
  };
}
