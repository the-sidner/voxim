/**
 * AnimationSystem — derives AnimationState (layer stack + weapon data) from
 * observable entity state each tick.
 *
 * Priority order (highest first):
 *   death      — Health.current <= 0
 *   attack     — SkillInProgress present (sets weaponActionId; locomotion layers continue)
 *   crouch_walk / crouch — crouching + moving / crouching only
 *   walk       — velocity magnitude > threshold
 *   idle       — otherwise
 *
 * Layer time is advanced here at 20 Hz.  The client receives the authoritative
 * time in each AnimationState delta and uses it directly (no client-side time
 * accumulation for locomotion).
 *
 * Hitbox updates are handled by HitboxSystem, which runs immediately after.
 */
import type { World } from "@voxim/engine";
import type { DeferredEventQueue } from "../deferred_events.ts";
import type { System } from "../system.ts";
import type { AnimationStateData, AnimationLayer } from "@voxim/content";
import { ACTION_CROUCH, hasAction } from "@voxim/protocol";
import { Velocity, Health, SkillInProgress, AnimationState, InputState } from "../components/game.ts";

// ---- constants ----

const WALK_THRESHOLD_SQ = 0.01;

/**
 * Reference speed (world units/tick) for the walk clip.
 * Walk animation plays at 1× rate when entity speed equals this value.
 * Adjust to match the expected gait cadence once walk clips are in skeletons.json.
 */
const WALK_SPEED_REFERENCE = 0.08;

/**
 * Base time advance per tick for fixed-rate clips (speedScale is a number).
 * speedScale=1 → one full cycle per 20 ticks (1 second at 20 Hz).
 */
const TICK_DT = 1 / 20;

// ---- AnimationSystem ----

export class AnimationSystem implements System {
  prepare(_tick: number): void {}

  run(world: World, _events: DeferredEventQueue, _dt: number): void {
    for (const { entityId, velocity } of world.query(Velocity, AnimationState)) {
      const health = world.get(entityId, Health);
      const isDead = health !== null && health.current <= 0;
      const sip    = isDead ? null : world.get(entityId, SkillInProgress);
      const input  = isDead ? null : world.get(entityId, InputState);

      const speed  = Math.sqrt(velocity.x * velocity.x + velocity.y * velocity.y);
      const crouching = input !== null && hasAction(input.actions, ACTION_CROUCH);
      const moving    = speed * speed > WALK_THRESHOLD_SQ;

      // Determine locomotion clip and advance its time.
      const current = world.get(entityId, AnimationState);
      const prevByClip = getTimeByClip(current);

      let weaponActionId  = "";
      let ticksIntoAction = 0;

      if (sip) {
        const action = world.get(entityId, SkillInProgress);
        if (action) {
          weaponActionId = action.weaponActionId;
          ticksIntoAction = sip.phase === "windup"
            ? sip.ticksInPhase
            : sip.phase === "active"
            ? sip.ticksInPhase  // caller resolves windup offset at read time
            : sip.ticksInPhase; // same for winddown
          // Precise cumulative ticks: recomputed from sip each tick, not accumulated here.
          // The client re-derives the offset from WeaponActionDef.windupTicks at render time.
          // Keep it simple: just pass ticksInPhase for now; ActionSystem owns the phase.
          // TODO: pass cumulative ticksIntoAction once ActionSystem exposes it on SkillInProgress.
        }
      }

      const layers = isDead
        ? buildDeathLayers(prevByClip)
        : buildLocomotionLayers(prevByClip, crouching, moving, speed);

      const next: AnimationStateData = { layers, weaponActionId, ticksIntoAction };

      if (!animStatesEqual(current, next)) {
        world.set(entityId, AnimationState, next);
      }
    }
  }
}

// ---- layer builders ----

function buildDeathLayers(prevByClip: Map<string, number>): AnimationLayer[] {
  const prev = prevByClip.get("death") ?? 0;
  // Clamp at 1.0 — death clip plays once and holds last frame.
  const time = Math.min(prev + 0.5 * TICK_DT, 1.0);
  return [{
    clipId: "death",
    maskId: "",
    time,
    weight: 1,
    blend: "override",
    speedScale: 0.5,
  }];
}

function buildLocomotionLayers(
  prevByClip: Map<string, number>,
  crouching: boolean,
  moving: boolean,
  speed: number,
): AnimationLayer[] {
  if (crouching && moving) {
    return [makeLoop("crouch_walk", prevByClip, "velocity", WALK_SPEED_REFERENCE, speed)];
  }
  if (crouching) {
    return [makeLoop("crouch", prevByClip, 0.4)];
  }
  if (moving) {
    return [makeLoop("walk", prevByClip, "velocity", WALK_SPEED_REFERENCE, speed)];
  }
  return [makeLoop("idle", prevByClip, 0.4)];
}

/** Build one looping layer with time advanced from the previous value. */
function makeLoop(
  clipId: string,
  prevByClip: Map<string, number>,
  speedScale: number | "velocity",
  speedReference?: number,
  currentSpeed?: number,
): AnimationLayer {
  const prev = prevByClip.get(clipId) ?? 0;
  let advance: number;
  if (speedScale === "velocity" && speedReference && currentSpeed !== undefined) {
    advance = (currentSpeed / speedReference) * TICK_DT;
  } else if (typeof speedScale === "number") {
    advance = speedScale * TICK_DT;
  } else {
    advance = TICK_DT;
  }
  const time = (prev + advance) % 1.0;
  return { clipId, maskId: "", time, weight: 1, blend: "override", speedScale, speedReference };
}

// ---- helpers ----

/** Build a clip-id → last time map from the entity's current AnimationState. */
function getTimeByClip(state: AnimationStateData | null): Map<string, number> {
  const m = new Map<string, number>();
  for (const l of state?.layers ?? []) {
    m.set(l.clipId, l.time);
  }
  return m;
}

function animStatesEqual(a: AnimationStateData | null, b: AnimationStateData): boolean {
  if (!a) return false;
  if (a.weaponActionId !== b.weaponActionId) return false;
  if (a.ticksIntoAction !== b.ticksIntoAction) return false;
  if (a.layers.length !== b.layers.length) return false;
  for (let i = 0; i < a.layers.length; i++) {
    const la = a.layers[i], lb = b.layers[i];
    if (la.clipId !== lb.clipId) return false;
    if (Math.abs(la.time - lb.time) > 0.0001) return false;
    if (la.weight !== lb.weight) return false;
  }
  return true;
}
