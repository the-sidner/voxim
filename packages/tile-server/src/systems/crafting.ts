/**
 * CraftingSystem — workstation buffer loading, recipe selection, and per-tick
 * step dispatch.
 *
 * Responsibilities:
 *   1. Buffer loading — ACTION_INTERACT near a workstation moves the first
 *      item from the player's inventory into the WorkstationBuffer.
 *   2. Recipe selection — SelectRecipe command sets activeRecipeId on the
 *      nearest workstation (assembly-step prerequisite).
 *   3. Dispatch  — each tick, every registered RecipeStepHandler with an
 *      `onTick` method runs once per workstation. Step-specific logic
 *      (time recipe auto-start and countdown) lives in the handlers.
 *
 * Workstation *placement* (turning an inventory kit into a world workstation)
 * is handled by PlacementSystem via the generic Place command.
 *
 * Hit-based resolution (attack / assembly) goes through WorkstationHitHandler
 * which dispatches to the same RecipeStepHandler registry via `onHit`.
 */
import type { World, EntityId, Registry } from "@voxim/engine";
import type { SpatialGrid } from "../spatial_grid.ts";
import { newEntityId } from "@voxim/engine";
import { ACTION_INTERACT, hasAction, CommandType } from "@voxim/protocol";
import type { CommandPayload } from "@voxim/protocol";
import type { ContentStore, Recipe, RecipeOutput } from "@voxim/content";
import { evalFormula, parseFormula } from "@voxim/content";
import type { System, EventEmitter, TickContext } from "../system.ts";
import { Position, InputState } from "../components/game.ts";
import { Inventory, InteractCooldown, ItemData } from "../components/items.ts";
import type { InventorySlot } from "@voxim/codecs";
import { WorkstationTag, WorkstationBuffer } from "../components/building.ts";
import type { WorkstationBufferData } from "../components/building.ts";
import { QualityStamped, Stats } from "../components/instance.ts";
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
    // ── 0. Per-player commands ───────────────────────────────────────────
    for (const [entityId, commands] of this._commands) {
      if (!world.isAlive(entityId)) continue;
      for (const cmd of commands) {
        if (cmd.cmd === CommandType.SelectRecipe) {
          this._handleSelectRecipe(world, entityId, cmd.recipeId);
        } else if (cmd.cmd === CommandType.LoadWorkstation) {
          this._handleLoadWorkstation(world, entityId, cmd.inventorySlot, cmd.bufferSlot);
        } else if (cmd.cmd === CommandType.TakeWorkstation) {
          this._handleTakeWorkstation(world, entityId, cmd.bufferSlot);
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

      // INTERACT-load is the quick "shove the top of inventory onto the
      // bench" path. Stacks become stack slots (with quantity carried over);
      // unique entities become unique slots (the entity stays alive in the
      // world; the buffer just refers to it).
      const slot = inventory.slots[0];
      const newInvSlots = inventory.slots.slice(1);
      world.set(entityId, Inventory, { ...inventory, slots: newInvSlots });

      const newSlot: typeof buffer.slots[number] = slot.kind === "stack"
        ? { kind: "stack",  itemType: slot.prefabId, quantity: slot.quantity }
        : { kind: "unique", entityId: slot.entityId, prefabId: this.resolveUniquePrefab(world, slot.entityId) };
      const newBufferSlots = [...buffer.slots, newSlot];
      world.set(stationId, WorkstationBuffer, { ...buffer, slots: newBufferSlots });

      const tag = world.get(stationId, WorkstationTag);
      log.info("placed: player=%s item=%s on station=%s (%s)",
        entityId, describeSlot(newSlot), stationId, tag?.stationType ?? "?");
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

  private _handleLoadWorkstation(
    world: World,
    playerId: EntityId,
    inventorySlot: number,
    bufferSlot: number,
  ): void {
    const inv = world.get(playerId, Inventory);
    if (!inv) return;
    if (inventorySlot < 0 || inventorySlot >= inv.slots.length) return;
    const slot = inv.slots[inventorySlot];

    const pos = world.get(playerId, Position);
    if (!pos) return;
    const stationId = this.findNearestWorkstation(world, pos.x, pos.y);
    if (!stationId) {
      log.debug("load: player=%s no station in range", playerId);
      return;
    }
    const buffer = world.get(stationId, WorkstationBuffer);
    if (!buffer) return;

    const slotPrefab = slot.kind === "stack" ? slot.prefabId : this.resolveUniquePrefab(world, slot.entityId);
    const newSlots: (typeof buffer.slots[number])[] = [...buffer.slots];
    let dst = bufferSlot;
    if (dst >= buffer.capacity) {
      // Prefer merging with an existing matching stack first (stack→stack only).
      if (slot.kind === "stack") {
        dst = newSlots.findIndex((s) => s !== null && s.kind === "stack" && s.itemType === slot.prefabId);
      } else {
        dst = -1;
      }
      if (dst === -1) dst = newSlots.findIndex((s) => s === null);
      if (dst === -1 && newSlots.length < buffer.capacity) dst = newSlots.length;
      if (dst === -1) {
        log.debug("load: station=%s buffer full", stationId);
        return;
      }
    }

    const existing = newSlots[dst] ?? null;
    if (slot.kind === "stack") {
      if (existing && (existing.kind !== "stack" || existing.itemType !== slot.prefabId)) {
        log.debug("load: station=%s slot=%d incompatible with existing", stationId, dst);
        return;
      }
      newSlots[dst] = {
        kind: "stack",
        itemType: slot.prefabId,
        quantity: (existing && existing.kind === "stack" ? existing.quantity : 0) + slot.quantity,
      };
    } else {
      // Unique entities never merge — refuse if the target slot is occupied.
      if (existing) {
        log.debug("load: station=%s slot=%d already occupied (unique)", stationId, dst);
        return;
      }
      newSlots[dst] = { kind: "unique", entityId: slot.entityId, prefabId: slotPrefab };
    }
    while (newSlots.length <= dst) newSlots.push(null);

    const newInv = inv.slots.filter((_, i) => i !== inventorySlot);
    world.set(playerId, Inventory, { ...inv, slots: newInv });
    world.set(stationId, WorkstationBuffer, { ...buffer, slots: newSlots });
    log.info("load: player=%s item=%s → station=%s slot=%d",
      playerId, describeSlot(newSlots[dst]!), stationId, dst);
  }

  private _handleTakeWorkstation(
    world: World,
    playerId: EntityId,
    bufferSlot: number,
  ): void {
    const pos = world.get(playerId, Position);
    if (!pos) return;
    const stationId = this.findNearestWorkstation(world, pos.x, pos.y);
    if (!stationId) {
      log.debug("take: player=%s no station in range", playerId);
      return;
    }
    const buffer = world.get(stationId, WorkstationBuffer);
    if (!buffer) return;
    if (bufferSlot < 0 || bufferSlot >= buffer.slots.length) return;
    const slot = buffer.slots[bufferSlot];
    if (!slot) return;

    const inv = world.get(playerId, Inventory);
    if (!inv) return;
    if (inv.slots.length >= inv.capacity) {
      log.debug("take: player=%s inventory full", playerId);
      return;
    }
    const newBuffer = [...buffer.slots];
    newBuffer[bufferSlot] = null;
    const newInvSlot: InventorySlot = slot.kind === "stack"
      ? { kind: "stack", prefabId: slot.itemType, quantity: slot.quantity }
      : { kind: "unique", entityId: slot.entityId };
    const newInv = [...inv.slots, newInvSlot];
    world.set(stationId, WorkstationBuffer, { ...buffer, slots: newBuffer });
    world.set(playerId, Inventory, { ...inv, slots: newInv });
    log.info("take: player=%s station=%s slot=%d item=%s",
      playerId, stationId, bufferSlot, describeSlot(slot));
  }

  /** Read an item-entity's prefab id from its ItemData component. */
  private resolveUniquePrefab(world: World, entityId: string): string {
    const data = world.get(entityId as EntityId, ItemData);
    return data?.prefabId ?? "";
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

/**
 * Maps every recipe role to the buffer slot index that satisfies it.
 * Returned by `findMatchingRecipe` and threaded through consumption + stat
 * propagation so the same slots are consumed that the matcher chose.
 */
export type RoleAssignment = ReadonlyMap<string, number>;

export interface RecipeMatch {
  recipe: Recipe;
  assignment: RoleAssignment;
}

export function findMatchingRecipe(
  content: ContentStore,
  stationType: string,
  stepType: Recipe["stepType"],
  bufferSlots: WorkstationBufferData["slots"],
): RecipeMatch | null {
  for (const recipe of content.getAllRecipes()) {
    if (recipe.stationType !== stationType) continue;
    if ((recipe.stepType ?? "time") !== stepType) continue;
    const assignment = tryAssignRoles(recipe, bufferSlots, content);
    if (assignment) return { recipe, assignment };
  }
  return null;
}

/**
 * Try to assign each recipe role to a buffer slot that satisfies it.
 * More-specific roles (itemType > category-with-tags > category) are claimed
 * first so a yew-only role doesn't lose its only candidate to a generic
 * "any wood" role.
 */
export function tryAssignRoles(
  recipe: Recipe,
  bufferSlots: WorkstationBufferData["slots"],
  content: ContentStore,
): RoleAssignment | null {
  const ordered = [...recipe.inputs].sort((a, b) => inputSpecificity(b) - inputSpecificity(a));
  const claimed = new Set<number>();
  const out = new Map<string, number>();
  for (const input of ordered) {
    let chosen = -1;
    for (let i = 0; i < bufferSlots.length; i++) {
      if (claimed.has(i)) continue;
      const slot = bufferSlots[i];
      if (!slot) continue;
      if (slotQuantity(slot) < input.quantity) continue;
      if (!inputAccepts(input, slotPrefabId(slot), content)) continue;
      chosen = i;
      break;
    }
    if (chosen === -1) return null;
    claimed.add(chosen);
    out.set(input.role, chosen);
  }
  return out;
}

function slotQuantity(slot: WorkstationBufferData["slots"][number] & {}): number {
  return slot.kind === "stack" ? slot.quantity : 1;
}

function slotPrefabId(slot: WorkstationBufferData["slots"][number] & {}): string {
  return slot.kind === "stack" ? slot.itemType : slot.prefabId;
}

/** Compact debug log line. */
function describeSlot(slot: WorkstationBufferData["slots"][number] & {}): string {
  return slot.kind === "stack"
    ? `${slot.itemType}x${slot.quantity}`
    : `${slot.prefabId}#${slot.entityId.slice(0, 6)}`;
}

function inputSpecificity(input: Recipe["inputs"][number]): number {
  if ("itemType" in input && input.itemType !== undefined) return 2;
  if ("tags" in input && (input.tags?.length ?? 0) > 0) return 1;
  return 0;
}

function inputAccepts(input: Recipe["inputs"][number], prefabId: string, content: ContentStore): boolean {
  if ("itemType" in input && input.itemType !== undefined) {
    return prefabId === input.itemType;
  }
  if ("category" in input && input.category !== undefined) {
    const prefab = content.getPrefab(prefabId);
    if (!prefab || prefab.category !== input.category) return false;
    if (input.tags) {
      const have = prefab.tags ?? [];
      for (const t of input.tags) if (!have.includes(t)) return false;
    }
    return true;
  }
  return false;
}

/**
 * Consume each input from the buffer at its assigned slot. The matcher's
 * `assignment` decides which slot fed which role — same slot here means we
 * burn what we matched, not whatever happens to be in the same item type.
 */
export function consumeFromBuffer(
  world: World,
  slots: WorkstationBufferData["slots"],
  recipe: Recipe,
  assignment: RoleAssignment,
): WorkstationBufferData["slots"] {
  const next: WorkstationBufferData["slots"] = slots.slice();
  for (const input of recipe.inputs) {
    const idx = assignment.get(input.role);
    if (idx === undefined) continue;
    const slot = next[idx];
    if (!slot) continue;
    if (slot.kind === "stack") {
      const after = slot.quantity - input.quantity;
      next[idx] = after > 0 ? { kind: "stack", itemType: slot.itemType, quantity: after } : null;
    } else {
      // Unique consumption destroys the item entity — its identity ends in
      // the craft. Stat propagation already happened in spawnOutputNear,
      // which ran *before* this against the same slot index.
      world.destroy(slot.entityId as EntityId);
      next[idx] = null;
    }
  }
  // Drop trailing nulls so the buffer compacts naturally.
  while (next.length > 0 && next[next.length - 1] === null) next.pop();
  return next;
}

/**
 * Spawn a crafting output at a workstation.
 *
 * Stack output (prefab declares `stackable` AND the recipe output declares
 * no `stats` formulas): cheap path — a single world entity carrying
 * `Position` + `ItemData { prefabId, quantity }`. Quantity is meaningful;
 * no per-instance state.
 *
 * Unique output (everything else): runs through `spawnPrefab` so the full
 * item-behaviour component set + visual shell install. If the recipe output
 * declares `stats`, evaluate each formula against `<role>.<stat>` /
 * `tool.*` / `workstation.*` / `skill.*` and write a `Stats` component.
 * Stat-bearing outputs are *always* unique even if the prefab declared
 * `stackable: {}` — two crafted swords with different stat blobs can't share
 * an inventory slot.
 *
 * Quality stamping (`QualityStamped`) still happens for unique outputs so
 * downstream `deriveItemStats` callers keep working until the full T-121
 * stat surface replaces it.
 */
export function spawnOutputNear(
  world: World,
  content: ContentStore,
  stationId: EntityId,
  output: RecipeOutput,
  match: RecipeMatch,
  bufferSlotsBeforeConsume: WorkstationBufferData["slots"],
): void {
  const prefab = content.getPrefab(output.itemType);
  const pos = world.get(stationId, Position);
  const x = (pos?.x ?? 0) + 0.5;
  const y = (pos?.y ?? 0) + 0.5;
  const z = pos?.z ?? 4.0;

  const hasStats = output.stats !== undefined && Object.keys(output.stats).length > 0;
  const isStackable = prefab?.components["stackable"] !== undefined && !hasStats;
  if (isStackable || !prefab) {
    const id = newEntityId();
    world.create(id);
    world.write(id, Position, { x, y, z });
    world.write(id, ItemData, { prefabId: output.itemType, quantity: output.quantity });
    return;
  }

  const tag = world.get(stationId, WorkstationTag);
  const quality = clamp01(tag?.qualityTier ?? 1);
  const computedStats = hasStats
    ? evaluateOutputStats(world, output.stats!, match, bufferSlotsBeforeConsume, content, tag?.qualityTier ?? 1)
    : null;

  // Stat-bearing outputs always spawn one entity per unit (uniques don't
  // stack). Outputs without stats may still be uniques (sword, etc.).
  const n = Math.max(1, output.quantity);
  for (let i = 0; i < n; i++) {
    const id = spawnPrefab(world, content, output.itemType, { x, y, z });
    world.write(id, ItemData, { prefabId: output.itemType, quantity: 1 });
    world.write(id, QualityStamped, { quality });
    if (computedStats) {
      world.write(id, Stats, { ...computedStats });
    }
  }
}

/**
 * Build the formula scope from the matched buffer slots and evaluate each
 * declared output stat. Variables:
 *   <role>.<stat>      — from the input slot's prefab.stats (raw materials).
 *   workstation.quality — qualityTier (0..1).
 *
 * Tool and skill scopes are reserved for a follow-up that needs the
 * triggering player's entity context — placeholder zero so formulas that
 * reference them parse but evaluate predictably.
 */
function evaluateOutputStats(
  world: World,
  formulas: Record<string, string>,
  match: RecipeMatch,
  bufferSlots: WorkstationBufferData["slots"],
  content: ContentStore,
  qualityTier: number,
): Record<string, number> {
  const scope: Record<string, number> = {
    "workstation.quality": qualityTier,
  };
  for (const input of match.recipe.inputs) {
    const idx = match.assignment.get(input.role);
    if (idx === undefined) continue;
    const slot = bufferSlots[idx];
    if (!slot) continue;
    // Stack slots: stats live on the prefab (raw materials all share them).
    // Unique slots: stats live on the entity's Stats component (computed by
    // whatever upstream recipe created it).
    let stats: Record<string, number> = {};
    if (slot.kind === "stack") {
      stats = content.getPrefab(slot.itemType)?.stats ?? {};
    } else {
      stats = world.get(slot.entityId as EntityId, Stats) ?? {};
    }
    for (const [k, v] of Object.entries(stats)) {
      scope[`${input.role}.${k}`] = v;
    }
  }

  const out: Record<string, number> = {};
  for (const [statName, source] of Object.entries(formulas)) {
    try {
      const parsed = parseFormula(source);
      out[statName] = evalFormula(parsed, scope);
    } catch (err) {
      log.warn("recipe=%s stat=%s formula failed: %s", match.recipe.id, statName, (err as Error).message);
    }
  }
  return out;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

