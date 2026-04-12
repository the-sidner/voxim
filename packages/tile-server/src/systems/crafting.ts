/**
 * CraftingSystem — physical workstation crafting.
 *
 * Responsibilities:
 *   1. Placement  — ACTION_INTERACT near a workstation moves the first item from
 *                   the player's inventory into the WorkstationBuffer.
 *   2. Time-based — WorkstationBuffers whose progressTicks is counting down are
 *                   advanced each tick; output is spawned on completion.
 *   3. Auto-start — When a time-based recipe's inputs are fully placed, the
 *                   countdown begins automatically.
 *
 * Attack-based and assembly resolution are handled by WorkstationHitHandler,
 * which is registered as a HitHandler in server.ts.
 */
import type { World, EntityId } from "@voxim/engine";
import type { SpatialGrid } from "../spatial_grid.ts";
import { newEntityId } from "@voxim/engine";
import { TileEvents, ACTION_INTERACT, hasAction, CommandType } from "@voxim/protocol";
import type { CommandPayload } from "@voxim/protocol";
import type { ContentStore, Recipe } from "@voxim/content";
import type { System, EventEmitter, TickContext } from "../system.ts";
import { Position, InputState } from "../components/game.ts";
import { Inventory, InteractCooldown, ItemData } from "../components/items.ts";
import { WorkstationTag, WorkstationBuffer } from "../components/building.ts";
import type { WorkstationBufferData } from "../components/building.ts";
import { LoreLoadout } from "../components/lore_loadout.ts";
import { spawnWorkstation } from "../spawner.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("CraftingSystem");

/** How close a player must be to interact with a workstation (world units). */
const INTERACT_RANGE = 3.0;
/** Ticks between placement attempts to prevent button-hold spam. */
const INTERACT_COOLDOWN_TICKS = 10;
/** How far ahead of the player to place a deployed workstation (world units). */
const DEPLOY_OFFSET = 1.5;

export class CraftingSystem implements System {
  private _commands: ReadonlyMap<string, CommandPayload[]> = new Map();
  private _spatial: SpatialGrid | null = null;

  constructor(private readonly content: ContentStore) {}

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

      world.set(entityId, InteractCooldown, { remaining: INTERACT_COOLDOWN_TICKS });

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

      log.info("placed: player=%s item=%sx%d on station=%s (%s)",
        entityId, slot.itemType, slot.quantity, stationId, buffer.stationType);
    }

    // ── 2. Auto-start time-based recipes ────────────────────────────────
    for (const { entityId, workstationBuffer: buf } of world.query(WorkstationBuffer)) {
      if (buf.progressTicks !== null) continue; // already running
      if (buf.slots.length === 0) continue;

      const recipe = findMatchingRecipe(this.content, buf.stationType, "time", buf.slots);
      if (!recipe) continue;

      world.set(entityId, WorkstationBuffer, {
        ...buf,
        progressTicks: recipe.ticks,
        activeRecipeId: recipe.id,
      });
      log.info("time-recipe started: station=%s recipe=%s ticks=%d", entityId, recipe.id, recipe.ticks);
    }

    // ── 3. Advance time-based recipes ────────────────────────────────────
    for (const { entityId, workstationBuffer: buf } of world.query(WorkstationBuffer)) {
      if (buf.progressTicks === null || buf.progressTicks <= 0) continue;

      const newTicks = buf.progressTicks - 1;
      if (newTicks > 0) {
        world.set(entityId, WorkstationBuffer, { ...buf, progressTicks: newTicks });
        continue;
      }

      // Completed
      const recipe = buf.activeRecipeId ? this.content.getRecipe(buf.activeRecipeId) : null;
      if (recipe) {
        const newSlots = consumeFromBuffer(buf.slots, recipe.inputs);
        world.set(entityId, WorkstationBuffer, {
          ...buf,
          slots: newSlots,
          progressTicks: null,
          activeRecipeId: null,
        });

        spawnOutputNear(world, entityId, recipe.outputType, recipe.outputQuantity);
        events.publish(TileEvents.CraftingCompleted, { crafterId: entityId, recipeId: recipe.id });
        log.info("time-recipe done: station=%s recipe=%s output=%sx%d",
          entityId, recipe.id, recipe.outputType, recipe.outputQuantity);
      } else {
        world.set(entityId, WorkstationBuffer, { ...buf, progressTicks: null, activeRecipeId: null });
      }
    }
  }

  private _handleDeploy(world: World, entityId: EntityId, slotIndex: number): void {
    const inventory = world.get(entityId, Inventory);
    if (!inventory) return;
    const slot = inventory.slots[slotIndex];
    if (!slot) return;

    const itemDef = this.content.getItemTemplate(slot.itemType);
    if (itemDef?.category !== "deployable") {
      log.debug("deploy: player=%s item=%s not deployable", entityId, slot.itemType);
      return;
    }

    // Place the workstation slightly in front of the player
    const pos = world.get(entityId, Position);
    if (!pos) return;
    const facing = world.get(entityId, InputState)?.facing ?? 0;
    const wx = pos.x + Math.sin(facing) * DEPLOY_OFFSET;
    const wy = pos.y + Math.cos(facing) * DEPLOY_OFFSET;

    spawnWorkstation(world, { x: wx, y: wy, z: pos.z, stationType: slot.itemType });

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
    let bestId: EntityId | null = null;
    let bestDistSq = INTERACT_RANGE * INTERACT_RANGE;

    for (const candidateId of this._spatial.nearby(x, y, INTERACT_RANGE)) {
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

export function recipeInputsMatch(
  inputs: Recipe["inputs"],
  bufferMap: Map<string, number>,
): boolean {
  return inputs.every((inp) => (bufferMap.get(inp.itemType) ?? 0) >= inp.quantity);
}

export function consumeFromBuffer(
  slots: WorkstationBufferData["slots"],
  inputs: Recipe["inputs"],
): WorkstationBufferData["slots"] {
  const remaining = new Map<string, number>();
  for (const s of slots) {
    if (s !== null) remaining.set(s.itemType, (remaining.get(s.itemType) ?? 0) + s.quantity);
  }
  for (const inp of inputs) {
    const cur = remaining.get(inp.itemType) ?? 0;
    const after = cur - inp.quantity;
    if (after <= 0) remaining.delete(inp.itemType);
    else remaining.set(inp.itemType, after);
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

