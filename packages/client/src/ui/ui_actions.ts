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
  | { type: "drop_item"; fromSlot: number; quantity?: number }
  | { type: "use_item";  fromSlot: number }
  | { type: "split_stack"; fromSlot: number; quantity: number }

  // Hotbar
  | { type: "hotbar_assign"; inventorySlot: number; hotbarSlot: number }
  | { type: "hotbar_use";    hotbarSlot: number }

  // Crafting
  | { type: "crafting_add";    inventorySlot: number; craftingSlot: number }
  | { type: "crafting_remove"; craftingSlot: number }
  | { type: "crafting_craft" }

  // Trading
  | { type: "trade_buy";  itemType: string; quantity: number }
  | { type: "trade_sell"; inventorySlot: number; quantity: number }

  // Dialogue
  | { type: "dialogue_choice"; npcId: string; choiceIndex: number }
  | { type: "dialogue_close";  npcId: string }

  // Respawn
  | { type: "respawn" }

  // Settings
  | { type: "rebind_key"; action: string; key: string }

  // Debug
  | { type: "debug_toggle"; layer: "skeleton" | "facing" | "chunks" | "heightmap" | "blade" | "hitbox" | "fxaa" }
  | { type: "debug_give_item"; itemType: string; quantity: number }

  // Building
  | { type: "place_blueprint"; structureType: string; worldX: number; worldY: number }
  | { type: "open_build_menu"; canvasX: number; canvasY: number }
  | { type: "select_blueprint"; structureType: string };
