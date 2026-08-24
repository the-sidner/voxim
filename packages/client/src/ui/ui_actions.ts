/**
 * UIAction — the typed intent surface between the UI and game.ts.
 *
 * The UI emits these; game.ts translates them into server messages.
 * Keeping this as a discriminated union makes it easy to add new actions
 * without touching the UI components that don't care about them.
 */

export type UIAction =
  // Equipment
  | { type: "equip";     itemType: string; fromSlot: number }
  | { type: "unequip";   slot: string }

  // Inventory
  | { type: "move_item"; fromSlot: number; toSlot: number }
  | { type: "drop_item";   fromSlot: number; quantity?: number }
  | { type: "use_item";    fromSlot: number }
  | { type: "deploy_item"; fromSlot: number }
  | { type: "split_stack"; fromSlot: number; quantity: number }
  // Read a tome sitting in an inventory slot — internalises its Lore fragment
  // (T-072 heir ritual; T-020 server substrate).
  | { type: "read_tome";   fromSlot: number }
  // Write a learned Lore fragment to a blank tome in the burden (T-019 server
  // substrate; T-360 client wiring). fragIndex indexes the player's
  // learnedFragmentIds (SkillLoadoutState) — the same index CommandType.Externalise
  // expects. The server locates the blank tome itself; no fromSlot needed.
  | { type: "write_tome";  fragIndex: number }

  // Hotbar (T-309 prerequisite — client-local; see ui_store.ts HotbarState)
  | { type: "hotbar_assign"; inventorySlot: number; hotbarSlot: number }
  | { type: "hotbar_clear";  hotbarSlot: number }
  | { type: "hotbar_use";    hotbarSlot: number }

  // Workstation buffer (load / take). Targets the player's nearest
  // workstation server-side; the client opens the panel on click.
  | { type: "load_workstation"; inventorySlot: number; bufferSlot: number }
  | { type: "take_workstation"; bufferSlot: number }
  | { type: "select_recipe";    recipeId: string }

  // Family chest (library / treasury). Targets the chest the panel is open on;
  // deposit banks the unique item in `inventorySlot`, withdraw pulls `slotIndex`.
  | { type: "deposit_container";  containerId: string; inventorySlot: number }
  | { type: "withdraw_container"; containerId: string; slotIndex: number }

  // Trading — `slot` is the index into the trader's listings (server keys both by listing slot)
  | { type: "trade_buy";  slot: number }
  | { type: "trade_sell"; slot: number }

  // Dialogue
  | { type: "dialogue_choice"; npcId: string; choiceIndex: number }
  | { type: "dialogue_close";  npcId: string }

  // Respawn
  | { type: "respawn" }
  // Dismiss the heir-ritual guidance banner for the remainder of this life (T-072).
  | { type: "dismiss_ritual" }

  // Settings
  | { type: "rebind_key"; action: string; key: string }

  // Debug
  | { type: "debug_toggle"; layer: "skeleton" | "facing" | "chunks" | "heightmap" | "blade" | "hitbox" | "sobel_edges" | "bypass_postfx" | "shadows" }
  | { type: "debug_scene_census" }
  | { type: "debug_give_item";  itemType: string; quantity: number }
  | { type: "debug_spawn_npc";  npcTemplate: string; quantity: number }
  | { type: "debug_set_time";   hour: number }
  | { type: "debug_teleport";   worldX: number; worldY: number }
  | { type: "debug_set_stat";   stat: "health" | "stamina"; value: number }
  | { type: "debug_kill_entity"; entityId: string }
  | { type: "debug_spawn_dummy"; attackLoop: boolean }
  | { type: "debug_set_action_param"; actionId: string; field: string; value: number }

  // Building
  | { type: "place_blueprint"; structureType: string; worldX: number; worldY: number }
  | { type: "open_build_menu"; canvasX: number; canvasY: number }
  | { type: "select_blueprint"; structureType: string };
