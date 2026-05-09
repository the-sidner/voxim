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
      for (const compiledLayer of compiled.layers) {
        if (compiledLayer.raw.output !== "animation") continue;

        const lstate = layerStates[compiledLayer.raw.id];
        if (!lstate) continue;

        const eff = effectiveState(compiledLayer, lstate.node, baseScope);
        if (!eff.clip) continue; // null clip — layer contributes nothing this tick

        const clipId = resolveClipId(eff.clip, slotMap);
        if (!clipId) continue;

        const speedScale = eff.speedScale ?? 1;
        const speedReference = eff.speedReference ?? walkSpeedRef;

        const time = computeClipTime(
          prevTime.get(clipId) ?? 0,
          eff,
          speedScale,
          speedReference,
          speed,
        );

        layers.push({
          clipId,
          maskId: compiledLayer.raw.mask ?? "",
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
