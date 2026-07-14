import type { World } from "@voxim/engine";
import { TileEvents } from "@voxim/protocol";
import { Heightmap, MaterialGrid, CHUNK_SIZE } from "@voxim/world";
import type { EventEmitter } from "../system.ts";
import type { HitHandler, HitContext } from "../hit_handler.ts";
import { Blueprint } from "../components/building.ts";
import type { BlueprintData, BlueprintMaterial } from "../components/building.ts";
import { Inventory } from "../components/items.ts";
import type { InventorySlot } from "../components/items.ts";
import { buildChunkIndex } from "../physics/terrain_lookup.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("BlueprintHitHandler");

/**
 * Handles hits on entities that have a Blueprint component. Construction is
 * driven by swinging a hammer at the blueprint entity.
 *
 * First hammer swing: deducts material cost from attacker's inventory.
 * Subsequent swings: each reduces ticksRemaining by buildPower.
 * When ticksRemaining reaches 0: applies terrain change and destroys the blueprint entity.
 */
export class BlueprintHitHandler implements HitHandler {
  // T-333: dispatch bubbles to the nearest ancestor carrying Blueprint.
  readonly requiredComponent = Blueprint;

  onHit(world: World, events: EventEmitter, ctx: HitContext): void {
    const blueprint = world.get(ctx.targetId, Blueprint);
    if (!blueprint) {
      log.debug("onHit: target=%s has no Blueprint component", ctx.targetId);
      return;
    }

    // Only a hammer can advance construction
    if (ctx.weaponStats.toolType !== "hammer") {
      log.info("onHit: target=%s is blueprint but weapon toolType=%s (need hammer)", ctx.targetId, ctx.weaponStats.toolType ?? "none");
      return;
    }

    const buildPower = ctx.weaponStats.buildPower ?? 1;
    log.info("onHit: attacker=%s target=%s structure=%s materialsDeducted=%s ticks=%d buildPower=%d",
      ctx.attackerId, ctx.targetId, blueprint.structureType, blueprint.materialsDeducted, blueprint.ticksRemaining, buildPower);

    // ── Step 1: consume materials on first swing ──────────────────────────────
    if (!blueprint.materialsDeducted) {
      const inv = world.get(ctx.attackerId, Inventory);
      if (!inv) {
        log.warn("onHit: attacker=%s has no Inventory", ctx.attackerId);
        return;
      }

      const missing = missingMaterials(inv.slots, blueprint.materialCost);
      if (missing.length > 0) {
        log.info("onHit: missing materials for %s: %s", blueprint.structureType,
          missing.map((m) => `${m.quantity}x${m.itemType}`).join(", "));
        events.publish(TileEvents.BuildingMissingMaterials, {
          builderId: ctx.attackerId,
          structureType: blueprint.structureType,
          missing,
        });
        return;
      }

      // T-344: two real players landing the FIRST hammer-hit on one fresh
      // blueprint in the same tick — the exact co-op scenario this
      // ticket's own text names ("a trade settles while a blueprint
      // consumes materials") — is a 2-closure COUPLED-DECLINE failure in
      // BOTH directions: gate-Blueprint-first risks double-charging (both
      // attackers' materials checks above already passed against the SAME
      // stale pre-tick Inventory read, so both would proceed once the
      // flag looks claimable); gate-Inventory-first risks flipping
      // materialsDeducted true for an attacker whose OWN materials check
      // then fails at commit time, granting free construction progress
      // with nothing paid. A 3-closure claim/commit/revert closes both:
      // (1) Blueprint tentatively claims the flag; (2) Inventory only
      // proceeds if claimed, and does its own commit-time recheck before
      // consuming; (3) Blueprint reverts the claim if this attacker
      // couldn't actually pay. Sound for the same push-order reason every
      // other coupled pair in this ticket relies on (inventory_ops.ts).
      let claimed = false;
      world.mutate(ctx.targetId, Blueprint, (cur) => {
        if (cur.materialsDeducted) return cur; // already claimed — by us or another attacker's earlier op this tick
        claimed = true;
        return { ...cur, materialsDeducted: true };
      });
      let charged = false;
      world.mutate(ctx.attackerId, Inventory, (cur) => {
        if (!claimed) return cur;
        if (missingMaterials(cur.slots, blueprint.materialCost).length > 0) return cur; // claimed but can't actually pay — reverted below
        charged = true;
        return { ...cur, slots: consumeMaterials(cur.slots, blueprint.materialCost) };
      });
      world.mutate(ctx.targetId, Blueprint, (cur) => (claimed && !charged ? { ...cur, materialsDeducted: false } : cur));

      log.info(
        "build started: worker=%s structure=%s ticks=%d",
        ctx.attackerId,
        blueprint.structureType,
        blueprint.ticksRemaining,
      );
      // T-344: optimistic — fires from this attacker's own pre-mutate
      // missing-materials check, which is the common (non-racing) case;
      // matches the established pattern elsewhere in this codebase
      // (health_hit_handler.ts computes its decisions from the pre-mutate
      // local read too). In the narrow same-tick race this event can fire
      // for an attacker whose claim/charge ultimately declined.
      events.publish(TileEvents.BuildingMaterialsConsumed, {
        builderId: ctx.attackerId,
        structureType: blueprint.structureType,
        consumed: blueprint.materialCost,
      });
      return;
    }

    // ── Step 2: advance construction ──────────────────────────────────────────
    const newTicks = blueprint.ticksRemaining - buildPower;
    if (newTicks > 0) {
      if (Math.floor(newTicks) % 20 === 0) {
        log.debug(
          "build progress: structure=%s ticks_remaining=%d",
          blueprint.structureType,
          newTicks,
        );
      }
      // T-344: composing mutate, not set — two attackers hammering the SAME
      // blueprint in the same tick (the steady-state co-op case, more
      // common than the one-time materials claim above) both subtract
      // buildPower from whatever committed state this tick's earlier ops
      // left behind, instead of the second's stale read clobbering the
      // first's progress. Outside T-344's literal "Inventory" scope but
      // directly adjacent (same file, same method, same shape) — found
      // while fixing the named site.
      world.mutate(ctx.targetId, Blueprint, (cur) => ({ ...cur, ticksRemaining: cur.ticksRemaining - buildPower }));
      return;
    }

    // ── Step 3: complete ──────────────────────────────────────────────────────
    applyToTerrain(world, blueprint);
    log.info("build complete: worker=%s structure=%s", ctx.attackerId, blueprint.structureType);

    events.publish(TileEvents.BuildingCompleted, {
      builderId: ctx.attackerId,
      blueprintId: ctx.targetId,
      structureType: blueprint.structureType,
    });

    world.destroy(ctx.targetId);
  }
}

