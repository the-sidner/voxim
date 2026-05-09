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
import { SwingContext } from "../components/swing_context.ts";
import { AnimationSlots } from "../components/animation_slots.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("AnimationSystem");

const TICK_DT = 1 / 20;

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

      const layerStates: SMRuntimeState = csm.layerStates as SMRuntimeState;
      const baseSlots = world.get(entityId, AnimationSlots)?.slots ?? {};
      // During a swing, override `weapon.swing_clip` with the active weapon
      // action's clipId so the animation matches the equipped weapon, not
      // the actor-prefab default. SwingContext is present iff csm.combat is
      // in a swing.* state, which is exactly when the slot resolves.
      const swing = world.get(entityId, SwingContext);
      const swingClip = swing
        ? this.content.weaponActions.get(swing.weaponActionId)?.clipId
        : undefined;
      const slotMap = swingClip
        ? { ...baseSlots, "weapon.swing_clip": swingClip }
        : baseSlots;
      const speed = velocityMagnitude(world, entityId);
      const prev  = world.get(entityId, AnimationState);
      const prevTime = getTimeByClip(prev);

      // Build the SM scope just well enough to evaluate paramOverrides
      // (typically just csm.<layer> reads). No need for full input/event vars
      // here — those gate transitions, not effective-state overrides.
      const baseScope: Record<string, SMScopeValue> = { ...buildCsmVars(layerStates) };

      const layers: AnimationLayer[] = [];
      // Total swing duration in seconds — used to scale the swing clip's
      // playback so it covers exactly windup→active→winddown when the three
      // states share the same clipId (prevTime keyed by clip persists across
      // SM transitions, so a constant speedScale = 1/totalSec maps the
      // whole clip across the whole swing).
      const swingTotalSec = swing
        ? this.swingTotalSeconds(swing.weaponActionId)
        : 0;

      for (const compiledLayer of compiled.layers) {
        if (compiledLayer.raw.output !== "animation") continue;

        const lstate = layerStates[compiledLayer.raw.id];
        if (!lstate) continue;

        const eff = effectiveState(compiledLayer, lstate.node, baseScope);
        if (!eff.clip) continue; // null clip — layer contributes nothing this tick

        const clipId = resolveClipId(eff.clip, slotMap);
        if (!clipId) continue;

        const speedReference = eff.speedReference ?? walkSpeedRef;
        const speedScale = resolveSpeedScale(eff, compiledLayer.raw.id, lstate.node, swingTotalSec);

        const time = computeClipTime(
          prevTime.get(clipId) ?? 0,
          eff,
          speedScale,
          speedReference,
          speed,
        );

        // Per-state mask override: the state's `mask` (if set) wins over the
        // layer's; an explicit "" means full body. undefined falls back to
        // the layer's mask. This is how combat layer's swing.* states
        // escape the upper_body mask to drive the whole skeleton.
        const maskId = eff.mask !== undefined
          ? eff.mask
          : compiledLayer.raw.mask ?? "";

        layers.push({
          clipId,
          maskId,
          time,
          weight: 1,
          blend: "override",
          speedScale,
          speedReference: speedScale === "velocity" ? speedReference : undefined,
        });
      }

      // weaponActionId/ticksIntoAction drive the client weapon-trail and
      // attachment positioning. ticksIntoAction is CUMULATIVE across the
      // three swing phases (windup → active → winddown) — the renderer's
      // active-window check (`ticks in [windupTicks, windupTicks+activeTicks)`)
      // expects that. CSM combat.elapsed alone resets on each phase
      // transition, so we add the prior phases' tick budgets here.
      const combatNode = layerStates["combat"]?.node ?? "";
      const inSwing = combatNode.startsWith("swing.");
      const weaponActionId  = inSwing && swing ? swing.weaponActionId : "";
      const action = inSwing && swing ? this.content.weaponActions.get(swing.weaponActionId) : undefined;
      let ticksIntoAction = 0;
      if (inSwing && action) {
        const phaseTicks = Math.round((layerStates["combat"]?.elapsed ?? 0) / TICK_DT);
        if (combatNode === "swing.windup")        ticksIntoAction = phaseTicks;
        else if (combatNode === "swing.active")   ticksIntoAction = action.windupTicks + phaseTicks;
        else if (combatNode === "swing.winddown") ticksIntoAction = action.windupTicks + action.activeTicks + phaseTicks;
      }

      const next: AnimationStateData = { layers, weaponActionId, ticksIntoAction };
      if (!animStatesEqual(prev, next)) {
        world.set(entityId, AnimationState, next);
      }
  }

  private swingTotalSeconds(weaponActionId: string): number {
    const action = this.content.weaponActions.get(weaponActionId);
    if (!action) return 0;
    return (action.windupTicks + action.activeTicks + action.winddownTicks) * TICK_DT;
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
  if (layerId === "combat" && nodeId.startsWith("swing.") && swingTotalSec > 0 && !state.loop) {
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
