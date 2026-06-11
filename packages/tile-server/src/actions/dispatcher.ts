/**
 * ActionDispatcher (T-226) — the one writer of `ActiveActions`.
 *
 * Per tick, for every entity carrying `ActiveActions`:
 *
 *   1. ADVANCE each occupied slot's action by one tick — fire `:tick`
 *      effects, count the phase, and on phase end fire `:exit`, advance to
 *      the next phase firing its `:enter` (or complete / loop for ambient).
 *   2. RESOLVE intent — an injected `IntentResolver` maps each declared slot
 *      to a desired action id (locomotion → idle/walk by velocity, posture →
 *      upright/crouched by input, etc.). The substrate ships no resolver;
 *      the locomotion/posture migration provides the first one.
 *   3. ARBITRATE — start the desired action if the slot is free and its
 *      preconditions + costs pass; cancel-into it if the running action's
 *      cancel matrix (for its current phase) admits it; or honour a
 *      reaction's interrupt priority. Otherwise keep the running action.
 *
 * Phase model (precise): a phase's `ticks` is its duration. `:enter` fires
 * once when the phase begins; `:tick` fires on every subsequent advance
 * while still in the phase; `:exit` fires when the phase ends, immediately
 * followed by the next phase's `:enter` (or, with no next phase, action
 * completion — slot cleared — or, for `ambient`, a loop back to the first
 * phase). A phase with `ticks: -1` is perpetual (ambient only): it never
 * advances out; `:tick` fires every tick.
 *
 * Entity-generic: works for any entity with `ActiveActions`, not just
 * actors. Entities without `ActorSlots` (future buffs/projectiles) skip
 * slot-membership validation. Entities without an applicable IntentResolver
 * just have their running actions advanced.
 *
 * The dispatcher never calls `applyChangeset` and never fires events
 * directly — effects do that through the injected registries; slot state is
 * written via `world.set`.
 */

import type { World, EntityId } from "@voxim/engine";
import type { ContentService, ActionDef, ActionGate } from "@voxim/content";
import type { System, EventEmitter } from "../system.ts";
import { ActorSlots, ActiveActions } from "../components/action.ts";
import { ActionCooldowns } from "../components/action_cooldowns.ts";
import type { ActiveActionState, ActiveActionsData } from "../components/action.ts";
import type { GateRegistry, GateContext } from "./gate.ts";
import type { EffectRegistry, EffectEdge } from "./effect.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("ActionDispatcher");

/**
 * Maps an entity's declared slots to the action each slot should be running
 * this tick. `null` means "nothing desired" (leave the slot as-is / let it
 * run out). Ambient-slot resolvers always name an action (idle is still an
 * action). The migration implements this against velocity / input; tests
 * inject fakes; the substrate ships none.
 */
export interface IntentResolver {
  resolve(world: World, entityId: EntityId, slots: readonly string[]): Map<string, string | null>;
}

/**
 * Resource accounting for action `costs`. Absent ⇒ costs are ignored
 * (substrate default). The migration injects the Stamina-aware handler.
 */
export interface CostHandler {
  affordable(world: World, entityId: EntityId, costs: Record<string, number>): boolean;
  deduct(world: World, entityId: EntityId, costs: Record<string, number>): void;
}

/** `true` if `id` is admitted by a cancel-into target list entry. */
function idMatches(id: string, target: string): boolean {
  if (target === "any") return true;
  if (target.endsWith("*")) return id.startsWith(target.slice(0, -1));
  return id === target;
}

export class ActionDispatcher implements System {
  /** Runs after NpcAi (NPC intent) and Physics (velocity drives locomotion intent). */
  readonly dependsOn = ["NpcAiSystem", "PhysicsSystem"];

  private serverTick = 0;

  constructor(
    private readonly content: ContentService,
    private readonly gates: GateRegistry,
    private readonly effects: EffectRegistry,
    private readonly intent: IntentResolver | null = null,
    private readonly costs: CostHandler | null = null,
  ) {}

  prepare(serverTick: number): void {
    this.serverTick = serverTick;
  }

