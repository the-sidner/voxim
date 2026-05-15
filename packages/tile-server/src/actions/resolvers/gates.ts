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
import { Stamina } from "../../components/game.ts";

/** Passes when the entity is NOT mid-stagger (stagger locks out actions). */
export const notStaggeredGate: GateHandler = {
  id: "not_staggered",
  test: (ctx) => !ctx.world.has(ctx.entityId, Staggered),
};

/** Passes when the entity has stamina to spend (not in the exhausted state). */
export const notExhaustedGate: GateHandler = {
  id: "not_exhausted",
  test: (ctx) => !(ctx.world.get(ctx.entityId, Stamina)?.exhausted ?? false),
};
