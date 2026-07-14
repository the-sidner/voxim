/**
 * CraftingSystem — workstation buffer loading, recipe selection, and per-tick
 * step dispatch.
 *
 * Responsibilities:
 *   1. Buffer loading — LoadWorkstation / TakeWorkstation commands move
 *      items between the player's inventory and the WorkstationBuffer.
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
import { CommandType } from "@voxim/protocol";
import type { CommandPayload } from "@voxim/protocol";
import type { ContentService, Recipe, RecipeOutput } from "@voxim/content";
import { evalFormula, parseFormula } from "@voxim/content";
import type { System, EventEmitter, TickContext } from "../system.ts";
import { Position } from "../components/game.ts";
import { Inventory, ItemData } from "../components/items.ts";
import type { InventorySlot, WorkstationSlot } from "@voxim/codecs";
import { WorkstationTag, WorkstationBuffer } from "../components/building.ts";
import type { WorkstationBufferData } from "../components/building.ts";
import { Provenance, QualityStamped, Stats } from "../components/instance.ts";
import type { ProvenanceData } from "../components/instance.ts";
import { LoreLoadout } from "../components/lore_loadout.ts";
import type { RecipeStepHandler } from "../crafting/step_handler.ts";
import { spawnPrefab, spawnGroundStack, installDurability } from "../spawner.ts";
import { findByIdentity, slotIdentity } from "../inventory_ops.ts";
import type { SlotIdentity } from "../inventory_ops.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("CraftingSystem");

export class CraftingSystem implements System {
  private _commands: ReadonlyMap<string, CommandPayload[]> = new Map();
  private _spatial: SpatialGrid | null = null;

  constructor(
    private readonly content: ContentService,
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
        } else if (cmd.cmd === CommandType.PickUp) {
          this._handlePickUp(world, entityId, cmd.entityId);
        }
      }
    }

    // ── 1. Per-tick step dispatch ────────────────────────────────────────
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
    const recipe = this.content.recipes.get(recipeId);
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
    if (!world.get(stationId, WorkstationBuffer)) return;

    const slotPrefab = slot.kind === "stack" ? slot.prefabId : this.resolveUniquePrefab(world, slot.entityId);
    const sourceIdentity: SlotIdentity = slotIdentity(slot);

    // T-344: COUPLED-DECLINE. WorkstationBuffer (the destination) claims a
    // slot first — the WHOLE dst-resolution + merge computation moves
    // INSIDE the closure, recomputed against commit-time cur.slots/
    // cur.capacity (wrapping the old stale computation in mutate() would
    // have kept the bug wearing a hat, same trap as everywhere else in this
    // ticket). Inventory's removal (the source) is dependent on that claim
    // and re-locates the item by identity — destination-first means a
    // decline never removes the player's item without it landing in the
    // buffer.
    let claimedDst = -1;
    world.mutate(stationId, WorkstationBuffer, (cur) => {
      const newSlots: (typeof cur.slots[number])[] = [...cur.slots];
      let dst = bufferSlot;
      if (dst >= cur.capacity) {
        // Prefer merging with an existing matching stack first (stack→stack only).
        if (slot.kind === "stack") {
          dst = newSlots.findIndex((s) => s !== null && s.kind === "stack" && s.itemType === slot.prefabId);
        } else {
          dst = -1;
        }
        if (dst === -1) dst = newSlots.findIndex((s) => s === null);
        if (dst === -1 && newSlots.length < cur.capacity) dst = newSlots.length;
        if (dst === -1) {
          log.debug("load: station=%s buffer full", stationId);
          return cur;
        }
      }

      const existing = newSlots[dst] ?? null;
      if (slot.kind === "stack") {
        if (existing && (existing.kind !== "stack" || existing.itemType !== slot.prefabId)) {
          log.debug("load: station=%s slot=%d incompatible with existing", stationId, dst);
          return cur;
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
          return cur;
        }
        newSlots[dst] = { kind: "unique", entityId: slot.entityId, prefabId: slotPrefab };
      }
      while (newSlots.length <= dst) newSlots.push(null);

      claimedDst = dst;
      log.info("load: player=%s item=%s → station=%s slot=%d", playerId, describeSlot(newSlots[dst]!), stationId, dst);
      return { ...cur, slots: newSlots };
    });

    world.mutate(playerId, Inventory, (cur) => {
      if (claimedDst === -1) return cur;
      const idx = findByIdentity(cur.slots, sourceIdentity, inventorySlot);
      if (idx === -1) return cur; // source slot vanished by commit time — narrow residual, see equipment.ts's identical shape
      return { ...cur, slots: cur.slots.filter((_, i) => i !== idx) };
    });
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

    if (!world.get(playerId, Inventory)) return;

    // T-344 follow-up: 3-closure claim/commit/revert, not destination-
    // first COUPLED-DECLINE. WorkstationBuffer (the SOURCE) is the
    // actually-shared/contested resource — a station can be worked by
    // MULTIPLE players in the same tick (that's the whole point of a
    // shared crafting bench), each Taking INTO their own private
    // Inventory. The original destination-first ordering here (Inventory
    // claims capacity first, WorkstationBuffer's removal dependent) let
    // two different players both "win" a race to Take the SAME buffer
    // slot: each player's own-inventory capacity check has nothing to do
    // with whether the OTHER player already has it, so both claimed
    // successfully before either's buffer-side removal ran, duplicating
    // the item. Fixed the same way as `systems/container.ts`'s withdraw:
    // WorkstationBuffer claims (nulls) the slot FIRST via TARGETED-
    // DECLINE (re-locates by identity rather than trusting bufferSlot
    // literally — an earlier same-tick Load/Take on this SAME station can
    // shift it); Inventory's grant is dependent on that claim AND does
    // its own commit-time capacity recheck; WorkstationBuffer reverts
    // (puts the slot back) if the player turned out to have no room, so a
    // losing race never strands the item — it just stays in the buffer.
    const newInvSlot: InventorySlot = slot.kind === "stack"
      ? { kind: "stack", prefabId: slot.itemType, quantity: slot.quantity }
      : { kind: "unique", entityId: slot.entityId };
    let claimedIdx = -1;
    world.mutate(stationId, WorkstationBuffer, (cur) => {
      const idx = findWorkstationSlot(cur.slots, slot, bufferSlot);
      if (idx === -1) return cur; // already taken by an earlier same-tick op
      claimedIdx = idx;
      const newSlots = [...cur.slots];
      newSlots[idx] = null;
      return { ...cur, slots: newSlots };
    });
    let granted = false;
    world.mutate(playerId, Inventory, (cur) => {
      if (claimedIdx === -1) return cur;
      if (cur.slots.length >= cur.capacity) {
        log.debug("take: player=%s inventory full", playerId);
        return cur;
      }
      granted = true;
      return { ...cur, slots: [...cur.slots, newInvSlot] };
    });
    world.mutate(stationId, WorkstationBuffer, (cur) => {
      if (claimedIdx === -1 || granted) return cur;
      if (cur.slots[claimedIdx] !== null) return cur; // defensive — shouldn't happen
      const newSlots = [...cur.slots];
      newSlots[claimedIdx] = slot;
      return { ...cur, slots: newSlots };
    });
    log.info("take: player=%s station=%s slot=%d item=%s",
      playerId, stationId, bufferSlot, describeSlot(slot));
  }

  /** Read an item-entity's prefab id from its ItemData component. */
  private resolveUniquePrefab(world: World, entityId: string): string {
    const data = world.get(entityId as EntityId, ItemData);
    return data?.prefabId ?? "";
  }

  /**
   * Pick up the named ground-item entity into the player's inventory.
   * Validates: (a) entity exists with ItemData + Position, (b) player is
   * within the configured pickup range, (c) inventory has free space.
   *
   * Stack items merge with an existing matching stack; otherwise occupy a
   * new slot. Unique items always take their own slot. The world entity is
   * destroyed once consumed (stack) or moved into inventory (unique).
   */
  private _handlePickUp(world: World, playerId: EntityId, entityId: string): void {
    const item = world.get(entityId as EntityId, ItemData);
    const itemPos = world.get(entityId as EntityId, Position);
    if (!item || !itemPos) {
      log.debug("pickup: entity=%s missing ItemData/Position", entityId);
      return;
    }
    const playerPos = world.get(playerId, Position);
    if (!playerPos) return;

    const pickupRadius = this.content.getGameConfig().items.pickupRadius;
    const dx = playerPos.x - itemPos.x;
    const dy = playerPos.y - itemPos.y;
    if (dx * dx + dy * dy > pickupRadius * pickupRadius) {
      log.debug("pickup: player=%s entity=%s out of range", playerId, entityId);
      return;
    }

    const inv = world.get(playerId, Inventory);
    if (!inv) return;

    // Stack items: merge into an existing matching stack if any, otherwise
    // append a new stack slot. Unique items always take a fresh unique slot.
    // The prefab decides via the `stackable: {}` component declaration.
    const prefab = this.content.prefabs.get(item.prefabId);
    const isStackable = prefab?.components["stackable"] !== undefined;

    // Synchronous capacity pre-check against the once-per-command stale
    // read — same shape as the pre-T-344 code, so the ordinary (non-racy)
    // "inventory already full" case still leaves the ground item on the
    // ground, untouched, exactly as before: a merge never needs room, a
    // fresh slot does.
    const willMerge = isStackable && inv.slots.some((s) => s.kind === "stack" && s.prefabId === item.prefabId);
    if (!willMerge && inv.slots.length >= inv.capacity) {
      log.debug("pickup: inventory full");
      return;
    }

    // T-344 residual: this system's command loop does not break after one
    // command, so "two PickUp commands while walking through a loot pile
    // in one tick" is a real, reachable path — the mutate's own fresh
    // recheck below handles that correctly (composes or declines against
    // commit-time state, not the stale pre-check above). But the stack
    // path's world.destroy (and the unique path's world.remove(Position))
    // are irreversible/unconditional once the pre-check above passes: if a
    // SAME-tick race then fills the last slot before this command's own
    // mutate runs, the ground item is still consumed with nothing gained.
    // Narrow (needs a second same-tick capacity-consuming command for the
    // SAME player) and documented, not papered over — closing it needs a
    // "defer the side effect until the mutate commits" primitive this
    // engine doesn't have (same class as gather_resource.ts's collectDrop).
    if (isStackable) {
      world.destroy(entityId as EntityId);
    } else {
      // Strip Position so the unique entity stops being a world thing —
      // it'll re-spawn at a new position only if dropped again.
      world.remove(entityId as EntityId, Position);
    }

    world.mutate(playerId, Inventory, (cur) => {
      if (isStackable) {
        const merged = cur.slots.findIndex((s) => s.kind === "stack" && s.prefabId === item.prefabId);
        if (merged !== -1) {
          const existing = cur.slots[merged] as { kind: "stack"; prefabId: string; quantity: number };
          return {
            ...cur,
            slots: cur.slots.map((s, i) => i === merged
              ? { kind: "stack" as const, prefabId: item.prefabId, quantity: existing.quantity + item.quantity }
              : s),
          };
        }
        if (cur.slots.length >= cur.capacity) {
          log.debug("pickup: inventory full");
          return cur;
        }
        return { ...cur, slots: [...cur.slots, { kind: "stack" as const, prefabId: item.prefabId, quantity: item.quantity }] };
      }
      if (cur.slots.length >= cur.capacity) {
        log.debug("pickup: inventory full");
        return cur;
      }
      return { ...cur, slots: [...cur.slots, { kind: "unique" as const, entityId }] };
    });
    log.info("pickup: player=%s item=%s qty=%d", playerId, item.prefabId, item.quantity);
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
  content: ContentService,
  stationType: string,
  stepType: Recipe["stepType"],
  bufferSlots: WorkstationBufferData["slots"],
): RecipeMatch | null {
  for (const recipe of content.recipes.values()) {
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
  content: ContentService,
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

/**
 * T-344: the WorkstationBuffer-slot analogue of inventory_ops.ts's
 * findByIdentity — re-locate a captured WorkstationSlot inside `slots` at
 * commit time (hint index first, full scan fallback) instead of trusting a
 * pre-closure index literally. Separate from inventory_ops.ts because
 * WorkstationSlot's shape differs from InventorySlot's (itemType vs
 * prefabId for the stack case) — not worth a shared generic over two
 * call sites.
 */
function findWorkstationSlot(slots: WorkstationBufferData["slots"], target: WorkstationSlot, hintIndex?: number): number {
  const matches = (s: WorkstationBufferData["slots"][number]): boolean => {
    if (!s || s.kind !== target.kind) return false;
    return s.kind === "stack"
      ? s.itemType === (target as Extract<WorkstationSlot, { kind: "stack" }>).itemType
      : s.entityId === (target as Extract<WorkstationSlot, { kind: "unique" }>).entityId;
  };
  if (hintIndex !== undefined && hintIndex >= 0 && hintIndex < slots.length && matches(slots[hintIndex])) {
    return hintIndex;
  }
  return slots.findIndex(matches);
}

function inputSpecificity(input: Recipe["inputs"][number]): number {
  if ("itemType" in input && input.itemType !== undefined) return 2;
  if ("tags" in input && (input.tags?.length ?? 0) > 0) return 1;
  return 0;
}

function inputAccepts(input: Recipe["inputs"][number], prefabId: string, content: ContentService): boolean {
  if ("itemType" in input && input.itemType !== undefined) {
    return prefabId === input.itemType;
  }
  if ("category" in input && input.category !== undefined) {
    const prefab = content.prefabs.get(prefabId);
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
  content: ContentService,
  stationId: EntityId,
  output: RecipeOutput,
  match: RecipeMatch,
  bufferSlotsBeforeConsume: WorkstationBufferData["slots"],
): void {
  const prefab = content.prefabs.get(output.itemType);
  const pos = world.get(stationId, Position);
  const x = (pos?.x ?? 0) + 0.5;
  const y = (pos?.y ?? 0) + 0.5;
  const z = pos?.z ?? 4.0;

  const hasStats = output.stats !== undefined && Object.keys(output.stats).length > 0;
  const isStackable = prefab?.components["stackable"] !== undefined && !hasStats;
  if (isStackable || !prefab) {
    spawnGroundStack(world, content, output.itemType, output.quantity, { x, y, z });
    return;
  }

  const tag = world.get(stationId, WorkstationTag);
  const quality = clamp01(tag?.qualityTier ?? 1);
  const computedStats = hasStats
    ? evaluateOutputStats(world, output.stats!, match, bufferSlotsBeforeConsume, content, tag?.qualityTier ?? 1)
    : null;
  const provenance = buildProvenance(world, match, bufferSlotsBeforeConsume);

  // Stat-bearing outputs always spawn one entity per unit (uniques don't
  // stack). Outputs without stats may still be uniques (sword, etc.).
  const n = Math.max(1, output.quantity);
  for (let i = 0; i < n; i++) {
    const id = spawnPrefab(world, content, output.itemType, { x, y, z });
    world.write(id, ItemData, { prefabId: output.itemType, quantity: 1 });
    world.write(id, QualityStamped, { quality });
    installDurability(world, content, id, output.itemType); // T-086

    if (computedStats) {
      world.write(id, Stats, { ...computedStats });
    }
    if (provenance.length > 0) {
      world.write(id, Provenance, provenance);
    }
  }
}

/**
 * Snapshot which prefab id (variant) filled each role at craft time. Read by
 * tooltips and the procedural display-name builder. Walks the assigned
 * buffer slots and resolves each slot's prefab id (stack: itemType, unique:
 * carried prefabId).
 */
function buildProvenance(
  _world: World,
  match: RecipeMatch,
  bufferSlots: WorkstationBufferData["slots"],
): ProvenanceData {
  const out: { role: string; prefabId: string }[] = [];
  for (const input of match.recipe.inputs) {
    const idx = match.assignment.get(input.role);
    if (idx === undefined) continue;
    const slot = bufferSlots[idx];
    if (!slot) continue;
    out.push({ role: input.role, prefabId: slot.kind === "stack" ? slot.itemType : slot.prefabId });
  }
  return out;
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
  content: ContentService,
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
      stats = content.prefabs.get(slot.itemType)?.stats ?? {};
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

