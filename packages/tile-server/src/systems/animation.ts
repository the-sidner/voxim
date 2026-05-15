/**
 * AnimationSystem — projects the CSM's animation-typed layers into
 * AnimationLayer[] each tick.
 *
 * Reads CharacterStateMachine layer states (set by CharacterStateMachineSystem
 * earlier this tick), walks every layer with output: "animation", resolves
 * the active state's clip via `prefab.animationSlots`, advances per-clip time
 * from the previous AnimationState, and emits one AnimationLayer per
 * animation-typed CSM layer. Higher-priority layers compose on top via the
 * existing AnimationLayer evaluator (HitboxSystem on server, skeleton
 * evaluator on client).
 *
 * The CSM is the source of truth for "what should this actor be playing."
 * AnimationSystem is a pure projector — no `if (sip)` branches, no per-state
 * cascades, no `if (rolling)` overrides. State priorities live in JSON.
 */
import type { World } from "@voxim/engine";
import type { DeferredEventQueue } from "../deferred_events.ts";
import type { System } from "../system.ts";
import type {
  ContentService,
  AnimationStateData,
  AnimationLayer,
  CompiledStateMachine,
  SMRuntimeState,
  SMScopeValue,
  SMState,
} from "@voxim/content";
import {
  compileStateMachine,
  effectiveState,
  buildCsmVars,
} from "@voxim/content";
import { Velocity, AnimationState } from "../components/game.ts";
import { CharacterStateMachine } from "../components/character_state_machine.ts";
import { ActiveActions } from "../components/action.ts";
import type { ActiveActionState } from "../components/action.ts";
import { Crouched } from "../components/tags.ts";
import { Equipment } from "../components/equipment.ts";
import type { SwingableData } from "@voxim/content";
import { AnimationSlots } from "../components/animation_slots.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("AnimationSystem");

const TICK_DT = 1 / 20;

/**
 * DEBUG: when true, AnimationSystem emits empty AnimationLayer[] for every
 * entity, so the skeleton FK (server HitboxSystem + client renderer) falls
 * through to the rest pose. Use this to verify that the biped's bind /
 * voxel-rest orientation is correct before diagnosing animation issues.
 *
 * Revert to `false` after the visual check.
 */
const DEBUG_FORCE_REST_POSE = false;

export class AnimationSystem implements System {
  /** Runs after CSM ticks. */
  readonly dependsOn = ["CharacterStateMachineSystem", "ActionSystem"];

  /** Compiled SM cache — eager-built at construction so any SM def parse error fails fast at server boot. */
  private compiledCache = new Map<string, CompiledStateMachine>();
  /** One-shot dedupe for projection failures so a recurring per-entity issue logs once. */
  private loggedFailures = new Set<string>();

  constructor(private readonly content: ContentService) {
    for (const def of content.stateMachines.values()) {
      this.compiledCache.set(def.id, compileStateMachine(def));
    }
  }

  run(world: World, _events: DeferredEventQueue, _dt: number): void {
    const cfg = this.content.getGameConfig();
    const walkSpeedRef = cfg.physics.maxGroundSpeed;

    for (const { entityId, characterStateMachine: csm } of world.query(CharacterStateMachine, AnimationState)) {
      const compiled = this.compiledCache.get(csm.stateMachineId);
      if (!compiled) continue;
      try {
        this.projectOne(world, entityId, csm, compiled, walkSpeedRef);
      } catch (err) {
        const key = `${csm.stateMachineId}:${(err as Error).message}`;
        if (!this.loggedFailures.has(key)) {
          this.loggedFailures.add(key);
          log.error("animation projection failed for entity=%s sm=%s: %s",
            entityId, csm.stateMachineId, (err as Error).message);
        }
      }
    }
  }

