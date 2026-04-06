import type { World } from "@voxim/engine";
import { newEntityId } from "@voxim/engine";
import { TileEvents } from "@voxim/protocol";
import { ACTION_INTERACT, hasAction } from "@voxim/protocol";
import type { ContentStore } from "@voxim/content";
import type { ItemPart } from "@voxim/content";
import type { System, EventEmitter } from "../system.ts";
import { Position, InputState } from "../components/game.ts";
import { Inventory, CraftingQueue, ItemData, InteractCooldown } from "../components/items.ts";
import type { InventorySlot } from "../components/items.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("CraftingSystem");
const INTERACT_COOLDOWN_TICKS = 20;

export class CraftingSystem implements System {
  constructor(private content: ContentStore) {}

  run(world: World, events: EventEmitter, _dt: number): void {
    // ── Step 1: detect interact → start crafting ──────────────────────────
    for (const { entityId, inputState, inventory, interactCooldown } of world.query(
      InputState, Inventory, InteractCooldown,
    )) {
      if (interactCooldown.remaining > 0) {
        world.set(entityId, InteractCooldown, { remaining: interactCooldown.remaining - 1 });
        continue;
      }

      if (!hasAction(inputState.actions, ACTION_INTERACT)) continue;

      world.set(entityId, InteractCooldown, { remaining: INTERACT_COOLDOWN_TICKS });

      const craftingQueue = world.get(entityId, CraftingQueue);
      if (!craftingQueue || craftingQueue.activeRecipeId !== null) continue;

      const inventoryMap = slotsToMap(inventory.slots);
      const recipe = this.content.findCraftableRecipe(inventoryMap);
      if (!recipe) {
        log.debug("craft attempt: entity=%s no craftable recipe in inventory", entityId);
        continue;
      }

      log.info("crafting started: entity=%s recipe=%s ticks=%d", entityId, recipe.id, recipe.ticks);
      world.set(entityId, CraftingQueue, {
        activeRecipeId: recipe.id,
        progressTicks: recipe.ticks,
        queued: craftingQueue.queued,
      });
    }

    // ── Step 2: advance active recipes ───────────────────────────────────
    for (const { entityId, craftingQueue } of world.query(CraftingQueue)) {
      if (craftingQueue.activeRecipeId === null) continue;

      const newProgress = craftingQueue.progressTicks - 1;

      if (newProgress > 0) {
        world.set(entityId, CraftingQueue, { ...craftingQueue, progressTicks: newProgress });
        continue;
      }

      // Recipe completed
      const recipe = this.content.getRecipe(craftingQueue.activeRecipeId);
      if (recipe) {
        const inv = world.get(entityId, Inventory);
        if (inv) {
          const newSlots = consumeItems(
            inv.slots,
            recipe.inputs.map((i) => ({ itemType: i.itemType, quantity: i.quantity })),
          );
          const parts = buildOutputParts(recipe.inputs, this.content);
          const outputTemplate = this.content.getItemTemplate(recipe.outputType);
          const stackable = outputTemplate?.stackable ?? true;

          let finalSlots: InventorySlot[] | null;
          if (stackable && parts.length === 0) {
            finalSlots = addStackableItem(newSlots, recipe.outputType, recipe.outputQuantity, inv.capacity);
          } else {
            finalSlots = addUniqueItem(newSlots, recipe.outputType, parts, inv.capacity);
          }

          if (finalSlots !== null) {
            world.set(entityId, Inventory, { ...inv, slots: finalSlots });
            log.info("crafting complete: entity=%s recipe=%s output=%sx%d (to inventory)",
              entityId, recipe.id, recipe.outputType, recipe.outputQuantity);
          } else {
            spawnItemAtEntity(world, entityId, recipe.outputType, recipe.outputQuantity, parts);
            log.info("crafting complete: entity=%s recipe=%s output=%sx%d (dropped — full)",
              entityId, recipe.id, recipe.outputType, recipe.outputQuantity);
          }
        }

        events.publish(TileEvents.CraftingCompleted, { crafterId: entityId, recipeId: recipe.id });
      }

      const [next, ...rest] = craftingQueue.queued;
      if (next) {
        const nextRecipe = this.content.getRecipe(next);
        log.info("crafting next: entity=%s recipe=%s", entityId, next);
        world.set(entityId, CraftingQueue, {
          activeRecipeId: next,
          progressTicks: nextRecipe?.ticks ?? 60,
          queued: rest,
        });
      } else {
        world.set(entityId, CraftingQueue, { activeRecipeId: null, progressTicks: 0, queued: [] });
      }
    }
  }
}

function buildOutputParts(inputs: Array<{ itemType: string; outputSlot?: string }>, content: ContentStore): ItemPart[] {
  const parts: ItemPart[] = [];
  for (const input of inputs) {
    if (!input.outputSlot) continue;
    const template = content.getItemTemplate(input.itemType);
    if (!template?.materialName) continue;
    parts.push({ slot: input.outputSlot, materialName: template.materialName });
  }
  return parts;
}

function slotsToMap(slots: InventorySlot[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const s of slots) m.set(s.itemType, (m.get(s.itemType) ?? 0) + s.quantity);
  return m;
}

function consumeItems(slots: InventorySlot[], inputs: Array<{ itemType: string; quantity: number }>): InventorySlot[] {
  const m = slotsToMap(slots);
  for (const inp of inputs) m.set(inp.itemType, (m.get(inp.itemType) ?? 0) - inp.quantity);
  return Array.from(m.entries()).filter(([, qty]) => qty > 0).map(([itemType, quantity]) => ({ itemType, quantity }));
}

function addStackableItem(slots: InventorySlot[], itemType: string, quantity: number, capacity: number): InventorySlot[] | null {
  const total = slots.reduce((s, sl) => s + sl.quantity, 0);
  if (total + quantity > capacity) return null;
  const existing = slots.find((s) => s.itemType === itemType && !s.parts);
  if (existing) return slots.map((s) => s === existing ? { ...s, quantity: s.quantity + quantity } : s);
  return [...slots, { itemType, quantity }];
}

function addUniqueItem(slots: InventorySlot[], itemType: string, parts: ItemPart[], capacity: number): InventorySlot[] | null {
  const total = slots.reduce((s, sl) => s + sl.quantity, 0);
  if (total + 1 > capacity) return null;
  return [...slots, { itemType, quantity: 1, condition: 100, ...(parts.length > 0 ? { parts } : {}) }];
}

function spawnItemAtEntity(world: World, entityId: string, itemType: string, quantity: number, parts: ItemPart[]): void {
  const pos = world.get(entityId, Position);
  if (!pos) return;
  const id = newEntityId();
  world.create(id);
  world.write(id, Position, { x: pos.x + 0.5, y: pos.y + 0.5, z: pos.z });
  world.write(id, ItemData, { itemType, quantity, condition: parts.length > 0 ? 100 : undefined, parts: parts.length > 0 ? parts : undefined });
}
