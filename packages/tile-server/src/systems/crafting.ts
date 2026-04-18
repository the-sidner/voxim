/**
 * CraftingSystem — workstation placement and per-tick step dispatch.
 *
 * Responsibilities:
 *   1. Placement — ACTION_INTERACT near a workstation moves the first item
 *      from the player's inventory into the WorkstationBuffer.
 *   2. Dispatch  — each tick, every registered RecipeStepHandler with an
 *      `onTick` method runs once per workstation. Step-specific logic
 *      (time recipe auto-start and countdown) lives in the handlers.
 *
 * Hit-based resolution (attack / assembly) goes through WorkstationHitHandler
 * which dispatches to the same RecipeStepHandler registry via `onHit`.
 */
import type { World, EntityId, Registry } from "@voxim/engine";
import type { SpatialGrid } from "../spatial_grid.ts";
import { newEntityId } from "@voxim/engine";
import { ACTION_INTERACT, hasAction, CommandType } from "@voxim/protocol";
import type { CommandPayload } from "@voxim/protocol";
import type { ContentStore, Recipe } from "@voxim/content";
import type { System, EventEmitter, TickContext } from "../system.ts";
import { Position, InputState } from "../components/game.ts";
import { Inventory, InteractCooldown, ItemData } from "../components/items.ts";
import { WorkstationTag, WorkstationBuffer } from "../components/building.ts";
import type { WorkstationBufferData } from "../components/building.ts";
import { LoreLoadout } from "../components/lore_loadout.ts";
import type { RecipeStepHandler } from "../crafting/step_handler.ts";
import { spawnPrefab } from "../spawner.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("CraftingSystem");

export class CraftingSystem implements System {
  private _commands: ReadonlyMap<string, CommandPayload[]> = new Map();
  private _spatial: SpatialGrid | null = null;

  constructor(
    private readonly content: ContentStore,
    private readonly steps: Registry<RecipeStepHandler>,
  ) {}

  prepare(_serverTick: number, ctx: TickContext): void {
    this._commands = ctx.pendingCommands;
    this._spatial = ctx.spatial;
  }

  run(world: World, events: EventEmitter, _dt: number): void {
    // ── 0. Command: DeployItem / SelectRecipe ────────────────────────────
    for (const [entityId, commands] of this._commands) {
      if (!world.isAlive(entityId)) continue;
      for (const cmd of commands) {
        if (cmd.cmd === CommandType.DeployItem) {
          this._handleDeploy(world, entityId, cmd.inventorySlot);
        } else if (cmd.cmd === CommandType.SelectRecipe) {
          this._handleSelectRecipe(world, entityId, cmd.recipeId);
        }
      }
    }

    // ── 1. Placement via ACTION_INTERACT ─────────────────────────────────
    for (const { entityId, inputState, inventory, interactCooldown } of world.query(
      InputState, Inventory, InteractCooldown,
    )) {
      if (interactCooldown.remaining > 0) {
        world.set(entityId, InteractCooldown, { remaining: interactCooldown.remaining - 1 });
        continue;
      }
      if (!hasAction(inputState.actions, ACTION_INTERACT)) continue;

      world.set(entityId, InteractCooldown, {
        remaining: this.content.getGameConfig().crafting.interactCooldownTicks,
      });

      if (inventory.slots.length === 0) continue;

      const pos = world.get(entityId, Position);
      if (!pos) continue;

      const stationId = this.findNearestWorkstation(world, pos.x, pos.y);
      if (!stationId) continue;

      const buffer = world.get(stationId, WorkstationBuffer);
      if (!buffer) continue;

      const occupied = buffer.slots.filter((s) => s !== null).length;
      if (occupied >= buffer.capacity) {
        log.debug("interact: station=%s buffer full (%d/%d)", stationId, occupied, buffer.capacity);
        continue;
      }

      // Place the first inventory slot into the buffer
      const slot = inventory.slots[0];
      const newInvSlots = inventory.slots.slice(1);
      world.set(entityId, Inventory, { ...inventory, slots: newInvSlots });

      const newBufferSlots = [...buffer.slots, { itemType: slot.itemType, quantity: slot.quantity }];
      world.set(stationId, WorkstationBuffer, { ...buffer, slots: newBufferSlots });

      const tag = world.get(stationId, WorkstationTag);
      log.info("placed: player=%s item=%sx%d on station=%s (%s)",
        entityId, slot.itemType, slot.quantity, stationId, tag?.stationType ?? "?");
    }

    // ── 2. Per-tick step dispatch ────────────────────────────────────────
    // Every registered step handler's onTick runs once per workstation. The
    // handlers decide whether to act based on their own stepType filter.
    for (const stepId of this.steps.ids()) {
      const handler = this.steps.get(stepId);
      if (!handler.onTick) continue;
      for (const { entityId } of world.query(WorkstationBuffer)) {
        // Re-read the buffer — a previous step handler on the same station
        // may have mutated it this tick.
        const current = world.get(entityId, WorkstationBuffer);
        if (!current) continue;
        const tag = world.get(entityId, WorkstationTag);
        if (!tag) continue;
        handler.onTick({
          world, events, content: this.content,
          stationId: entityId, stationType: tag.stationType,
          buffer: current,
        });
      }
    }
  }

