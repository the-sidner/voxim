/**
 * CharacterStateMachineSystem — ticks every actor's CSM each frame.
 *
 * Runs early in the tick (after physics writes velocity, after NpcAi writes
 * input). Builds a per-entity SMScope from observable component state plus
 * any one-tick events the TickEventBuffer holds, advances the SM by `dt`,
 * and writes the new layer states back. Transition events surface so payload
 * components (SwingContext, future CastContext, etc.) can be cleaned up when
 * their host CSM state exits.
 *
 * The SM is the authoritative source of truth for "what mode is this actor
 * in." Damage handlers read csm.combat for block, ActionSystem reads it to
 * gate new swings, AnimationSystem projects animation-typed layers to
 * AnimationLayer[]. This system runs first so all of those see the
 * resolved nodes for this tick.
 */

import type { World, EntityId } from "@voxim/engine";
import type { ContentService, CompiledStateMachine, SMRuntimeState, SMScopeValue } from "@voxim/content";
import {
  compileStateMachine,
  smTickAll,
  initialSMState,
} from "@voxim/content";
import { ACTION_BLOCK, ACTION_DODGE, ACTION_CROUCH, ACTION_SKILL_1, ACTION_SKILL_2, ACTION_SKILL_3, ACTION_SKILL_4, ACTION_USE_SKILL, ACTION_JUMP, ACTION_CONSUME, hasAction } from "@voxim/protocol";
import type { System, EventEmitter } from "../system.ts";
import { Velocity, Health, InputState } from "../components/game.ts";
import { Equipment } from "../components/equipment.ts";
import { CharacterStateMachine } from "../components/character_state_machine.ts";
import { SwingContext } from "../components/swing_context.ts";
import { TickEventBuffer } from "../tick_events.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("CharacterStateMachineSystem");

/** 20 Hz server tick — one tick = 0.05 seconds. */
const SECONDS_PER_TICK = 1 / 20;

/** Server tick rate in seconds (20 Hz). */
const TICK_DT_SECONDS = 1 / 20;

export class CharacterStateMachineSystem implements System {
  /**
   * Runs after NpcAiSystem (NPCs write InputState) and PhysicsSystem (Velocity
   * is up to date), before any system that reads csm.* nodes for gating.
   */
  readonly dependsOn = ["NpcAiSystem", "PhysicsSystem"];

  /** Compiled SM defs — built eagerly at construction time so any parse / schema error fails fast at server boot, not at the first tick involving an actor that uses the SM. */
  private compiledCache = new Map<string, CompiledStateMachine>();
  /** Per-SM-id: rate-limit "skipped due to error" log spam to one per id. */
  private loggedFailures = new Set<string>();

  constructor(
    private readonly content: ContentService,
    private readonly tickEvents: TickEventBuffer,
  ) {
    for (const def of content.stateMachines.values()) {
      try {
        this.compiledCache.set(def.id, compileStateMachine(def));
      } catch (err) {
        log.error("failed to compile state machine '%s': %s", def.id, (err as Error).message);
        throw err;
      }
    }
  }

  run(world: World, _events: EventEmitter, _dt: number): void {
    for (const { entityId, characterStateMachine: csm } of world.query(CharacterStateMachine)) {
      const compiled = this.compiledCache.get(csm.stateMachineId);
      if (!compiled) continue;

      try {
        this.tickOne(world, entityId, csm, compiled);
      } catch (err) {
        // One bad entity must not stall the tick loop. Log once per SM id —
        // the same entity will keep failing if its scope is missing a var,
        // and we don't want to spam every frame.
        const key = `${csm.stateMachineId}:${(err as Error).message}`;
        if (!this.loggedFailures.has(key)) {
          this.loggedFailures.add(key);
          log.error("CSM tick failed for entity=%s sm=%s: %s",
            entityId, csm.stateMachineId, (err as Error).message);
        }
      }
    }

    // One-tick events are consumed by the SM tick above; clear for next frame.
    this.tickEvents.clear();
  }

  private tickOne(
    world: World,
    entityId: EntityId,
    csm: { stateMachineId: string; layerStates: Record<string, { node: string; elapsed: number }> },
    compiled: CompiledStateMachine,
  ): void {
    const prev: SMRuntimeState = csm.layerStates as SMRuntimeState;
    // First tick after spawn: layerStates may be empty. Seed from def.
    const seeded = Object.keys(prev).length === 0 ? initialSMState(compiled) : prev;

    const scope = buildSMScope(world, entityId, this.tickEvents, this.content);

    const { next, fired } = smTickAll(compiled, seeded, scope, TICK_DT_SECONDS);

    // Transition-event handling: payload components bound to a state are
    // removed when the CSM exits that state.
    for (const f of fired) {
      if (f.layer === "combat" && isSwingNode(f.from) && !isSwingNode(f.to)) {
        if (world.has(entityId, SwingContext)) world.remove(entityId, SwingContext);
      }
    }

    world.set(entityId, CharacterStateMachine, {
      stateMachineId: csm.stateMachineId,
      layerStates: next,
    });
  }
}

