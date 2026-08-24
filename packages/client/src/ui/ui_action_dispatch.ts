/**
 * UIAction dispatch — the single bridge between the UI layer and game logic.
 *
 * A Record keyed by `UIAction["type"]` (registry-dispatch, not a switch): the
 * mapped type forces one handler per union variant at compile time, so adding
 * a UIAction without a handler is a type error — the exhaustiveness the old
 * 30-case switch never had. Most handlers are a mechanical UIAction →
 * CommandType translation.
 */
import type { VoximGame } from "../game.ts";
import type { UIAction } from "./ui_actions.ts";
import { uiState, patchUI, closePanel } from "./ui_store.ts";
import { setDebugLayer } from "./debug_store.ts";
import { modeState } from "../input/context.ts";
import { CommandType, EQUIP_SLOT_NAMES } from "@voxim/protocol";
import type { EquipSlotIndex } from "@voxim/protocol";

type UIActionHandlers = {
  [K in UIAction["type"]]: (game: VoximGame, action: Extract<UIAction, { type: K }>) => void;
};

const handlers: UIActionHandlers = {
  // Re-enter the world after death (T-270). The session stayed open; the
  // server records the death (advancing the dynasty → heir) and spawns.
  respawn: (game) => {
    game._sendCommand({ cmd: CommandType.Respawn });
    closePanel("death");
  },

  dismiss_ritual: (game) => {
    game.ritualDismissed = true;
    patchUI({ heirRitual: null });
  },

  debug_toggle: (game, action) => {
    const on = game.toggleDebug(action.layer);
    setDebugLayer(action.layer, on);
  },

  debug_scene_census: (game) => {
    game.renderer?.logSceneCensus();
  },

  debug_give_item: (game, action) => {
    game._sendCommand({ cmd: CommandType.DebugGiveItem, itemType: action.itemType, quantity: action.quantity });
  },

  debug_spawn_npc: (game, action) => {
    game._sendCommand({ cmd: CommandType.DebugSpawnNpc, npcTemplate: action.npcTemplate, quantity: action.quantity });
  },

  debug_set_time: (game, action) => {
    game._sendCommand({ cmd: CommandType.DebugSetTime, hour: action.hour });
  },

  debug_teleport: (game, action) => {
    game._sendCommand({ cmd: CommandType.DebugTeleport, worldX: action.worldX, worldY: action.worldY });
  },

  debug_set_stat: (game, action) => {
    game._sendCommand({ cmd: CommandType.DebugSetStat, stat: action.stat, value: action.value });
  },

  debug_kill_entity: (game, action) => {
    game._sendCommand({ cmd: CommandType.DebugKillEntity, entityId: action.entityId });
  },

  debug_spawn_dummy: (game, action) => {
    game._sendCommand({ cmd: CommandType.DebugSpawnDummy, attackLoop: action.attackLoop });
  },

  debug_set_action_param: (game, action) => {
    game._sendCommand({
      cmd: CommandType.DebugSetActionParam,
      actionId: action.actionId,
      field: action.field,
      value: action.value,
    });
  },

  equip: (game, action) => {
    game._sendCommand({ cmd: CommandType.Equip, fromInventorySlot: action.fromSlot });
  },

  unequip: (game, action) => {
    const slotIndex = EQUIP_SLOT_NAMES.indexOf(action.slot as typeof EQUIP_SLOT_NAMES[number]);
    if (slotIndex !== -1) {
      game._sendCommand({ cmd: CommandType.Unequip, equipSlot: slotIndex as EquipSlotIndex });
    }
  },

  move_item: (game, action) => {
    game._sendCommand({ cmd: CommandType.MoveItem, fromSlot: action.fromSlot, toSlot: action.toSlot });
  },

  drop_item: (game, action) => {
    game._sendCommand({ cmd: CommandType.DropItem, fromSlot: action.fromSlot });
  },

  use_item: (game, action) => {
    game._sendCommand({ cmd: CommandType.UseItem, fromSlot: action.fromSlot });
  },

  // Internalise the Lore fragment carried by the tome in this inventory
  // slot (T-020 server substrate; first client wiring, T-072).
  read_tome: (game, action) => {
    game._sendCommand({ cmd: CommandType.Internalise, inventorySlot: action.fromSlot });
  },

  // Externalise a learned Lore fragment into a blank tome (T-019 server
  // substrate; first client wiring, T-360).
  write_tome: (game, action) => {
    game._sendCommand({ cmd: CommandType.Externalise, fragIndex: action.fragIndex });
  },

  load_workstation: (game, action) => {
    game._sendCommand({
      cmd: CommandType.LoadWorkstation,
      inventorySlot: action.inventorySlot,
      bufferSlot: action.bufferSlot,
    });
  },

  take_workstation: (game, action) => {
    game._sendCommand({
      cmd: CommandType.TakeWorkstation,
      bufferSlot: action.bufferSlot,
    });
  },

  deposit_container: (game, action) => {
    game._sendCommand({
      cmd: CommandType.ContainerDeposit,
      containerId: action.containerId,
      fromInventorySlot: action.inventorySlot,
    });
  },

  withdraw_container: (game, action) => {
    game._sendCommand({
      cmd: CommandType.ContainerWithdraw,
      containerId: action.containerId,
      slotIndex: action.slotIndex,
    });
  },

  select_recipe: (game, action) => {
    game._sendCommand({ cmd: CommandType.SelectRecipe, recipeId: action.recipeId });
  },

  // Server uses forward-facing placement for kit items, so worldX/worldY
  // are ignored — we send 0/0 to satisfy the codec without a cursor pick.
  deploy_item: (game, action) => {
    console.log(`[Deploy] sending Place from inventory slot=${action.fromSlot}`);
    game._sendCommand({
      cmd: CommandType.Place,
      source: "inventory",
      fromInventorySlot: action.fromSlot,
      worldX: 0,
      worldY: 0,
    });
  },

  place_blueprint: (game, action) => {
    console.log(`[Build] sending Place prefab=${action.structureType} world=(${action.worldX.toFixed(1)},${action.worldY.toFixed(1)})`);
    game._sendCommand({
      cmd: CommandType.Place,
      source: "prefab",
      prefabId: action.structureType,
      worldX: action.worldX,
      worldY: action.worldY,
    });
  },

  open_build_menu: (_game, action) => {
    console.log(`[Build] opening radial menu at canvas=(${action.canvasX.toFixed(0)},${action.canvasY.toFixed(0)})`);
    patchUI({ radialMenu: { x: action.canvasX, y: action.canvasY } });
  },

  select_blueprint: (game, action) => {
    console.log(`[Build] selected blueprint type=${action.structureType}`);
    patchUI({ selectedBlueprint: action.structureType, radialMenu: null });
    const prefab = game.contentService?.prefabs.get(action.structureType);
    const placeable = prefab?.components.placeable as { tool?: "single" | "line" } | undefined;
    const tool = placeable?.tool ?? "single";
    const bld = game.contentService?.getGameConfig().building;
    modeState.value = {
      kind: "build",
      blueprintId: action.structureType,
      brush: {
        tool,
        voxelSize: bld?.defaultVoxelSize ?? 1.0,
        spacing: bld?.defaultSpacing ?? 0,
      },
    };
  },

  trade_buy: (game, action) => {
    game._sendCommand({ cmd: CommandType.TradeBuy, listingSlot: action.slot });
  },

  trade_sell: (game, action) => {
    game._sendCommand({ cmd: CommandType.TradeSell, listingSlot: action.slot });
  },

  // Hotbar (T-309 prerequisite) — client-local only, no server command:
  // assignment/selection just patch uiState.hotbar, then push the new
  // occupancy to the renderer so slung body anchors stay in sync.
  hotbar_assign: (game, action) => {
    const hb = uiState.value.hotbar;
    if (!hb) return;
    const assignments = [...hb.assignments];
    assignments[action.hotbarSlot] = action.inventorySlot;
    patchUI({ hotbar: { ...hb, assignments } });
    game._syncHotbarAttachments();
  },

  hotbar_clear: (game, action) => {
    const hb = uiState.value.hotbar;
    if (!hb) return;
    const assignments = [...hb.assignments];
    assignments[action.hotbarSlot] = null;
    patchUI({ hotbar: { ...hb, assignments } });
    game._syncHotbarAttachments();
  },

  // Selects the "active" (in-hand) slot only — does not equip
  // anything. The Hotbar UI only fires this for occupied slots.
  hotbar_use: (game, action) => {
    const hb = uiState.value.hotbar;
    if (!hb) return;
    patchUI({ hotbar: { ...hb, activeIndex: action.hotbarSlot } });
    game._syncHotbarAttachments();
  },

  // Not yet implemented — log for discoverability during development.
  split_stack: (_game, action) => console.debug("[UIAction unhandled]", action),
  dialogue_choice: (_game, action) => console.debug("[UIAction unhandled]", action),
  dialogue_close: (_game, action) => console.debug("[UIAction unhandled]", action),
  rebind_key: (_game, action) => console.debug("[UIAction unhandled]", action),
};

/**
 * Translate a UI intent into server messages / game state.
 * The cast at the lookup is the standard keyed-union narrowing limitation;
 * safety lives in the fully-typed handler record above.
 */
export function dispatchUIAction(game: VoximGame, action: UIAction): void {
  (handlers[action.type] as (game: VoximGame, action: UIAction) => void)(game, action);
}
