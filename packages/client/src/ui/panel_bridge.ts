/**
 * Panel bridge — the world-entity → UI-signal mirror family.
 *
 * Each interactable panel (workstation / trader / job board / family chest)
 * has an `open*` entry point (range-gated, mirrors once, opens the panel) and
 * a `mirror*ToUi` snapshot function called again on every state message that
 * touches the open entity, so panels stay purely reactive on uiState without
 * polling. The server re-checks reach (and dynasty/kind/capacity) on every
 * command, so a panel can never claim an interaction the server would refuse.
 */
import type { ClientWorld } from "../state/client_world.ts";
import type { ContentService } from "@voxim/content";
import { openPanel, patchUI, pushToast } from "./ui_store.ts";
import { humanizeItemType } from "./item_names.ts";

/** Interact reach in world units — mirrors the server-side reach check. */
const INTERACT_RANGE = 3;

/**
 * Range gate shared by all four open* entry points. `null` means the player's
 * own position is unknown (refuse silently — no toast); a boolean is the
 * actual reach verdict.
 */
function withinReach(
  world: ClientWorld,
  playerId: string | null,
  target: { x: number; y: number },
): boolean | null {
  const me = playerId ? world.get(playerId) : null;
  if (!me?.position) return null;
  const dx = me.position.x - target.x;
  const dy = me.position.y - target.y;
  return dx * dx + dy * dy <= INTERACT_RANGE * INTERACT_RANGE;
}

/**
 * Open the workstation panel for an entity. Refuses when the player is
 * outside the configured interact range — mirrors the server-side reach
 * check so the panel can never claim to interact with something the
 * server would refuse.
 */
export function openWorkstation(world: ClientWorld, playerId: string | null, entityId: string): void {
  const ws = world.get(entityId);
  if (!ws?.workstationBuffer || !ws.workstationTag || !ws.position) return;
  const reach = withinReach(world, playerId, ws.position);
  if (reach === null) return;
  if (!reach) {
    pushToast("Too far away", "warn");
    return;
  }
  mirrorWorkstationToUi(world, entityId);
  openPanel("workstation");
}

/**
 * Snapshot the open workstation's networked state into uiState so the panel
 * stays purely reactive on the signal. Called both on initial open and on
 * every state-message that touches the open station.
 */
export function mirrorWorkstationToUi(world: ClientWorld, entityId: string): void {
  const state = world.get(entityId);
  if (!state?.workstationBuffer || !state.workstationTag) return;
  patchUI({
    workstation: {
      entityId,
      stationType:    state.workstationTag.stationType,
      capacity:       state.workstationBuffer.capacity,
      slots:          state.workstationBuffer.slots.map((s) => {
        if (!s) return null;
        return s.kind === "stack"
          ? { kind: "stack" as const, itemType: s.itemType, quantity: s.quantity }
          : { kind: "unique" as const, entityId: s.entityId, prefabId: s.prefabId };
      }),
      activeRecipeId: state.workstationBuffer.activeRecipeId,
    },
  });
}

/**
 * Open the trade panel for a nearby trader NPC (T-075). Builds buy/sell offers
 * from the trader's networked `traderInventory.listings`: buy lists every
 * listing (with live stock), sell lists only the listings the player currently
 * holds. Both buttons dispatch the listing-slot index — the TraderSystem keys
 * buy and sell by the same slot.
 */
export function openTrader(
  world: ClientWorld,
  playerId: string | null,
  content: ContentService | null,
  entityId: string,
): void {
  const tr = world.get(entityId);
  if (!tr?.traderInventory || !tr.position) return;
  const reach = withinReach(world, playerId, tr.position);
  if (reach === null) return;
  if (!reach) {
    pushToast("Too far away", "warn");
    return;
  }
  mirrorTraderToUi(world, playerId, content, entityId);
  openPanel("trader");
}

/**
 * Snapshot a trader's catalogue + the player's coins/holdings into uiState.
 * Called on open and on every state-message touching the open trader or the
 * player entity, so the panel reflects stock + coin changes without polling.
 */