  run(world: World, events: EventEmitter, _dt: number): void {
    // ── Cooldown tick-down (T-260; single writer: this system) ────────────
    // Spent keys are dropped. Stamps from this run's start() calls compose
    // with the decrement via the ordered op-log (T-249).
    for (const { entityId, actionCooldowns } of world.query(ActionCooldowns)) {
      if (actionCooldowns.gcd === 0 && Object.keys(actionCooldowns.remaining).length === 0) continue;
      world.mutate(entityId, ActionCooldowns, (ac) => {
        const remaining: Record<string, number> = {};
        for (const [id, ticks] of Object.entries(ac.remaining)) {
          if (ticks > 1) remaining[id] = ticks - 1;
        }
        return { gcd: ac.gcd > 0 ? ac.gcd - 1 : 0, remaining };
      });
    }

    for (const { entityId, activeActions } of world.query(ActiveActions)) {
      const declared = world.get(entityId, ActorSlots)?.slots ?? null;
      // Work on a shallow copy of the slot map; commit once at the end.
      const states: Record<string, ActiveActionState> = {};
      for (const [slot, s] of Object.entries(activeActions.states)) {
        states[slot] = { ...s };
      }

      // ── 1. Advance every occupied slot ───────────────────────────────────
      for (const slot of Object.keys(states)) {
        const survived = this.advance(world, events, entityId, slot, states[slot]);
        if (survived) states[slot] = survived;
        else delete states[slot];
      }

      // ── 2 + 3. Resolve intent, then arbitrate per slot ───────────────────
      if (this.intent && declared) {
        const desired = this.intent.resolve(world, entityId, declared);
        for (const slot of declared) {
          const want = desired.get(slot);
          if (!want) continue;
          this.arbitrate(world, events, entityId, slot, want, states, declared);
        }
      }

      if (!sameStates(activeActions.states, states)) {
        const next: ActiveActionsData = { states };
        world.set(entityId, ActiveActions, next);
      }
    }
  }

  // ---- phase advancement ----

  /**
   * Advance one slot's action by a tick. Returns the next state, or null if
   * the action completed and the slot should be cleared.
   */
  private advance(
    world: World,
    events: EventEmitter,
    entityId: EntityId,
    slot: string,
    state: ActiveActionState,
  ): ActiveActionState | null {
    const def = this.content.actions.get(state.actionId);
    if (!def) {
      // Action id no longer in content (hot-reload / bad data) — drop it
      // rather than stall the slot forever.
      log.warn("slot=%s references unknown action '%s' on entity=%s — clearing", slot, state.actionId, entityId);
      return null;
    }
    const phaseNames = Object.keys(def.phases);
    const phase = def.phases[state.phase];
    if (!phase) {
      log.warn("action '%s' has no phase '%s' — clearing slot=%s", def.id, state.phase, slot);
      return null;
    }

    // :tick fires on every advance after the entry tick.
    if (state.ticksInPhase > 0) {
      this.fireEffects(world, events, entityId, slot, state, def, state.phase, "tick");
    }

    if (phase.ticks === -1) {
      // Perpetual (ambient): never advances out. Keep counting so
      // duration-style gates (windup-held) still work.
      return { ...state, ticksInPhase: state.ticksInPhase + 1 };
    }

    const ticksInPhase = state.ticksInPhase + 1;
    if (ticksInPhase < phase.ticks) {
      return { ...state, ticksInPhase };
    }

    // Phase end.
    this.fireEffects(world, events, entityId, slot, state, def, state.phase, "exit");
    const idx = phaseNames.indexOf(state.phase);
    const nextPhase = phaseNames[idx + 1];
    if (nextPhase) {
      const next: ActiveActionState = { ...state, phase: nextPhase, ticksInPhase: 0 };
      this.fireEffects(world, events, entityId, slot, next, def, nextPhase, "enter");
      return next;
    }
    if (def.kind === "ambient") {
      // Loop back to the first phase (single-perpetual-phase ambients never
      // reach here; multi-phase ambients cycle).
      const first = phaseNames[0];
      const looped: ActiveActionState = { ...state, phase: first, ticksInPhase: 0 };
      this.fireEffects(world, events, entityId, slot, looped, def, first, "enter");
      return looped;
    }
    // active / reaction: completed — slot cleared.
    return null;
  }

  // ---- intent arbitration ----

  private arbitrate(
    world: World,
    events: EventEmitter,
    entityId: EntityId,
    slot: string,
    wantId: string,
    states: Record<string, ActiveActionState>,
    declared: readonly string[],
  ): void {
    const want = this.content.actions.get(wantId);
    if (!want) {
      log.warn("intent requested unknown action '%s' for slot=%s", wantId, slot);
      return;
    }
    if (want.slot !== slot) {
      log.warn("action '%s' declares slot '%s' but was requested for slot '%s'", wantId, want.slot, slot);
      return;
    }
    if (!declared.includes(slot)) return; // actor doesn't have this slot

    const current = states[slot];
    if (current && current.actionId === wantId) return; // already running it

    if (!current) {
      if (this.canStart(world, entityId, want)) {
        this.start(world, events, entityId, slot, want, "intent", states);
      }
      return;
    }

    // Slot occupied — decide whether `want` may displace `current`.
    const curDef = this.content.actions.get(current.actionId);
    const curPriority = curDef?.priority ?? 0;

    if (
      want.kind === "reaction" &&
      typeof want.interruptPriority === "number" &&
      want.interruptPriority > curPriority
    ) {
      // Forced interrupt — bypasses the current action's cancel matrix.
      if (this.canStart(world, entityId, want)) {
        if (curDef) this.fireEffects(world, events, entityId, slot, current, curDef, current.phase, "exit");
        this.start(world, events, entityId, slot, want, "event", states);
      }
      return;
    }

    const rule = curDef?.cancel[current.phase];
    if (!rule) return; // phase committed (no cancel rule) — reject
    if (!rule.into.some((t) => idMatches(wantId, t))) return; // not admitted
    if (rule.gates && !this.gatesPass(world, entityId, rule.gates)) return;
    if (!this.canStart(world, entityId, want)) return;

    if (curDef) this.fireEffects(world, events, entityId, slot, current, curDef, current.phase, "exit");
    this.start(world, events, entityId, slot, want, "intent", states);
  }

