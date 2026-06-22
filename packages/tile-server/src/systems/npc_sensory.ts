/**
 * NpcSensorySystem (T-040) — event-driven combat awareness, sitting ALONGSIDE
 * the spatial detection scan in `set_job_attack_nearest` (T-015/16/17), not
 * replacing it. The scan answers "what threat can I currently see/hear?";
 * this answers "something happened near me — go investigate it."
 *
 * Mirrors the buffered TriggerSystem shape (T-259):
 *
 *   COLLECT — `registerSubscribers` hangs one collector per perceived event
 *   (DamageDealt / EntityDied / LoudNoise) on the real bus. Collectors run
 *   during the (notify-only) post-changeset flush and only push the payload
 *   into a buffer — no world writes at flush time.
 *
 *   DRAIN — at the top of the next `run`, per buffered event: resolve the
 *   event's origin point + the entity to aggro toward (the attacker behind a
 *   wounded ally, the killer behind a death, the source of a noise), then for
 *   every NPC within `perceptionRadius` of the origin that isn't already
 *   attacking, set an `attackTarget` job toward that entity. Net latency: one
 *   tick after the event — the NpcAiSystem (running later this tick) reads the
 *   job we set via the same `current.type !== "attackTarget"` gate the BT
 *   uses, so an investigating NPC's aggro branch is skipped while it homes in.
 *
 * Aggro-target choice deliberately points at the *threat*, never the victim:
 * a pack-mate hearing one of its own get hit turns on the attacker, not on
 * the wounded ally. The target must be a live, attackable entity (has Health,
 * isn't itself an NPC's own self) for the job to stick.
 */
import type { World, EntityId, EventBus } from "@voxim/engine";
import type { ContentService } from "@voxim/content";
import type {
  DamageDealtPayload,
  EntityDiedPayload,
  LoudNoisePayload,
} from "@voxim/protocol";
import { TileEvents } from "@voxim/protocol";
import type { System, EventEmitter, TickContext } from "../system.ts";
import type { SpatialGrid } from "../spatial_grid.ts";
import { Position, Health } from "../components/game.ts";
import { NpcTag, NpcJobQueue } from "../components/npcs.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("NpcSensorySystem");

/** A perceived event, normalised to an origin point + the entity to aggro toward. */
interface Stimulus {
  /** World-space origin of the commotion — NPCs within perceptionRadius react. */
  originX: number;
  originY: number;
  /** Entity the reacting NPCs should attack (the threat, not the victim). */
  aggroTargetId: EntityId;
}

export class NpcSensorySystem implements System {
  private buffer: Stimulus[] = [];
  private currentTick = 0;
  private spatial: SpatialGrid | null = null;
  /** Set during run(); the bus flush (step 4) reads it to resolve origins. */
  private world: World | null = null;

  constructor(private readonly content: ContentService) {}

  /**
   * Hang the collectors on the real tile event bus. Called once from
   * TileServer after world + bus are constructed (the TriggerSystem pattern).
   * Origins are resolved here at flush time, where the world is committed —
   * the killer/attacker is still alive even when the victim has been purged.
   */
  registerSubscribers(bus: EventBus): void {
    bus.subscribe(TileEvents.DamageDealt, (p: DamageDealtPayload) => {
      // A wounded entity's neighbours turn on its attacker. Origin is the
      // contact point — the loudest spot of the fight.
      this.push(p.sourceId, p.hitX, p.hitY);
    });
    bus.subscribe(TileEvents.EntityDied, (p: EntityDiedPayload) => {
      // The victim is already purged by drain time; aggro toward the killer
      // (alive) and use its position as the origin of the killing.
      if (p.killerId === undefined) return;
      const pos = this.world?.get(p.killerId, Position);
      if (!pos) return;
      this.push(p.killerId, pos.x, pos.y);
    });
    bus.subscribe(TileEvents.LoudNoise, (p: LoudNoisePayload) => {
      this.push(p.sourceId, p.x, p.y);
    });
  }

  private push(aggroTargetId: EntityId, originX: number, originY: number): void {
    this.buffer.push({ aggroTargetId, originX, originY });
  }

  prepare(serverTick: number, ctx: TickContext): void {
    this.currentTick = serverTick;
    this.spatial = ctx.spatial;
  }

  run(world: World, _events: EventEmitter, _dt: number): void {
    this.world = world;

    if (this.buffer.length === 0) return;
    const drained = this.buffer;
    this.buffer = [];

    const defaults = this.content.getGameConfig().npcAiDefaults;
    const radius = defaults.perceptionRadius;
    const radiusSq = radius * radius;
    const expiresAt = this.currentTick + defaults.attackTicks;

    for (const stim of drained) {
      // The threat must be a live, attackable, non-NPC entity — same target
      // filter as findDetectedThreat (T-015): NPCs aggro on players, never on
      // a fellow NPC (so a pack-mate's loud sprint or a wolf biting a player
      // doesn't turn the pack on itself).
      if (!world.isAlive(stim.aggroTargetId)) continue;
      if (!world.has(stim.aggroTargetId, Health)) continue;
      if (world.has(stim.aggroTargetId, NpcTag)) continue;

      for (const npcId of this.spatial!.nearby(stim.originX, stim.originY, radius)) {
        if (npcId === stim.aggroTargetId) continue; // never aggro on yourself
        const queue = world.get(npcId, NpcJobQueue);
        if (!queue) continue; // not an AI actor
        if (!world.has(npcId, NpcTag)) continue;
        // Already locked onto something — let the existing job run; the BT's
        // aggro branch is gated the same way.
        if (queue.current?.type === "attackTarget") continue;

        const npcPos = world.get(npcId, Position);
        if (!npcPos) continue;
        const dx = npcPos.x - stim.originX;
        const dy = npcPos.y - stim.originY;
        if (dx * dx + dy * dy > radiusSq) continue; // nearby() is cell-coarse; tighten

        log.debug("npc %s investigates commotion → attack %s", npcId, stim.aggroTargetId);
        world.set(npcId, NpcJobQueue, {
          current: { type: "attackTarget", targetId: stim.aggroTargetId, expiresAt },
          scheduled: [],
          plan: null,
        });
      }
    }
  }
}
