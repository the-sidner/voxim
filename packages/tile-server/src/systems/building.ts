import type { World } from "@voxim/engine";
import { CommandType } from "@voxim/protocol";
import type { CommandPayload } from "@voxim/protocol";
import type { ContentStore } from "@voxim/content";
import type { System, EventEmitter, TickContext } from "../system.ts";
import { Position } from "../components/game.ts";
import { Equipment } from "../components/equipment.ts";
import { Blueprint } from "../components/building.ts";
import { spawnPrefab } from "../spawner.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("BuildingSystem");

const CHUNK_SIZE = 32;

/**
 * BuildingSystem — handles PlaceBlueprint commands.
 *
 * Validates placement (hammer equipped, within reach, cell unoccupied),
 * spawns the requested blueprint prefab, and overwrites its Blueprint
 * component with the cell-specific runtime coordinates. The prefab carries
 * the static build parameters (heightDelta, materialCost, totalTicks); the
 * system fills in chunkX/Y, localX/Y before the tick ends.
 *
 * Construction (swinging at the blueprint) is handled entirely by
 * BlueprintHitHandler — this system only handles spawning.
 */
export class BuildingSystem implements System {
  private _commands: ReadonlyMap<string, CommandPayload[]> = new Map();

  constructor(private readonly content: ContentStore) {}

  prepare(_serverTick: number, ctx: TickContext): void {
    this._commands = ctx.pendingCommands;
  }

  run(world: World, _events: EventEmitter, _dt: number): void {
    for (const [entityId, commands] of this._commands) {
      if (!world.isAlive(entityId)) continue;

      for (const cmd of commands) {
        if (cmd.cmd !== CommandType.PlaceBlueprint) continue;
        this._handlePlace(world, entityId, cmd.structureType, cmd.worldX, cmd.worldY);
      }
    }
  }

  private _handlePlace(
    world: World,
    placerId: string,
    structureType: string,
    worldX: number,
    worldY: number,
  ): void {
    const prefab = this.content.getPrefab(structureType);
    if (!prefab || !prefab.components.blueprint) {
      log.warn("PlaceBlueprint: unknown structureType=%s", structureType);
      return;
    }

    // Placer must have a hammer equipped
    const equipment = world.get(placerId, Equipment);
    if (!equipment?.weapon) return;
    const stats = this.content.deriveItemStats(equipment.weapon.itemType, equipment.weapon.parts);
    if (stats.toolType !== "hammer") return;

    // Placer must be within reach
    const pos = world.get(placerId, Position);
    if (!pos) return;
    const maxReach = this.content.getGameConfig().building.maxReachWorldUnits;
    const cellCX = Math.floor(worldX) + 0.5;
    const cellCY = Math.floor(worldY) + 0.5;
    const dx = pos.x - cellCX;
    const dy = pos.y - cellCY;
    if (dx * dx + dy * dy > maxReach * maxReach) {
      log.warn(
        "PlaceBlueprint: out of reach placer=%s dist=%.1f",
        placerId,
        Math.sqrt(dx * dx + dy * dy),
      );
      return;
    }

    // Cell must not already have a blueprint
    const cellX = Math.floor(worldX);
    const cellY = Math.floor(worldY);
    for (const { blueprint } of world.query(Blueprint)) {
      const bx = blueprint.chunkX * CHUNK_SIZE + blueprint.localX;
      const by = blueprint.chunkY * CHUNK_SIZE + blueprint.localY;
      if (bx === cellX && by === cellY) {
        log.warn("PlaceBlueprint: cell already occupied x=%d y=%d", cellX, cellY);
        return;
      }
    }

    // Place blueprint at cell center so it is swing-targetable.
    const chunkX = Math.floor(cellX / CHUNK_SIZE);
    const chunkY = Math.floor(cellY / CHUNK_SIZE);
    const localX = ((cellX % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
    const localY = ((cellY % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
    const id = spawnPrefab(world, this.content, structureType, {
      x: cellX + 0.5, y: cellY + 0.5, z: pos.z,
    });

    // Patch in cell coordinates — the prefab can't know these statically.
    const bp = world.get(id, Blueprint);
    if (bp) world.write(id, Blueprint, { ...bp, chunkX, chunkY, localX, localY });

    log.info(
      "blueprint placed: placer=%s type=%s cell=(%d,%d)",
      placerId, structureType, cellX, cellY,
    );
  }
}