function isSwingNode(node: string): boolean {
  return node === "swing.windup" || node === "swing.active" || node === "swing.winddown";
}

/**
 * Build the SMScope for one entity. Reads observable components plus any
 * one-tick events fired this tick. Variables that aren't derivable default to
 * the SM's "off" value (0 / false) so undefined-variable errors don't trip
 * during gameplay; the only hard requirement is that compiled expressions
 * parse cleanly at content-load.
 */
export function buildSMScope(
  world: World,
  entityId: EntityId,
  tickEvents: TickEventBuffer,
  content: ContentService,
): Record<string, SMScopeValue> {
  const scope: Record<string, SMScopeValue> = {};

  // Velocity → magnitude. Direction left at 0,0 unless we need it later.
  const vel = world.get(entityId, Velocity);
  const vx = vel?.x ?? 0;
  const vy = vel?.y ?? 0;
  scope["vel.mag"] = Math.sqrt(vx * vx + vy * vy);

  // Health.
  const health = world.get(entityId, Health);
  scope["health.current"] = health?.current ?? 0;
  scope["health.max"] = health?.max ?? 0;
  scope["health.frac"] = health && health.max > 0 ? health.current / health.max : 0;

  // Input bits exposed as named bools.
  const input = world.get(entityId, InputState);
  const a = input?.actions ?? 0;
  scope["input.use_skill"] = hasAction(a, ACTION_USE_SKILL);
  scope["input.block"]     = hasAction(a, ACTION_BLOCK);
  scope["input.jump"]      = hasAction(a, ACTION_JUMP);
  scope["input.dodge"]     = hasAction(a, ACTION_DODGE);
  scope["input.crouch"]    = hasAction(a, ACTION_CROUCH);
  scope["input.consume"]   = hasAction(a, ACTION_CONSUME);
  scope["input.skill_1"]   = hasAction(a, ACTION_SKILL_1);
  scope["input.skill_2"]   = hasAction(a, ACTION_SKILL_2);
  scope["input.skill_3"]   = hasAction(a, ACTION_SKILL_3);
  scope["input.skill_4"]   = hasAction(a, ACTION_SKILL_4);
  // "input.aim" is a useful semantic alias even though there's no dedicated
  // ACTION_AIM bit yet — wire it as false until the action exists.
  scope["input.aim"] = false;

  // Active-swing context exposes the equipped weapon action's tick budget so
  // the SM's swing.* state durations can come from the weapon (per-weapon
  // timing) rather than being hardcoded in JSON.
  const swing = world.get(entityId, SwingContext);
  if (swing) {
    const action = content.weaponActions.get(swing.weaponActionId);
    if (action) {
      scope["action.windup_seconds"]   = action.windupTicks   * SECONDS_PER_TICK;
      scope["action.active_seconds"]   = action.activeTicks   * SECONDS_PER_TICK;
      scope["action.winddown_seconds"] = action.winddownTicks * SECONDS_PER_TICK;
    }
  }
  if (!("action.windup_seconds"   in scope)) scope["action.windup_seconds"]   = 0;
  if (!("action.active_seconds"   in scope)) scope["action.active_seconds"]   = 0;
  if (!("action.winddown_seconds" in scope)) scope["action.winddown_seconds"] = 0;

  // Equipment-derived weapon flags. Future weapons declare aim/block tags on
  // their prefab; for now we infer from presence of an equipped weapon and
  // its prefab id (block requires a shield/two-handed weapon — currently
  // there's no canonical capability flag, so default both to true so
  // transitions don't lock out).
  const eq = world.get(entityId, Equipment);
  scope["equipped.weapon"] = eq?.weapon ? true : false;
  scope["weapon.has_block"] = eq?.weapon ? true : false;
  scope["weapon.has_aim"]   = false;

  // One-tick events fired by other systems this frame.
  for (const ev of tickEvents.get(entityId)) {
    scope[ev] = true;
  }
  // Defaults for known event vars so transitions referencing them don't
  // throw on the first tick that hasn't seen the event.
  for (const ev of [
    "event.swing_started", "event.shoot_fired",
    "event.left_ground", "event.landed",
    "event.hit", "event.hit.heavy", "event.hit.from_front", "event.hit.from_back",
  ]) {
    if (!(ev in scope)) scope[ev] = false;
  }

  return scope;
}
