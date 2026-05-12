/**
 * ManeuverScheduler — advances the per-actor Maneuver timeline each tick.
 *
 * Runs after PhysicsSystem (so locomotion impulses overwrite per-tick
 * velocity rather than fighting it) and after CharacterStateMachineSystem
 * (so we can fire event.maneuver_ended into the same tick the SM consumes
 * it; the event buffer is not cleared until CSM tick. Order matters: CSM
 * runs first, scheduler fires the end-event, scheduler removes Maneuver,
 * CSM ticks the right_hand/left_hand transition next frame).
 *
 * Per tick, for each entity with a Maneuver component:
 *   1. Advance elapsed by dt.
 *   2. From the def's per-hand tracks, pick the latest entry whose t ≤
 *      elapsed and write its clip onto the Maneuver component. The
 *      AnimationSystem reads these into the in_maneuver projections.
 *   3. From locomotion tracks active at `elapsed`, write Velocity each tick
 *      so the dash holds against PhysicsSystem's drag.
 *   4. From hitEffects tracks active at `elapsed`, fill activeHitTags so
 *      the hit handlers can apply on-hit effects.
 *   5. If elapsed >= duration: fire event.maneuver_ended, remove Maneuver.
 *      The CSM will pick up the end-event and transition to idle on the
 *      next tick.
 *
 * Effects (T-185 placeholder): activeHitTags is an unstructured tag list.
 * The richer effect system will arrive separately; this scheduler stays
 * unchanged because tags are opaque to it — only the resolver behind each
 * tag changes.
 */

import type { World, EntityId } from "@voxim/engine";
import type { ContentService, ManeuverDef } from "@voxim/content";
import {
  ACTION_DODGE, ACTION_BLOCK, ACTION_JUMP, ACTION_USE_SKILL, hasAction,
} from "@voxim/protocol";
import type { System, EventEmitter } from "../system.ts";
import { Maneuver } from "../components/maneuver.ts";
import type { ManeuverHitTag } from "../components/maneuver.ts";
import { Velocity, Facing, InputState } from "../components/game.ts";
import { TickEventBuffer } from "../tick_events.ts";
import { createLogger } from "../logger.ts";

/** Map an interrupt-window action name to the wire bitflag. */
const INTERRUPT_BITS: Record<string, number> = {
  dodge: ACTION_DODGE,
  block: ACTION_BLOCK,
  jump:  ACTION_JUMP,
  swing: ACTION_USE_SKILL,
};

const log = createLogger("ManeuverScheduler");

export class ManeuverSchedulerSystem implements System {
  /**
   * Runs after CSM (so SM transitions to in_maneuver are visible this
   * frame) and Physics (so we can stomp Velocity for dashes without
   * fighting drag).
   */
  readonly dependsOn = ["CharacterStateMachineSystem", "PhysicsSystem"];

  constructor(
    private readonly content: ContentService,
    private readonly tickEvents: TickEventBuffer,
  ) {}

  run(world: World, _events: EventEmitter, dt: number): void {
    for (const { entityId, maneuver } of world.query(Maneuver)) {
      const def = this.content.maneuvers.get(maneuver.maneuverId);
      if (!def) {
        // Unknown id: clean up the orphan rather than spinning forever.
        world.remove(entityId, Maneuver);
        log.warn("removing orphan maneuver: entity=%s id=%s", entityId, maneuver.maneuverId);
        continue;
      }

      const next = maneuver.elapsed + dt;
      const ended = next >= def.duration;

      if (ended) {
        this.tickEvents.fire(entityId, "event.maneuver_ended");
        world.remove(entityId, Maneuver);
        log.debug("maneuver complete: entity=%s id=%s", entityId, def.id);
        continue;
      }

      // Interrupt windows: any active window whose `by` list matches a
      // currently-pressed input bit ends the maneuver immediately. The
      // CSM consumes event.maneuver_ended next tick to exit in_maneuver.
      // Empty interruptWindows means committed-through — no early exit
      // possible regardless of input.
      if (def.interruptWindows.length > 0) {
        const input = world.get(entityId, InputState);
        const actions = input?.actions ?? 0;
        let interrupted = false;
        for (const win of def.interruptWindows) {
          if (next < win.fromT || next >= win.toT) continue;
          for (const name of win.by) {
            const bit = INTERRUPT_BITS[name];
            if (bit !== undefined && hasAction(actions, bit)) { interrupted = true; break; }
          }
          if (interrupted) break;
        }
        if (interrupted) {
          this.tickEvents.fire(entityId, "event.maneuver_ended");
          world.remove(entityId, Maneuver);
          log.debug("maneuver interrupted: entity=%s id=%s atT=%.2f", entityId, def.id, next);
          continue;
        }
      }

      // Per-hand clips: latest scheduled entry with t ≤ elapsed wins. Empty
      // string (or "$slot") values pass through to AnimationSystem; the
      // initial value (before the first track entry) is also empty so the
      // in_maneuver layer contributes nothing until something's scheduled.
      const rightClipId = pickActiveClip(def.tracks.right_hand, next);
      const leftClipId  = pickActiveClip(def.tracks.left_hand,  next);

      // Locomotion: any active dash gets stomped onto Velocity each tick of
      // its window. Multiple overlapping dashes shouldn't happen in
      // authored content (it's a single-track timeline), but the math
      // tolerates it — last one wins.
      applyLocomotion(world, entityId, def, next);

      // Hit-effect tag list: hit handlers iterate this when a hit lands.
      const activeHitTags: ManeuverHitTag[] = [];
      for (const fx of def.tracks.hitEffects) {
        const fromOk = next >= fx.fromT;
        const toOk   = fx.toT === undefined || next < fx.toT;
        if (fromOk && toOk) activeHitTags.push({ tag: fx.tag, magnitude: fx.magnitude });
      }

      world.set(entityId, Maneuver, {
        maneuverId: def.id,
        elapsed: next,
        rightClipId,
        leftClipId,
        activeHitTags,
      });
    }
  }
}

function pickActiveClip(track: { t: number; clip: string }[], elapsed: number): string {
  let active = "";
  for (const entry of track) {
    if (entry.t <= elapsed && entry.t >= 0) active = entry.clip;
  }
  return active;
}

function applyLocomotion(
  world: World,
  entityId: EntityId,
  def: ManeuverDef,
  elapsed: number,
): void {
  for (const loco of def.tracks.locomotion) {
    const inWindow = elapsed >= loco.t && elapsed < loco.t + loco.duration;
    if (!inWindow) continue;
    if (loco.kind === "dash") {
      const facing = world.get(entityId, Facing)?.angle ?? 0;
      const speed = loco.forward / loco.duration;
      const vx = Math.cos(facing) * speed;
      const vy = Math.sin(facing) * speed;
      const cur = world.get(entityId, Velocity);
      world.set(entityId, Velocity, { x: vx, y: vy, z: cur?.z ?? 0 });
    }
  }
}