export function mirrorTraderToUi(
  world: ClientWorld,
  playerId: string | null,
  content: ContentService | null,
  entityId: string,
): void {
  const tr = world.get(entityId);
  if (!tr?.traderInventory) return;
  const me = playerId ? world.get(playerId) : null;

  const currency = content?.getGameConfig().trade.currencyItemType ?? "coins";
  const nameOf = humanizeItemType;

  // Tally stackable holdings by prefabId (coins + sellable goods are stacks).
  const held = new Map<string, number>();
  for (const s of me?.inventory?.slots ?? []) {
    if (s.kind === "stack") held.set(s.prefabId, (held.get(s.prefabId) ?? 0) + s.quantity);
  }

  const listings = tr.traderInventory.listings;
  patchUI({
    trader: {
      npcId: entityId,
      npcName: tr.name?.value ?? "Trader",
      playerCoins: held.get(currency) ?? 0,
      buyOffers: listings.map((l, slot) => ({
        slot, itemType: l.itemType, displayName: nameOf(l.itemType),
        priceCoin: l.buyPrice, stock: l.stock < 0 ? null : l.stock,
      })),
      sellOffers: listings.flatMap((l, slot) => {
        const have = held.get(l.itemType) ?? 0;
        return have < 1 ? [] : [{
          slot, itemType: l.itemType, displayName: nameOf(l.itemType),
          priceCoin: l.sellPrice, stock: have,
        }];
      }),
    },
  });
}

/**
 * Open the job-board panel for a nearby hiring workbench (T-076). The board
 * is a workbench-type prefab carrying the networked `jobBoard` component;
 * range-gated like the trader/workstation handlers.
 */
export function openJobBoard(world: ClientWorld, playerId: string | null, entityId: string): void {
  const jb = world.get(entityId);
  if (!jb?.jobBoard || !jb.position) return;
  const reach = withinReach(world, playerId, jb.position);
  if (reach === null) return;
  if (!reach) {
    pushToast("Too far away", "warn");
    return;
  }
  mirrorJobBoardToUi(world, entityId);
  openPanel("job_board");
}

/**
 * Snapshot the board's networked `jobBoard.pending` into uiState so the panel
 * stays purely reactive on the signal. Called on open and on every
 * state-message touching the open board (a job claimed/completed by an
 * assigned NPC). Read-only for v1 — no post/cancel commands yet.
 */
export function mirrorJobBoardToUi(world: ClientWorld, entityId: string): void {
  const jb = world.get(entityId);
  if (!jb?.jobBoard) return;
  patchUI({
    jobBoard: {
      entityId,
      stationName: jb.name?.value ?? "Job Board",
      jobs: jb.jobBoard.pending.map((j) => ({
        id: j.id,
        goal: j.goal,
        itemType: j.itemType,
        itemName: humanizeItemType(j.itemType),
        priority: j.priority,
        claimedBy: j.claimedBy,
      })),
    },
  });
}

/**
 * Open the deposit/withdraw panel for a nearby family chest (library/treasury,
 * T-077/T-078). Range-gated like the workstation/trader handlers; the server
 * re-checks reach (and dynasty/kind/capacity) on every deposit/withdraw, so
 * the panel can never claim an interaction the server would refuse.
 */
export function openContainer(world: ClientWorld, playerId: string | null, entityId: string): void {
  const ch = world.get(entityId);
  if (!ch?.container || !ch.position) return;
  const reach = withinReach(world, playerId, ch.position);
  if (reach === null) return;
  if (!reach) {
    pushToast("Too far away", "warn");
    return;
  }
  mirrorContainerToUi(world, entityId);
  openPanel("container");
}

/**
 * Snapshot the open chest's networked `container` slots into uiState so the
 * panel stays purely reactive. Each slot is an entity ref to a banked unique
 * item; its prefab id comes from the item entity's ItemData (streamed to the
 * owning dynasty's client via AoI). Called on open and on every state-message
 * touching the open chest, so deposits/withdrawals reflect without polling.
 */
export function mirrorContainerToUi(world: ClientWorld, entityId: string): void {
  const ch = world.get(entityId);
  if (!ch?.container) return;
  patchUI({
    container: {
      entityId,
      kind:     ch.container.kind,
      capacity: ch.container.capacity,
      slots:    ch.container.slots.map((s) => ({
        entityId: s.entityId,
        prefabId: world.get(s.entityId)?.itemData?.prefabId ?? "",
      })),
    },
  });
}