  private _handleDeploy(world: World, entityId: EntityId, slotIndex: number): void {
    const inventory = world.get(entityId, Inventory);
    if (!inventory) return;
    const slot = inventory.slots[slotIndex];
    if (!slot) return;

    const itemDef = this.content.getItemTemplate(slot.itemType);
    const templateId = itemDef?.deploysTo ?? null;
    if (!templateId) {
      log.debug("deploy: player=%s item=%s not deployable", entityId, slot.itemType);
      return;
    }

    if (!this.content.getPrefab(templateId)) {
      log.warn("deploy: player=%s item=%s has no prefab '%s'", entityId, slot.itemType, templateId);
      return;
    }

    // Place the workstation slightly in front of the player
    const pos = world.get(entityId, Position);
    if (!pos) return;
    const facing = world.get(entityId, InputState)?.facing ?? 0;
    const deployOffset = this.content.getGameConfig().crafting.deployOffsetWorldUnits;
    const wx = pos.x + Math.sin(facing) * deployOffset;
    const wy = pos.y + Math.cos(facing) * deployOffset;

    spawnPrefab(world, this.content, templateId, { x: wx, y: wy, z: pos.z });

    // Consume one from inventory
    const newSlots = [...inventory.slots];
    if (slot.quantity <= 1) {
      newSlots.splice(slotIndex, 1);
    } else {
      newSlots[slotIndex] = { ...slot, quantity: slot.quantity - 1 };
    }
    world.set(entityId, Inventory, { ...inventory, slots: newSlots });
    log.info("deploy: player=%s placed %s at (%.1f, %.1f)", entityId, slot.itemType, wx, wy);
  }

  private _handleSelectRecipe(world: World, entityId: EntityId, recipeId: string): void {
    const recipe = this.content.getRecipe(recipeId);
    if (!recipe) {
      log.debug("select-recipe: unknown recipe=%s", recipeId);
      return;
    }

    // T-030: gate on required lore fragment
    if (recipe.requiredFragmentId) {
      const loadout = world.get(entityId, LoreLoadout);
      if (!loadout?.learnedFragmentIds.includes(recipe.requiredFragmentId)) {
        log.debug("select-recipe: player=%s lacks fragment=%s for recipe=%s",
          entityId, recipe.requiredFragmentId, recipeId);
        return;
      }
    }

    const pos = world.get(entityId, Position);
    if (!pos) return;
    const stationId = this.findNearestWorkstation(world, pos.x, pos.y);
    if (!stationId) return;
    const buffer = world.get(stationId, WorkstationBuffer);
    if (!buffer) return;
    world.set(stationId, WorkstationBuffer, { ...buffer, activeRecipeId: recipeId });
    log.info("select-recipe: player=%s station=%s recipe=%s", entityId, stationId, recipeId);
  }

