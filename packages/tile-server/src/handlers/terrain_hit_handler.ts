/**
 * TerrainDigSystem — shovel swing lowers a terrain cell's height (T-034/T-035).
 *
 * Runs as a System (not a HitHandler) because terrain has no entity to hit.
 * Fires on the first tick of the active phase for shovel-wielding entities.
 * Targets the cell 1 unit in front of the player along their facing direction.
 *
 * T-034: reduces Heightmap cell by digStep * digPower (snapped to HEIGHT_STEP).
 * T-035: spawns a material drop (dirt, stone, etc.) based on the cell's MaterialGrid value.
 *        Drop always spawns as a world ItemData entity; picked up by ItemPickupSystem.
 */
import type { World } from "@voxim/engine";
import { newEntityId } from "@voxim/engine";
import { Heightmap, MaterialGrid, CHUNK_SIZE, snapHeight } from "@voxim/world";
import type { ContentStore } from "@voxim/content";
import type { System, EventEmitter } from "../system.ts";
import { Position, InputState } from "../components/game.ts";
import { SkillInProgress } from "../components/combat.ts";
import { Equipment } from "../components/equipment.ts";
import { ItemData } from "../components/items.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("TerrainDigSystem");

export class TerrainDigSystem implements System {
  /**
   * Reads InputState (NpcAi writes via world.write()) and SkillInProgress
   * (Action writes via world.write() on swing start); both must precede.
   */
  readonly dependsOn = ["NpcAiSystem", "ActionSystem"];

  constructor(private readonly content: ContentStore) {}

  run(world: World, _events: EventEmitter, _dt: number): void {
    const cfg = this.content.getGameConfig().terrain;
    const digReach = cfg.digReach;

    for (const { entityId, skillInProgress, position } of world.query(SkillInProgress, Position)) {
      // Fire only on the first tick of the active phase (prevents multi-dig per swing)
      if (skillInProgress.phase !== "active" || skillInProgress.ticksInPhase !== 0) continue;

      const equip = world.get(entityId, Equipment);
      if (!equip?.weapon) continue;
      const weaponPrefabId = equip.weapon.prefabId;
      const stats = this.content.deriveItemStats(weaponPrefabId);
      if (stats.toolType !== "shovel") continue;

      const digPower = stats.digPower ?? 1;
      const totalDig = snapHeight(cfg.digStep * digPower);
      if (totalDig <= 0) continue;

      // Target the cell 1 unit ahead along the player's facing direction
      const facing = world.get(entityId, InputState)?.facing ?? 0;
      const targetX = position.x + Math.sin(facing) * 1.0;
      const targetY = position.y + Math.cos(facing) * 1.0;

      const cellX = Math.floor(targetX);
      const cellY = Math.floor(targetY);
      const cx = cellX + 0.5;
      const cy = cellY + 0.5;
      const dx = position.x - cx;
      const dy = position.y - cy;
      if (dx * dx + dy * dy > digReach * digReach) continue;

      const chunkX = Math.floor(cellX / CHUNK_SIZE);
      const chunkY = Math.floor(cellY / CHUNK_SIZE);
      const localX = ((cellX % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
      const localY = ((cellY % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
      const idx = localX + localY * CHUNK_SIZE;

      for (const { entityId: chunkId, heightmap } of world.query(Heightmap)) {
        if (heightmap.chunkX !== chunkX || heightmap.chunkY !== chunkY) continue;

        const currentHeight = heightmap.data[idx];
        const newHeight = Math.max(cfg.minDigHeight, snapHeight(currentHeight - totalDig));
        if (newHeight >= currentHeight) break; // already at or below minimum

        const newData = new Float32Array(heightmap.data);
        newData[idx] = newHeight;
        world.set(chunkId, Heightmap, { ...heightmap, data: newData });

        // T-035: material drop — always spawn as world entity, picked up by ItemPickupSystem
        const matGrid = world.get(chunkId, MaterialGrid);
        if (matGrid) {
          const matId = matGrid.data[idx];
          const dropType = cfg.materialDrops[String(matId)];
          if (dropType) {
            const dropId = newEntityId();
            world.create(dropId);
            world.write(dropId, Position, { x: cx, y: cy, z: currentHeight });
            world.write(dropId, ItemData, { prefabId: dropType, quantity: 1 });
          }
        }

        log.info("dug: entity=%s cell=(%d,%d) %.2f→%.2f", entityId, cellX, cellY, currentHeight, newHeight);
        break;
      }
    }
  }
}
