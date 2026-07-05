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
 *   DebugKillEntity — zero an arbitrary entity's health (DeathSystem + death hooks run normally)
 */
import { newEntityId } from "@voxim/engine";
import type { World, EntityId } from "@voxim/engine";
import { CommandType } from "@voxim/protocol";
import type { ContentService } from "@voxim/content";
import type { System, EventEmitter, TickContext } from "../system.ts";
import type { CommandPayload } from "@voxim/protocol";
import { Position, Health } from "../components/game.ts";
import { Resource } from "../components/resource.ts";
import { Inventory, ItemData } from "../components/items.ts";
import type { InventorySlot } from "../components/items.ts";
import { ItemEffects } from "../components/instance.ts";
import { Stair } from "../components/stair.ts";
import { WorldClock } from "../components/world.ts";
import { spawnPrefab } from "../spawner.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("DebugCommandSystem");

export class DebugCommandSystem implements System {
  private _commands: ReadonlyMap<string, CommandPayload[]> = new Map();

  constructor(
    private readonly content: ContentService,
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
          case CommandType.DebugGiveTrinket:
            this._giveTrinket(world, entityId, cmd.stairId);
            break;
          case CommandType.DebugKillEntity:
            this._killEntity(world, cmd.entityId as EntityId);
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
    if (!this.content.prefabs.get(npcTemplate)) {
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

  /**
   * DebugGiveTrinket (T-213b) — dev-only cheat standing in for the full
   * POI-completion -> trinket-drop economy (out of scope for this ticket,
   * see TICKETS.md T-212). Finds the Stair entity by `stairId`, spawns a
   * unique `trinket` item entity carrying a per-instance `ItemEffects`
   * wired to that stair's exact `trinketId` (the same pattern procedural
   * items use — one generic prefab, per-instance effect params), and adds
   * it to the player's inventory.
   */
  private _giveTrinket(world: World, playerId: EntityId, stairId: string): void {
    const stair = world.query(Stair).find((s) => s.stair.stairId === stairId)?.stair;
    if (!stair) {
      log.warn("debug_give_trinket: unknown stairId '%s'", stairId);
      return;
    }
    if (stair.trinketId === "") {
      log.warn("debug_give_trinket: stair '%s' is a 'found' stair (no trinketId)", stairId);
      return;
    }
    const inv = world.get(playerId, Inventory);
    if (!inv) return;
    if (inv.slots.length >= inv.capacity) {
      log.debug("debug_give_trinket: player=%s inventory full", playerId);
      return;
    }

    const itemId = newEntityId();
    world.create(itemId);
    world.write(itemId, ItemData, { prefabId: "trinket", quantity: 1 });
    world.write(itemId, ItemEffects, {
      effects: [{ id: "unlock_stair", params: { trinketId: stair.trinketId } }],
    });
    world.set(playerId, Inventory, { ...inv, slots: [...inv.slots, { kind: "unique", entityId: itemId }] });
    log.info("debug_give_trinket: player=%s stair=%s trinketId=%s item=%s", playerId, stairId, stair.trinketId, itemId);
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
        const res = world.get(entityId, Resource);
        const st = res?.values.stamina;
        if (!res || !st) return;
        const v = Math.max(0, Math.min(value, st.max));
        world.set(entityId, Resource, {
          values: { ...res.values, stamina: { value: v, max: st.max } },
        });
        log.info("debug_set_stat: entity=%s stamina=%.1f", entityId, v);
        break;
      }
      default:
        log.warn("debug_set_stat: unknown stat '%s'", stat);
    }
  }

  /**
   * DebugKillEntity (T-311 P5c I3b harness) — zero the named entity's Health
   * through the same deferred `world.mutate` every other Health writer uses
   * (health_hit_handler.ts, skill_effects.ts, buff.ts), so DeathSystem sees a
   * committed 0-health entity next tick exactly as it would from real combat
   * damage — DeathSystem + any death hooks (e.g. the drowner's shed_dissolve)
   * run unmodified. Lets the harness kill an arbitrary NPC by id (no reach/
   * ownership gate — this is a dev-only cheat, same trust level as the other
   * DebugX commands, gated by devMode at the top of run()).
   */
  private _killEntity(world: World, entityId: EntityId): void {
    if (!world.isAlive(entityId) || !world.has(entityId, Health)) {
      log.warn("debug_kill_entity: entity '%s' not found or has no Health", entityId);
      return;
    }
    world.mutate(entityId, Health, (h) => ({ ...h, current: 0 }));
    log.info("debug_kill_entity: entity=%s", entityId);
  }
}
