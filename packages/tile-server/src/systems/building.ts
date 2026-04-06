import type { World } from "@voxim/engine";
import { TileEvents } from "@voxim/protocol";
import { ACTION_INTERACT, hasAction } from "@voxim/protocol";
import { Heightmap, MaterialGrid, CHUNK_SIZE } from "@voxim/world";

import type { System, EventEmitter, TickContext } from "../system.ts";
import type { SpatialGrid } from "../spatial_grid.ts";
import { Position, InputState } from "../components/game.ts";
import { Inventory } from "../components/items.ts";
import type { InventorySlot } from "../components/items.ts";
import { Blueprint } from "../components/building.ts";
import type { BlueprintData, BlueprintMaterial } from "../components/building.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("BuildingSystem");
const INTERACT_RANGE_SQ = 2.0 * 2.0;

export class BuildingSystem implements System {
  private spatial: SpatialGrid | null = null;

  prepare(_serverTick: number, ctx: TickContext): void {
    this.spatial = ctx.spatial;
  }

  run(world: World, events: EventEmitter, _dt: number): void {
    for (const { entityId: blueprintId, blueprint, position: bpPos } of world.query(Blueprint, Position)) {
      const worker = findNearbyWorker(world, this.spatial, bpPos.x, bpPos.y);
      if (!worker) continue;

      // ── Step 1: consume materials on first interaction ────────────────────
      if (!blueprint.materialsDeducted) {
        const inv = world.get(worker.entityId, Inventory);
        if (!inv || !hasMaterials(inv.slots, blueprint.materialCost)) continue;

        world.set(worker.entityId, Inventory, {
          ...inv,
          slots: consumeMaterials(inv.slots, blueprint.materialCost),
        });
        world.set(blueprintId, Blueprint, { ...blueprint, materialsDeducted: true });
        log.info("build started: worker=%s structure=%s ticks=%d",
          worker.entityId, blueprint.structureType, blueprint.ticksRemaining);
        continue;
      }

      // ── Step 2: advance construction ──────────────────────────────────────
      const newTicks = blueprint.ticksRemaining - 1;
      if (newTicks > 0) {
        if (newTicks % 20 === 0) {
          log.debug("build progress: structure=%s ticks_remaining=%d", blueprint.structureType, newTicks);
        }
        world.set(blueprintId, Blueprint, { ...blueprint, ticksRemaining: newTicks });
        continue;
      }

      // ── Step 3: complete ─────────────────────────────────────────────────
      applyToTerrain(world, blueprint);
      log.info("build complete: worker=%s structure=%s", worker.entityId, blueprint.structureType);

      events.publish(TileEvents.BuildingCompleted, {
        builderId: worker.entityId,
        blueprintId,
        structureType: blueprint.structureType,
      });

      world.destroy(blueprintId);
    }
  }
}

function findNearbyWorker(world: World, spatial: SpatialGrid | null, x: number, y: number): { entityId: string } | null {
  const range = Math.sqrt(INTERACT_RANGE_SQ);
  const candidates = spatial
    ? spatial.nearby(x, y, range)
    : world.query(InputState, Position).map((r) => r.entityId);
  for (const entityId of candidates) {
    const inputState = world.get(entityId, InputState);
    if (!inputState || !hasAction(inputState.actions, ACTION_INTERACT)) continue;
    const position = world.get(entityId, Position);
    if (!position) continue;
    const dx = position.x - x;
    const dy = position.y - y;
    if (dx * dx + dy * dy <= INTERACT_RANGE_SQ) return { entityId };
  }
  return null;
}

function hasMaterials(slots: InventorySlot[], cost: BlueprintMaterial[]): boolean {
  const available = new Map<string, number>();
  for (const s of slots) available.set(s.itemType, (available.get(s.itemType) ?? 0) + s.quantity);
  return cost.every((c) => (available.get(c.itemType) ?? 0) >= c.quantity);
}

function consumeMaterials(slots: InventorySlot[], cost: BlueprintMaterial[]): InventorySlot[] {
  const m = new Map<string, number>();
  for (const s of slots) m.set(s.itemType, (m.get(s.itemType) ?? 0) + s.quantity);
  for (const c of cost) m.set(c.itemType, (m.get(c.itemType) ?? 0) - c.quantity);
  return Array.from(m.entries()).filter(([, qty]) => qty > 0).map(([itemType, quantity]) => ({ itemType, quantity }));
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
