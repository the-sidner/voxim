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
import type { ContentStore, AnimationStateData, AnimationLayer } from "@voxim/content";
import { ACTION_CROUCH, hasAction } from "@voxim/protocol";
import { Velocity, Health, AnimationState, InputState } from "../components/game.ts";
import { SkillInProgress, Rolling } from "../components/combat.ts";
import { AnimationSlots } from "../components/animation_slots.ts";

// ---- constants ----

/**
 * Base time advance per tick for fixed-rate clips (speedScale is a number).
 * speedScale=1 → one full cycle per 20 ticks (1 second at 20 Hz).
 * Structural: derived from the server tick rate, not a tuning knob.
 */
const TICK_DT = 1 / 20;

// ---- AnimationSystem ----

export class AnimationSystem implements System {
  /**
   * Reads InputState (NpcAi writes via world.write() for crouch detection)
   * and SkillInProgress (Action writes via world.write() on swing start).
   * Both must precede so this tick's animation layers reflect this tick's input.
   */
  readonly dependsOn = ["NpcAiSystem", "ActionSystem"];

  constructor(private readonly content: ContentStore) {}

  prepare(_tick: number): void {}

  run(world: World, _events: DeferredEventQueue, _dt: number): void {
    const cfg = this.content.getGameConfig();
    // Reference speed for velocity-scaled clips: the entity's max ground speed
    // in world units/sec, matching the units stored in the Velocity component.
    // Walk animation plays at 1× when the entity moves at this speed.
    const walkSpeedRef = cfg.physics.maxGroundSpeed;
    const walkThresholdSq = cfg.animation.walkSpeedThresholdSq;
    const animCfg = cfg.animation;

    for (const { entityId, velocity } of world.query(Velocity, AnimationState)) {
      const health = world.get(entityId, Health);
      const isDead = health !== null && health.current <= 0;
      const sip    = isDead ? null : world.get(entityId, SkillInProgress);
      const input  = isDead ? null : world.get(entityId, InputState);
      const rolling = isDead ? null : world.get(entityId, Rolling);

      const speed  = Math.sqrt(velocity.x * velocity.x + velocity.y * velocity.y);
      const crouching = input !== null && hasAction(input.actions, ACTION_CROUCH);
      const moving    = speed * speed > walkThresholdSq;

      // Determine locomotion clip and advance its time.
      const current = world.get(entityId, AnimationState);
      const prevByClip = getTimeByClip(current);

      let weaponActionId  = "";
      let ticksIntoAction = 0;

      if (sip) {
        weaponActionId = sip.weaponActionId;
        // Compute cumulative ticks across phases so the client receives a
        // monotonically increasing counter the renderer can extrapolate smoothly.
        const def = this.content.getWeaponAction(sip.weaponActionId);
        ticksIntoAction = sip.ticksInPhase;
        if (def) {
          if (sip.phase === "active")    ticksIntoAction += def.windupTicks;
          else if (sip.phase === "winddown") ticksIntoAction += def.windupTicks + def.activeTicks;
        }
      }

      // Per-prefab slot map lets two prefabs sharing one skeleton play
      // different clips for the same gameplay state — see AnimationSlots
      // component docs.  Falls through to the slot name as the clip id so
      // skeletons authored before the indirection landed keep working.
      const slotMap = world.get(entityId, AnimationSlots)?.slots ?? {};
      const slot = (name: string): string => slotMap[name] ?? name;

      // Low health → limp variant.  Slot indirection is honoured: the prefab
      // can override "walk_limp" to its own injured-style clip if needed.
      const useLimp = health !== null && health.max > 0 && health.current / health.max < 0.30;
      const walkClipId = useLimp ? slot("walk_limp") : slot("walk");

      const layers = isDead
        ? buildDeathLayers(prevByClip, animCfg.deathSpeedScale, slot("death"))
        : rolling
          ? buildRollLayers(prevByClip, slot("roll"))
          : buildLocomotionLayers(
              prevByClip, crouching, moving, speed, walkSpeedRef,
              animCfg.idleSpeedScale, animCfg.crouchSpeedScale,
              walkClipId, slot("idle"), slot("crouch"), slot("crouch_walk"));

      const next: AnimationStateData = { layers, weaponActionId, ticksIntoAction };

      if (!animStatesEqual(current, next)) {
        world.set(entityId, AnimationState, next);
      }
    }
  }
}

// ---- layer builders ----

function buildDeathLayers(prevByClip: Map<string, number>, deathSpeedScale: number, clipId: string): AnimationLayer[] {
  const prev = prevByClip.get(clipId) ?? 0;
  // Clamp at 1.0 — death clip plays once and holds last frame.
  const time = Math.min(prev + deathSpeedScale * TICK_DT, 1.0);
  return [{
    clipId,
    maskId: "",
    time,
    weight: 1,
    blend: "override",
    speedScale: deathSpeedScale,
  }];
}

// Roll layer — plays the authored "roll" clip across the dodge duration.
// rollTicks=14 in game_config and TICK_DT=1/20 → 14 ticks × (1/20 s/tick) =
// 0.7 s of real time. Speed-scale = 1 / 0.7 ≈ 1.43 makes the clip's normalised
// time span 0→1 over exactly that window. Clamps at 1.0 (non-looping) so the
// last tick holds the recovery pose instead of snapping back to t=0.
const ROLL_SPEED_SCALE = 20 / 14;

function buildRollLayers(prevByClip: Map<string, number>, clipId: string): AnimationLayer[] {
  const prev = prevByClip.get(clipId) ?? 0;
  const time = Math.min(prev + ROLL_SPEED_SCALE * TICK_DT, 1.0);
  return [{
    clipId,
    maskId: "",
    time,
    weight: 1,
    blend: "override",
    speedScale: ROLL_SPEED_SCALE,
  }];
}

function buildLocomotionLayers(
  prevByClip: Map<string, number>,
  crouching: boolean,
  moving: boolean,
  speed: number,
  walkSpeedRef: number,
  idleSpeedScale: number,
  crouchSpeedScale: number,
  walkClipId: string,
  idleClipId: string,
  crouchClipId: string,
  crouchWalkClipId: string,
): AnimationLayer[] {
  if (crouching && moving) {
    return [makeLoop(crouchWalkClipId, prevByClip, "velocity", walkSpeedRef, speed)];
  }
  if (crouching) {
    return [makeLoop(crouchClipId, prevByClip, crouchSpeedScale)];
  }
  if (moving) {
    return [makeLoop(walkClipId, prevByClip, "velocity", walkSpeedRef, speed)];
  }
  return [makeLoop(idleClipId, prevByClip, idleSpeedScale)];
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
