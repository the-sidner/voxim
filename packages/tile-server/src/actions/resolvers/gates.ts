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