  /** Preconditions + cooldowns + cost affordability. Does not mutate. */
  private canStart(world: World, entityId: EntityId, def: ActionDef): boolean {
    // Per-action cooldown + global cooldown (T-260) — committed view; the
    // decrement queued this tick hasn't landed, so a cooldown reads one
    // tick high here (an accepted ≤1-tick retune, same as Resources).
    if ((def.cooldownTicks ?? 0) > 0 || def.triggersGcd) {
      const ac = world.get(entityId, ActionCooldowns);
      if ((def.cooldownTicks ?? 0) > 0 && (ac?.remaining[def.id] ?? 0) > 0) return false;
      if (def.triggersGcd && (ac?.gcd ?? 0) > 0) return false;
    }
    if (def.preconditions && !this.gatesPass(world, entityId, def.preconditions)) return false;
    if (def.costs && this.costs && !this.costs.affordable(world, entityId, def.costs)) return false;
    return true;
  }

  /** Install `def` in `slot`: deduct costs, seed phase 0, fire its `:enter`. */
  private start(
    world: World,
    events: EventEmitter,
    entityId: EntityId,
    slot: string,
    def: ActionDef,
    initiator: ActiveActionState["initiator"],
    states: Record<string, ActiveActionState>,
  ): void {
    if (def.costs && this.costs) this.costs.deduct(world, entityId, def.costs);
    // Stamp per-action cooldown + GCD on actual start (T-260) — a request
    // rejected by the cancel matrix burns nothing.
    const cd = def.cooldownTicks ?? 0;
    const gcd = def.triggersGcd ? this.content.getGameConfig().lore.globalCooldownTicks : 0;
    if (cd > 0 || gcd > 0) {
      if (world.has(entityId, ActionCooldowns)) {
        world.mutate(entityId, ActionCooldowns, (ac) => ({
          gcd: Math.max(ac.gcd, gcd),
          remaining: cd > 0 ? { ...ac.remaining, [def.id]: cd } : ac.remaining,
        }));
      } else {
        world.set(entityId, ActionCooldowns, {
          gcd,
          remaining: cd > 0 ? { [def.id]: cd } : {},
        });
      }
    }
    const first = Object.keys(def.phases)[0];
    const state: ActiveActionState = { actionId: def.id, phase: first, ticksInPhase: 0, initiator };
    states[slot] = state;
    this.fireEffects(world, events, entityId, slot, state, def, first, "enter");
  }

  // ---- shared helpers ----

  private gatesPass(world: World, entityId: EntityId, gates: ActionGate[]): boolean {
    for (const g of gates) {
      const handler = this.gates.get(g.gate); // throws on unknown id — fail fast
      const ctx: GateContext = {
        world,
        entityId,
        content: this.content,
        params: g.params ?? {},
      };
      if (!handler.test(ctx)) return false;
    }
    return true;
  }

  private fireEffects(
    world: World,
    events: EventEmitter,
    entityId: EntityId,
    slot: string,
    state: ActiveActionState,
    def: ActionDef,
    phase: string,
    edge: EffectEdge,
  ): void {
    const ref = `${phase}:${edge}`;
    for (const eff of def.effects) {
      if (eff.phase !== ref) continue;
      this.effects.get(eff.kind).resolve({
        world,
        events,
        entityId,
        slot,
        state,
        content: this.content,
        params: eff.params ?? {},
        edge,
        serverTick: this.serverTick,
      });
    }
  }
}

/** Structural equality of two slot→state maps (avoids needless deltas). */
function sameStates(
  a: Record<string, ActiveActionState>,
  b: Record<string, ActiveActionState>,
): boolean {
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    const x = a[k];
    const y = b[k];
    if (!y) return false;
    if (
      x.actionId !== y.actionId ||
      x.phase !== y.phase ||
      x.ticksInPhase !== y.ticksInPhase ||
      x.initiator !== y.initiator ||
      JSON.stringify(x.scratch ?? null) !== JSON.stringify(y.scratch ?? null)
    ) {
      return false;
    }
  }
  return true;
}
