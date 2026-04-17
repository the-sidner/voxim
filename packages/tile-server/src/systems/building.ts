import type { World } from "@voxim/engine";
import { CommandType } from "@voxim/protocol";
import type { CommandPayload } from "@voxim/protocol";
import type { ContentStore } from "@voxim/content";
import type { System, EventEmitter, TickContext } from "../system.ts";
import { Position } from "../components/game.ts";
import { Equipment } from "../components/equipment.ts";
import { Blueprint } from "../components/building.ts";
import { spawnBlueprint } from "../spawner.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("BuildingSystem");

/**
 * BuildingSystem — handles PlaceBlueprint commands.
 *
 * Validates placement (hammer equipped, within reach, cell unoccupied) and
 * calls spawnBlueprint() to create the Blueprint entity.
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
    // Structure type must exist
    const def = this.content.getStructureDef(structureType);
    if (!def) {
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
      const bx = blueprint.chunkX * 32 + blueprint.localX;
      const by = blueprint.chunkY * 32 + blueprint.localY;
      if (bx === cellX && by === cellY) {
        log.warn("PlaceBlueprint: cell already occupied x=%d y=%d", cellX, cellY);
        return;
      }
    }

    const id = spawnBlueprint(world, this.content, {
      structureType,
      worldX,
      worldY,
      surfaceZ: pos.z,
    });

    if (id) {
      log.info(
        "blueprint placed: placer=%s type=%s cell=(%d,%d)",
        placerId,
        structureType,
        cellX,
        cellY,
      );
    }
  }
}
