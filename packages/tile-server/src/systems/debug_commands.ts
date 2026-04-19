/**
 * DebugCommandSystem — handles all dev-mode debug commands in one place.
 *
 * Gated by devMode: every command is silently ignored when devMode is false.
 * This keeps debug logic isolated from gameplay systems (EquipmentSystem,
 * PhysicsSystem, etc.) and makes it trivial to add new debug commands:
 *   1. Add a CommandType entry in protocol/src/messages.ts
 *   2. Add encode/decode in protocol/src/codecs.ts
 *   3. Add a case here
 *
 * Commands handled:
 *   DebugGiveItem  — add an item directly to player inventory
 *   DebugSpawnNpc  — spawn one or more NPCs at the player's position
 *   DebugSetTime   — snap the world clock to a specific hour (0–24)
 *   DebugTeleport  — teleport the player to world coordinates (X, Y)
 *   DebugSetStat   — set health or stamina to an exact value
 */
import type { World, EntityId } from "@voxim/engine";
import { CommandType } from "@voxim/protocol";
import type { ContentStore } from "@voxim/content";
import type { System, EventEmitter, TickContext } from "../system.ts";
import type { CommandPayload } from "@voxim/protocol";
import { Position, Health, Stamina } from "../components/game.ts";
import { Inventory } from "../components/items.ts";
import type { InventorySlot } from "../components/items.ts";
import { WorldClock } from "../components/world.ts";
import { spawnPrefab } from "../spawner.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("DebugCommandSystem");

export class DebugCommandSystem implements System {
  private _commands: ReadonlyMap<string, CommandPayload[]> = new Map();

  constructor(
    private readonly content: ContentStore,
    private readonly devMode: boolean,
  ) {}

  prepare(_tick: number, ctx: TickContext): void {
    this._commands = ctx.pendingCommands;
  }

  run(world: World, _events: EventEmitter, _dt: number): void {
    if (!this.devMode) return;

    for (const [entityId, commands] of this._commands) {
      for (const cmd of commands) {
        switch (cmd.cmd) {
          case CommandType.DebugGiveItem:
            this._giveItem(world, entityId, cmd.itemType, cmd.quantity);
            break;
          case CommandType.DebugSpawnNpc:
            this._spawnNpc(world, entityId, cmd.npcTemplate, cmd.quantity);
            break;
          case CommandType.DebugSetTime:
            this._setTime(world, cmd.hour);
            break;
          case CommandType.DebugTeleport:
            this._teleport(world, entityId, cmd.worldX, cmd.worldY);
            break;
          case CommandType.DebugSetStat:
            this._setStat(world, entityId, cmd.stat, cmd.value);
            break;
        }
      }
    }
  }

  // ── handlers ──────────────────────────────────────────────────────────────

  private _giveItem(world: World, entityId: EntityId, itemType: string, quantity: number): void {
    const inv = world.get(entityId, Inventory);
    if (!inv) return;
    if (inv.slots.length >= inv.capacity) {
      log.debug("debug_give: entity=%s inventory full", entityId);
      return;
    }
    const clampedQty = Math.max(1, Math.min(quantity, 255));
    const newSlot: InventorySlot = { kind: "stack", prefabId: itemType, quantity: clampedQty };
    world.set(entityId, Inventory, { ...inv, slots: [...inv.slots, newSlot] });
    log.info("debug_give: entity=%s item=%s qty=%d", entityId, itemType, clampedQty);
  }

  private _spawnNpc(world: World, entityId: EntityId, npcTemplate: string, quantity: number): void {
    const pos = world.get(entityId, Position);
    if (!pos) return;
    if (!this.content.getPrefab(npcTemplate)) {
      log.warn("debug_spawn_npc: unknown prefab '%s'", npcTemplate);
      return;
    }
    const clampedQty = Math.max(1, Math.min(quantity, 20));
    for (let i = 0; i < clampedQty; i++) {
      // Scatter spawns in a 3-unit radius ring around the player.
      const angle = (i / clampedQty) * Math.PI * 2;
      const r = 2 + Math.random() * 1.5;
      spawnPrefab(world, this.content, npcTemplate, {
        x: pos.x + Math.cos(angle) * r,
        y: pos.y + Math.sin(angle) * r,
      });
    }
    log.info("debug_spawn_npc: entity=%s prefab=%s qty=%d", entityId, npcTemplate, clampedQty);
  }

  private _setTime(world: World, hour: number): void {
    const clampedHour = Math.max(0, Math.min(hour, 24)) % 24;
    for (const { entityId, worldClock } of world.query(WorldClock)) {
      const fraction = clampedHour / 24;
      const targetTicks = Math.round(fraction * worldClock.dayLengthTicks);
      // Snap ticksElapsed to the start of the current cycle plus the target offset.
      const cycleStart = worldClock.ticksElapsed - (worldClock.ticksElapsed % worldClock.dayLengthTicks);
      world.set(entityId, WorldClock, { ...worldClock, ticksElapsed: cycleStart + targetTicks });
      log.info("debug_set_time: hour=%.1f", clampedHour);
      break; // Only one WorldClock entity per tile.
    }
  }

  private _teleport(world: World, entityId: EntityId, worldX: number, worldY: number): void {
    const pos = world.get(entityId, Position);
    if (!pos) return;
    world.set(entityId, Position, { ...pos, x: worldX, y: worldY });
    log.info("debug_teleport: entity=%s x=%.1f y=%.1f", entityId, worldX, worldY);
  }

  private _setStat(world: World, entityId: EntityId, stat: string, value: number): void {
    switch (stat) {
      case "health": {
        const h = world.get(entityId, Health);
        if (!h) return;
        const v = Math.max(0, Math.min(value, h.max));
        world.set(entityId, Health, { ...h, current: v });
        log.info("debug_set_stat: entity=%s health=%.1f", entityId, v);
        break;
      }
      case "stamina": {
        const s = world.get(entityId, Stamina);
        if (!s) return;
        const v = Math.max(0, Math.min(value, s.max));
        world.set(entityId, Stamina, { ...s, current: v, exhausted: v <= 0 });
        log.info("debug_set_stat: entity=%s stamina=%.1f", entityId, v);
        break;
      }
      default:
        log.warn("debug_set_stat: unknown stat '%s'", stat);
    }
  }
}
