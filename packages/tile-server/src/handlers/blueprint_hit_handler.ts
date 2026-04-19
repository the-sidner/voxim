import type { World } from "@voxim/engine";
import { TileEvents } from "@voxim/protocol";
import { Heightmap, MaterialGrid, CHUNK_SIZE } from "@voxim/world";
import type { EventEmitter } from "../system.ts";
import type { HitHandler, HitContext } from "../hit_handler.ts";
import { Blueprint } from "../components/building.ts";
import type { BlueprintData, BlueprintMaterial } from "../components/building.ts";
import { Inventory } from "../components/items.ts";
import type { InventorySlot } from "../components/items.ts";
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

      world.set(ctx.attackerId, Inventory, {
        ...inv,
        slots: consumeMaterials(inv.slots, blueprint.materialCost),
      });
      world.set(ctx.targetId, Blueprint, { ...blueprint, materialsDeducted: true });
      log.info(
        "build started: worker=%s structure=%s ticks=%d",
        ctx.attackerId,
        blueprint.structureType,
        blueprint.ticksRemaining,
      );
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
      world.set(ctx.targetId, Blueprint, { ...blueprint, ticksRemaining: newTicks });
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
  for (const { entityId: chunkId, heightmap } of world.query(Heightmap)) {
    if (heightmap.chunkX !== blueprint.chunkX || heightmap.chunkY !== blueprint.chunkY) continue;

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
    break;
  }
}
