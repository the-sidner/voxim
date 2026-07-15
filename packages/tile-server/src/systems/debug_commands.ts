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
 *   DebugSpawnDummy — spawn a training dummy NPC (T-327) near the player
 *   DebugSetActionParam — live-patch a numeric ActionDef/GameConfig field (T-327)
 */
import { newEntityId } from "@voxim/engine";
import type { World, EntityId } from "@voxim/engine";
import { CommandType } from "@voxim/protocol";
import type { ContentService } from "@voxim/content";
import type { System, EventEmitter, TickContext } from "../system.ts";
import type { CommandPayload } from "@voxim/protocol";
import { Position, Health, Facing } from "../components/game.ts";
import { Resource } from "../components/resource.ts";
import { Inventory, ItemData } from "../components/items.ts";
import type { InventorySlot } from "../components/items.ts";
import { ItemEffects } from "../components/instance.ts";
import { Stair } from "../components/stair.ts";
import { WorldClock } from "../components/world.ts";
import { TrainingDummy } from "../components/training_dummy.ts";
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
          case CommandType.DebugSpawnDummy:
            this._spawnDummy(world, entityId, cmd.attackLoop);
            break;
          case CommandType.DebugSetActionParam:
            this._setActionParam(cmd.actionId, cmd.field, cmd.value);
            break;
        }
      }
    }
  }

  // ── handlers ──────────────────────────────────────────────────────────────

  private _giveItem(world: World, entityId: EntityId, itemType: string, quantity: number): void {
    if (!world.get(entityId, Inventory)) return;
    const clampedQty = Math.max(1, Math.min(quantity, 255));
    const newSlot: InventorySlot = { kind: "stack", prefabId: itemType, quantity: clampedQty };
    // `mutate`, not get-then-set (T-249): two gives in the SAME tick would both
    // read the same pre-tick Inventory and both write `[...thatSame, mine]`, so
    // the second silently clobbers the first and one item vanishes. Found live —
    // giving a bow and arrows together delivered only the arrows. mutate() runs
    // at commit against whatever earlier ops this tick already left behind, so
    // concurrent contributors compose. The capacity check has to move INSIDE the
    // closure for the same reason: checked against the stale read it could admit
    // a slot that no longer fits.
    world.mutate(entityId, Inventory, (inv) => {
      if (inv.slots.length >= inv.capacity) {
        log.debug("debug_give: entity=%s inventory full", entityId);
        return inv;
      }
      return { ...inv, slots: [...inv.slots, newSlot] };
    });
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
    if (!world.get(playerId, Inventory)) return;

    // T-344: the item entity is created unconditionally, BEFORE the capacity
    // check below — same accepted residual as _giveItem's sibling: if the
    // mutate declines (inventory filled by a same-tick race), this entity is
    // orphaned (never referenced by any inventory). Dev-only cheat, no
    // player resource lost — an acceptable, narrow leak, not a "consumed
    // material with no output" case.
    const itemId = newEntityId();
    world.create(itemId);
    world.write(itemId, ItemData, { prefabId: "trinket", quantity: 1 });
    world.write(itemId, ItemEffects, {
      effects: [{ id: "unlock_stair", params: { trinketId: stair.trinketId } }],
    });
    // mutate, not set — same lost-update reason as _giveItem above (T-249).
    // The capacity check MUST live inside the closure too: checked against
    // the stale `inv` read (as this used to do, right next to the already-
    // fixed append below) is the exact trap the T-344 ticket calls out —
    // fixing only the write while the validation still reads pre-tick state
    // keeps the bug, just wearing a hat.
    world.mutate(playerId, Inventory, (cur) => {
      if (cur.slots.length >= cur.capacity) {
        log.debug("debug_give_trinket: player=%s inventory full", playerId);
        return cur;
      }
      return { ...cur, slots: [...cur.slots, { kind: "unique", entityId: itemId } as InventorySlot] };
    });
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

  /**
   * DebugSpawnDummy (T-327) — the combat-feel tuning pipeline's practice
   * target: an NPC that takes hits, never dies (Health floored in
   * health_hit_handler.ts, healed back up by TrainingDummySystem after a
   * delay) and — when `attackLoop` is set — swings at a fixed cadence
   * (`training_dummy_attacker`'s BT, `check_tick_interval`) so blocks/
   * dodges/i-frames can be practised against a predictable telegraph.
   * Spawns a few units in front of the caller, facing them.
   */
  private _spawnDummy(world: World, entityId: EntityId, attackLoop: boolean): void {
    const pos = world.get(entityId, Position);
    if (!pos) return;
    const facing = world.get(entityId, Facing)?.angle ?? 0;
    const prefabId = attackLoop ? "training_dummy_attacker" : "training_dummy";
    if (!this.content.prefabs.get(prefabId)) {
      log.warn("debug_spawn_dummy: missing prefab '%s'", prefabId);
      return;
    }
    const dummyId = spawnPrefab(world, this.content, prefabId, {
      x: pos.x + Math.cos(facing) * 3,
      y: pos.y + Math.sin(facing) * 3,
      facing: facing + Math.PI, // face back toward the spawning player
    });
    const startingHealth = world.get(dummyId, Health)?.current ?? 0;
    world.write(dummyId, TrainingDummy, {
      healDelayTicks: 100, // 5s at 20Hz
      lastHitTick: 0,
      lastObservedHealth: startingHealth,
    });
    log.info("debug_spawn_dummy: entity=%s attackLoop=%s dummy=%s", entityId, attackLoop, dummyId);
  }

  /**
   * DebugSetActionParam (T-327) — the live half of the combat-feel tuning
   * pipeline. Patches a numeric leaf of the in-memory ContentService IN
   * PLACE (no registry mutation API needed — items are plain, un-frozen
   * objects post-load) so the very next read picks it up: the
   * ActionDispatcher re-fetches `content.actions.get(id)` fresh every tick
   * (dispatcher.ts), so a phase-tick edit takes effect on the entity's next
   * action start with no restart.
   *
   * `actionId` is either a real `content.actions` id, or the sentinel
   * `"$config"` to reach the handful of feel knobs that live on GameConfig
   * instead (knockback scale, aim-assist cone/range) — `field` is always a
   * dotted path resolved against that target object. Only ever overwrites a
   * field that IS ALREADY a number: this can retune existing tuning, not
   * reshape content or add fields (see `patchNumericField`).
   */
  private _setActionParam(actionId: string, field: string, value: number): void {
    const target: unknown = actionId === "$config"
      ? this.content.getGameConfig()
      : this.content.actions.get(actionId);
    if (!target) {
      log.warn("debug_set_action_param: unknown actionId '%s'", actionId);
      return;
    }
    if (!patchNumericField(target, field, value)) {
      log.warn("debug_set_action_param: field '%s' not found or not numeric on '%s'", field, actionId);
      return;
    }
    log.info("debug_set_action_param: target=%s field=%s value=%.3f", actionId, field, value);
  }
}

/**
 * Walks `path` (dot-separated) into `obj` and overwrites the final segment
 * IF it already holds a number — refuses to create new fields or touch
 * non-numeric ones, so a live tuning edit can only retune an existing knob,
 * never corrupt content shape. Returns whether the write happened.
 */
function patchNumericField(obj: unknown, path: string, value: number): boolean {
  const parts = path.split(".");
  let cur: unknown = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (typeof cur !== "object" || cur === null) return false;
    cur = (cur as Record<string, unknown>)[parts[i]];
  }
  if (typeof cur !== "object" || cur === null) return false;
  const leaf = parts[parts.length - 1];
  const rec = cur as Record<string, unknown>;
  if (typeof rec[leaf] !== "number") return false;
  rec[leaf] = value;
  return true;
}