/** Returns the items (and shortfall quantities) that are missing from slots. Empty = have all. */
function missingMaterials(slots: InventorySlot[], cost: BlueprintMaterial[]): BlueprintMaterial[] {
  const available = new Map<string, number>();
  for (const s of slots) {
    if (s.kind === "stack") available.set(s.prefabId, (available.get(s.prefabId) ?? 0) + s.quantity);
  }
  const missing: BlueprintMaterial[] = [];
  for (const c of cost) {
    const have = available.get(c.itemType) ?? 0;
    if (have < c.quantity) missing.push({ itemType: c.itemType, quantity: c.quantity - have });
  }
  return missing;
}

function consumeMaterials(slots: InventorySlot[], cost: BlueprintMaterial[]): InventorySlot[] {
  const m = new Map<string, number>();
  for (const s of slots) {
    if (s.kind === "stack") m.set(s.prefabId, (m.get(s.prefabId) ?? 0) + s.quantity);
  }
  for (const c of cost) m.set(c.itemType, (m.get(c.itemType) ?? 0) - c.quantity);
  const stacks: InventorySlot[] = Array.from(m.entries())
    .filter(([, qty]) => qty > 0)
    .map(([prefabId, quantity]) => ({ kind: "stack" as const, prefabId, quantity }));
  return [...stacks, ...slots.filter((s) => s.kind === "unique")];
}

function applyToTerrain(world: World, blueprint: BlueprintData): void {
  const chunk = buildChunkIndex(world).get(`${blueprint.chunkX},${blueprint.chunkY}`);
  if (!chunk) return;
  const { entityId: chunkId, heightmap } = chunk;

  const idx = blueprint.localX + blueprint.localY * CHUNK_SIZE;

  if (blueprint.heightDelta !== 0) {
    const newData = new Float32Array(heightmap.data);
    newData[idx] = heightmap.data[idx] + blueprint.heightDelta;
    world.set(chunkId, Heightmap, { ...heightmap, data: newData });
  }

  const matGrid = world.get(chunkId, MaterialGrid);
  if (matGrid) {
    const newMats = new Uint16Array(matGrid.data);
    newMats[idx] = blueprint.materialId;
    world.set(chunkId, MaterialGrid, { ...matGrid, data: newMats });
  }
}