  private projectOne(
    world: World,
    entityId: string,
    csm: { stateMachineId: string; layerStates: Record<string, { node: string; elapsed: number }> },
    compiled: CompiledStateMachine,
    walkSpeedRef: number,
  ): void {
    if (DEBUG_FORCE_REST_POSE) {
      const prev = world.get(entityId, AnimationState);
      const next: AnimationStateData = { layers: [], weaponActionId: "", ticksIntoAction: 0 };
      if (!animStatesEqual(prev, next)) world.set(entityId, AnimationState, next);
      return;
    }

      const layerStates: SMRuntimeState = csm.layerStates as SMRuntimeState;
      const baseSlots = world.get(entityId, AnimationSlots)?.slots ?? {};
      // The swing/block/aim clips are weapon-specific. Inject the equipped
      // weapon's geometry-action clip (the same chain[0] source weapon_trace
      // reads) so `$weapon.swing_clip` etc. resolve to the held weapon's
      // animation rather than the actor-prefab default. (T-227 — replaces
      // the retired SwingContext-driven injection.)
      const equipped = world.get(entityId, Equipment)?.weapon?.prefabId;
      const swingable = equipped
        ? this.content.prefabs.get(equipped)?.components["swingable"] as SwingableData | undefined
        : undefined;
      const geomAction = swingable?.chain?.[0]?.light
        ? this.content.weaponActions.get(swingable.chain[0].light)
        : undefined;
      const slotMap = geomAction?.clipId
        ? { ...baseSlots, "weapon.swing_clip": geomAction.clipId }
        : baseSlots;

      const speed = velocityMagnitude(world, entityId);
      const prev  = world.get(entityId, AnimationState);
      const prevTime = getTimeByClip(prev);
      const baseScope: Record<string, SMScopeValue> = { ...buildCsmVars(compiled, layerStates) };

      const layers: AnimationLayer[] = [];

      // Locomotion (T-226c) + primary (T-227) are action slots, not CSM
      // layers. Project locomotion first (lowest composite priority, where
      // the retired CSM locomotion layer sat), then primary (upper body,
      // above locomotion). Both read last-tick's committed ActiveActions
      // (deferred-write lag = the CSM's old deferred layerState lag).
      const slots = world.get(entityId, ActiveActions)?.states;
      const locoLayer = projectLocomotion(
        this.content, slots?.["locomotion"], world.has(entityId, Crouched),
        slotMap, prevTime, speed, walkSpeedRef,
      );
      if (locoLayer) layers.push(locoLayer);
      const primaryLayer = projectLocomotion(
        this.content, slots?.["primary"], false,
        slotMap, prevTime, speed, walkSpeedRef,
      );
      if (primaryLayer) layers.push(primaryLayer);

      // Remaining CSM layers (only `reaction` after T-227) — hit/stagger/
      // death overrides. Generic projection, unchanged.
      for (const compiledLayer of compiled.layers) {
        if (compiledLayer.raw.output !== "animation") continue;
        const lstate = layerStates[compiledLayer.raw.id];
        if (!lstate) continue;
        const eff = effectiveState(compiledLayer, lstate.node, baseScope);
        if (!eff.clip) continue;
        const clipId = resolveClipId(eff.clip, slotMap);
        if (!clipId) continue;
        const speedReference = eff.speedReference ?? walkSpeedRef;
        const speedScale = resolveSpeedScale(eff, compiledLayer.raw.id, lstate.node, 0);
        const time = computeClipTime(prevTime.get(clipId) ?? 0, eff, speedScale, speedReference, speed);
        layers.push({
          clipId,
          maskId: eff.mask !== undefined ? eff.mask : compiledLayer.raw.mask ?? "",
          time, weight: 1, blend: "override", speedScale,
          speedReference: speedScale === "velocity" ? speedReference : undefined,
        });
      }

      // weaponActionId / ticksIntoAction drive the client weapon-trail +
      // attachment. Derived from the primary slot running a swing action
      // (effects include weapon_trace). Trail-window precision is retuned
      // later (structure-over-parity pivot) — for now: geometry action id
      // while a swing is committed, ticks accumulated across the phases.
      const pa = slots?.["primary"];
      const paDef = pa ? this.content.actions.get(pa.actionId) : undefined;
      const paSwing = !!paDef?.effects.some((e) => e.kind === "weapon_trace") && !!geomAction;
      const weaponActionId = paSwing ? geomAction!.id : "";
      let ticksIntoAction = 0;
      if (paSwing && pa) {
        if (pa.phase === "active") ticksIntoAction = geomAction!.windupTicks + pa.ticksInPhase;
        else if (pa.phase === "winddown") ticksIntoAction = geomAction!.windupTicks + geomAction!.activeTicks + pa.ticksInPhase;
        // windup stays 0 — pre-active, no trail slices.
      }

      const next: AnimationStateData = { layers, weaponActionId, ticksIntoAction };
      if (!animStatesEqual(prev, next)) {
        world.set(entityId, AnimationState, next);
      }
  }

}

// ---- helpers ----

function velocityMagnitude(world: World, entityId: string): number {
  const v = world.get(entityId, Velocity);
  if (!v) return 0;
  return Math.sqrt(v.x * v.x + v.y * v.y);
}

/**
 * Resolve a state's clip reference to an actual clip id.
 *   "$slot"  → slotMap[slot]  (or empty if not mapped)
 *   "raw_id" → "raw_id"
 */
function resolveClipId(clipRef: string, slotMap: Record<string, string>): string {
  if (clipRef.startsWith("$")) {
    const slotName = clipRef.slice(1);
    return slotMap[slotName] ?? "";
  }
  return clipRef;
}

