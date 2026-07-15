/**
 * Combat-state gates (T-229).
 *
 * Closed-vocabulary predicates the dispatcher evaluates for action
 * `preconditions` / `cancel.<phase>.gates`. Pure — they never mutate the
 * world. New conditions are new registered gates here, never inline logic
 * in an action or the dispatcher.
 */

import type { GateHandler } from "../gate.ts";
import { Staggered } from "../../components/tags.ts";
import { Health } from "../../components/game.ts";
import { staminaValue } from "../../combat/helpers.ts";
import { ActiveActions } from "../../components/action.ts";

/** Passes when the entity is NOT mid-stagger (stagger locks out actions). */
export const notStaggeredGate: GateHandler = {
  id: "not_staggered",
  test: (ctx) => !ctx.world.has(ctx.entityId, Staggered),
};

/** Passes when the entity has stamina left (value > 0; "exhausted" == ≤0). */
export const notExhaustedGate: GateHandler = {
  id: "not_exhausted",
  test: (ctx) => staminaValue(ctx.world, ctx.entityId) > 0,
};

/**
 * Passes when the entity's health fraction is strictly below
 * `params.fraction` (default 0.25). The low-health proc condition (T-259c)
 * — `on: damage_taken` + this gate is a "below X % HP" trigger with no new
 * event needed. No Health component = never passes.
 */
export const healthBelowGate: GateHandler = {
  id: "health_below",
  test: (ctx) => {
    const h = ctx.world.get(ctx.entityId, Health);
    if (!h || h.max <= 0) return false;
    const fraction = typeof ctx.params.fraction === "number" ? ctx.params.fraction : 0.25;
    return h.current / h.max < fraction;
  },
};

/**
 * uninterruptible_active (T-299) — passes UNLESS the entity's own `primary`
 * slot is running a `committed` action's `active` phase. A precondition on
 * the LIGHT reactions (hit_front/hit_back/stagger_light), NOT stagger_heavy
 * or death — the doctrine-intended "only block/dodge/death stop it" reading
 * for a committed swing's live hitbox window.
 *
 * Why a precondition and not a cancel-matrix change: reactions occupy their
 * OWN `reaction` slot (distinct from swings' `primary` slot in every real
 * content file), and the dispatcher's forced-interrupt path (higher
 * `interruptPriority` displacing a running incumbent) only ever compares
 * same-slot occupants — it never looks at what's running in ANOTHER slot.
 * So a stagger reaction starting in `reaction` was never actually blockABLE
 * by what's running in `primary` before this gate; this is the one place
 * that cross-slot condition can be expressed without an engine change
 * (registry-dispatch doctrine: a new predicate is a new gate, never a
 * dispatcher `switch`).
 *
 * Scope note: this reads ANY actor's own primary slot, not just the two
 * T-299 showcase archetypes — a player's own committed swing_heavy also
 * becomes flinch-immune mid-active. Intentional and symmetric (no isNpc
 * branch), and the stagger_heavy/death paths are untouched so a real stagger
 * or a kill still always lands.
 */
export const uninterruptibleActiveGate: GateHandler = {
  id: "uninterruptible_active",
  test: (ctx) => {
    const primary = ctx.world.get(ctx.entityId, ActiveActions)?.states["primary"];
    if (!primary) return true;
    const def = ctx.content.actions.get(primary.actionId);
    return !(def?.committed && primary.phase === "active");
  },
};
