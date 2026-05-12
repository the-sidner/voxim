/**
 * CharacterStateMachineSystem — ticks every actor's CSM each frame.
 *
 * Runs early in the tick (after physics writes velocity, after NpcAi writes
 * input). Builds a per-entity SMScope by asking every registered
 * SMScopeContributor for its variables, advances the SM by `dt`, and writes
 * the new layer states back.
 *
 * The SM is the authoritative source of truth for "what mode is this actor
 * in." Damage handlers, ActionSystem, AnimationSystem all read csm.* to gate
 * behaviour. This system runs first so all of those see the resolved nodes
 * for this tick.
 *
 * Payload components like SwingContext are owned by the system that installs
 * them (ActionSystem in that case). The CSM never reaches into payload
 * components — it is a pure state machine.
 *
 * Scope variable additions go in `../sm_scope/` — one file per namespace —
 * not in this file. T-192 made this contributor-driven; T-194 will add
 * compile-time validation cross-checking contributors against transitions.
 */

import type { World, EntityId } from "@voxim/engine";
import type { ContentService, CompiledStateMachine, SMRuntimeState, SMScopeValue } from "@voxim/content";
import {
  compileStateMachine,
  smTickAll,
  initialSMState,
  validateStateMachineScope,
  collectSlotRefs,
} from "@voxim/content";
import type { System, EventEmitter } from "../system.ts";
import { CharacterStateMachine } from "../components/character_state_machine.ts";
import { TickEventBuffer } from "../tick_events.ts";
import { createLogger } from "../logger.ts";
import type { SMScopeContributor, SMScopeContext } from "../sm_scope/index.ts";
import { DEFAULT_SM_SCOPE_CONTRIBUTORS, collectKnownScopeVars } from "../sm_scope/index.ts";

const log = createLogger("CharacterStateMachineSystem");

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

  private readonly contributors: readonly SMScopeContributor[];

  constructor(
    private readonly content: ContentService,
    private readonly tickEvents: TickEventBuffer,
    contributors: readonly SMScopeContributor[] = DEFAULT_SM_SCOPE_CONTRIBUTORS,
  ) {
    this.contributors = contributors;
    const knownVars = collectKnownScopeVars(contributors);

    for (const def of content.stateMachines.values()) {
      let compiled: CompiledStateMachine;
      try {
        compiled = compileStateMachine(def);
      } catch (err) {
        log.error("failed to compile state machine '%s': %s", def.id, (err as Error).message);
        throw err;
      }

      // T-194: cross-check transition scope refs against registered
      // contributor outputs. Catches typos like `healt.current` at boot.
      validateStateMachineScope(compiled, knownVars);

      // T-194: every prefab that uses this SM must declare animationSlots
      // satisfying every $slot the SM references. Catches `$walk_forwrd`
      // typos in the SM and missing slot entries in the prefab.
      const slotRefs = collectSlotRefs(def);
      if (slotRefs.size > 0) {
        for (const prefab of content.prefabs.values()) {
          if (prefab.stateMachineId !== def.id) continue;
          const slots = prefab.animationSlots ?? {};
          const missing: string[] = [];
          for (const slot of slotRefs) {
            if (!(slot in slots)) missing.push(slot);
          }
          if (missing.length > 0) {
            throw new Error(
              `prefab '${prefab.id}' uses state machine '${def.id}' but is missing animationSlots for: ${missing.sort().join(", ")}`,
            );
          }
        }
      }

      this.compiledCache.set(def.id, compiled);
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

    const scope = this.buildScope(world, entityId);
    const { next } = smTickAll(compiled, seeded, scope, TICK_DT_SECONDS);

    world.set(entityId, CharacterStateMachine, {
      stateMachineId: csm.stateMachineId,
      layerStates: next,
    });
  }

  private buildScope(world: World, entityId: EntityId): Record<string, SMScopeValue> {
    const scope: Record<string, SMScopeValue> = {};
    const ctx: SMScopeContext = {
      world,
      entityId,
      content: this.content,
      tickEvents: this.tickEvents,
    };
    for (const c of this.contributors) c.contribute(ctx, scope);
    return scope;
  }
}