  private findNearestWorkstation(world: World, x: number, y: number): EntityId | null {
    if (!this._spatial) return null;
    const interactRange = this.content.getGameConfig().crafting.interactRange;
    let bestId: EntityId | null = null;
    let bestDistSq = interactRange * interactRange;

    for (const candidateId of this._spatial.nearby(x, y, interactRange)) {
      if (!world.has(candidateId, WorkstationTag)) continue;
      const pos = world.get(candidateId, Position);
      if (!pos) continue;
      const dx = pos.x - x, dy = pos.y - y;
      const distSq = dx * dx + dy * dy;
      if (distSq < bestDistSq) { bestDistSq = distSq; bestId = candidateId; }
    }
    return bestId;
  }
}

// ---- shared helpers (also used by WorkstationHitHandler) ----

export function findMatchingRecipe(
  content: ContentStore,
  stationType: string,
  stepType: Recipe["stepType"],
  bufferSlots: WorkstationBufferData["slots"],
): Recipe | null {
  const bufferMap = slotsToMap(bufferSlots);
  for (const recipe of content.getAllRecipes()) {
    if (recipe.stationType !== stationType) continue;
    if ((recipe.stepType ?? "time") !== stepType) continue;
    if (!recipeInputsMatch(recipe.inputs, bufferMap)) continue;
    return recipe;
  }
  return null;
}

/**
 * An input matches when the primary itemType OR any alternate has at least
 * the required quantity available in the buffer.
 */
export function recipeInputsMatch(
  inputs: Recipe["inputs"],
  bufferMap: Map<string, number>,
): boolean {
  return inputs.every((inp) => {
    if ((bufferMap.get(inp.itemType) ?? 0) >= inp.quantity) return true;
    if (inp.alternates) {
      for (const alt of inp.alternates) {
        if ((bufferMap.get(alt) ?? 0) >= inp.quantity) return true;
      }
    }
    return false;
  });
}

/**
 * Consume each input from the buffer. For inputs with alternates, the first
 * acceptable type with sufficient quantity is consumed (primary preferred).
 * Assumes `recipeInputsMatch` has already passed.
 */
export function consumeFromBuffer(
  slots: WorkstationBufferData["slots"],
  inputs: Recipe["inputs"],
): WorkstationBufferData["slots"] {
  const remaining = new Map<string, number>();
  for (const s of slots) {
    if (s !== null) remaining.set(s.itemType, (remaining.get(s.itemType) ?? 0) + s.quantity);
  }
  for (const inp of inputs) {
    const acceptable = inp.alternates ? [inp.itemType, ...inp.alternates] : [inp.itemType];
    for (const t of acceptable) {
      const cur = remaining.get(t) ?? 0;
      if (cur >= inp.quantity) {
        const after = cur - inp.quantity;
        if (after <= 0) remaining.delete(t);
        else remaining.set(t, after);
        break;
      }
    }
  }
  return Array.from(remaining.entries()).map(([itemType, quantity]) => ({ itemType, quantity }));
}

function slotsToMap(slots: WorkstationBufferData["slots"]): Map<string, number> {
  const m = new Map<string, number>();
  for (const s of slots) {
    if (s !== null) m.set(s.itemType, (m.get(s.itemType) ?? 0) + s.quantity);
  }
  return m;
}

export function spawnOutputNear(world: World, stationId: EntityId, itemType: string, quantity: number): void {
  const pos = world.get(stationId, Position);
  const id = newEntityId();
  world.create(id);
  world.write(id, Position, { x: (pos?.x ?? 0) + 0.5, y: (pos?.y ?? 0) + 0.5, z: pos?.z ?? 4.0 });
  world.write(id, ItemData, { itemType, quantity });
}