/**
 * Decide how fast a clip advances per tick.
 *
 * Loops and explicit numeric speedScale pass through unchanged. The auto-fit
 * cases:
 *
 *   - Combat swing states (`swing.windup` / `swing.active` / `swing.winddown`):
 *     three SM states share one clipId, with prevTime[clipId] persisting
 *     across the transitions. Setting speedScale = 1/totalSwingSeconds maps
 *     the clip's 0→1 range across the entire swing.
 *
 *   - Other non-loop states with a numeric duration (roll, hit_front, death,
 *     etc.): speedScale = 1/duration so the clip plays exactly once across
 *     the state's lifetime.
 *
 * Without these, a one-shot clip would only advance at the default 1 cycle/sec
 * cadence — usually slower than the SM state's duration, freezing the pose
 * mid-motion.
 */
function resolveSpeedScale(
  state: SMState,
  layerId: string,
  nodeId: string,
  swingTotalSec: number,
): number | "velocity" {
  if (state.speedScale !== undefined) {
    if (typeof state.speedScale === "number" || state.speedScale === "velocity") {
      return state.speedScale;
    }
  }
  // Combat layer's swing states: scale to the total swing duration.
  if (layerId === "right_hand" && nodeId.startsWith("swing.") && swingTotalSec > 0 && !state.loop) {
    return 1 / swingTotalSec;
  }
  // Other one-shot states with a numeric duration: auto-fit.
  if (!state.loop && typeof state.duration === "number" && state.duration > 0) {
    return 1 / state.duration;
  }
  return 1;
}

function computeClipTime(
  prev: number,
  state: SMState,
  speedScale: number | "velocity",
  speedReference: number,
  currentSpeed: number,
): number {
  let advance: number;
  if (speedScale === "velocity") {
    advance = (currentSpeed / speedReference) * TICK_DT;
  } else {
    advance = speedScale * TICK_DT;
  }
  if (state.loop) {
    return (prev + advance) % 1.0;
  }
  // One-shot: advance and clamp at 1. Per-weapon timing comes from the SM
  // state's duration (number or scope ref); the projection just walks the
  // clip from 0 → 1 across whatever real-time window the SM imposes.
  return Math.min(prev + advance, 1.0);
}

/**
 * Project the `locomotion` action slot into one AnimationLayer, replicating
 * exactly what the retired CSM locomotion layer emitted (T-226c).
 *
 *   - empty slot → fall back to the `idle` action, so the first tick after
 *     spawn (before the dispatcher's deferred write commits) shows the idle
 *     pose, not a rest-pose flash — matching the old spawn-time
 *     initialSMState seeding.
 *   - crouch variant: `anim.crouchClipId` when the `Crouched` tag is
 *     present, replacing the CSM's `posture.crouched` paramOverride.
 *   - speedScale / loop / mask / clip-time accumulation mirror the old
 *     `resolveSpeedScale` + `computeClipTime` (one-shot with no explicit
 *     speedScale auto-fits 1 / phase-duration; locomotion had no mask).
 *
 * Exported for the behavioral parity test.
 */
export function projectLocomotion(
  content: ContentService,
  slot: ActiveActionState | undefined,
  crouched: boolean,
  slotMap: Record<string, string>,
  prevTimeByClip: Map<string, number>,
  speed: number,
  walkSpeedRef: number,
): AnimationLayer | null {
  const def = content.actions.get(slot?.actionId || "idle");
  if (!def) return null;
  const phaseName = slot?.phase && def.phases[slot.phase]
    ? slot.phase
    : Object.keys(def.phases)[0];
  const anim = def.animation?.[phaseName];
  if (!anim) return null;

  const clipRef = crouched && anim.crouchClipId ? anim.crouchClipId : anim.clipId;
  const clipId = resolveClipId(clipRef, slotMap);
  if (!clipId) return null;

  const loop = anim.loop ?? false;
  const phaseTicks = def.phases[phaseName].ticks;
  const phaseDurSec = phaseTicks > 0 ? phaseTicks * TICK_DT : 0;
  const speedScale: number | "velocity" = anim.speedScale !== undefined
    ? anim.speedScale
    : (!loop && phaseDurSec > 0 ? 1 / phaseDurSec : 1);

  const time = computeClipTime(
    prevTimeByClip.get(clipId) ?? 0,
    { loop } as SMState,
    speedScale,
    walkSpeedRef,
    speed,
  );

  return {
    clipId,
    maskId: anim.mask ?? "",
    time,
    weight: 1,
    blend: "override",
    speedScale,
    speedReference: speedScale === "velocity" ? walkSpeedRef : undefined,
  };
}

function getTimeByClip(state: AnimationStateData | null): Map<string, number> {
  const m = new Map<string, number>();
  for (const l of state?.layers ?? []) m.set(l.clipId, l.time);
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
    if (la.maskId !== lb.maskId) return false;
  }
  return true;
}
