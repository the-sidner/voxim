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
import { SkillInProgress } from "../components/combat.ts";

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

      const layers = isDead
        ? buildDeathLayers(prevByClip, animCfg.deathSpeedScale)
        : buildLocomotionLayers(prevByClip, crouching, moving, speed, walkSpeedRef, animCfg.idleSpeedScale, animCfg.crouchSpeedScale);

      const next: AnimationStateData = { layers, weaponActionId, ticksIntoAction };

      if (!animStatesEqual(current, next)) {
        world.set(entityId, AnimationState, next);
      }
    }
  }
}

// ---- layer builders ----

function buildDeathLayers(prevByClip: Map<string, number>, deathSpeedScale: number): AnimationLayer[] {
  const prev = prevByClip.get("death") ?? 0;
  // Clamp at 1.0 — death clip plays once and holds last frame.
  const time = Math.min(prev + deathSpeedScale * TICK_DT, 1.0);
  return [{
    clipId: "death",
    maskId: "",
    time,
    weight: 1,
    blend: "override",
    speedScale: deathSpeedScale,
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
): AnimationLayer[] {
  if (crouching && moving) {
    return [makeLoop("crouch_walk", prevByClip, "velocity", walkSpeedRef, speed)];
  }
  if (crouching) {
    return [makeLoop("crouch", prevByClip, crouchSpeedScale)];
  }
  if (moving) {
    return [makeLoop("walk", prevByClip, "velocity", walkSpeedRef, speed)];
  }
  return [makeLoop("idle", prevByClip, idleSpeedScale)];
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
