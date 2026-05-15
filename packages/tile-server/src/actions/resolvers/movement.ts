/**
 * Movement effect resolvers (T-229).
 *
 * `dodge_impulse` — the gameplay half of the `dodge_roll` action. Fires on
 * the dash phase's `:enter`: reads the actor's movement input (or backsteps
 * relative to facing when there's none) and writes a committed dash
 * Velocity at `game_config.dodge.speed`. The dash phase declares
 * `movement: "locked"`, so PhysicsSystem holds this velocity vector for the
 * phase's duration instead of blending input — the impulse plays out as a
 * clean hop rather than being diluted (the old `Sidestep` component's job,
 * now generic to the movement enum).
 */

import type { EffectResolver } from "../effect.ts";
import { InputState, Velocity, Facing } from "../../components/game.ts";

export const dodgeImpulseResolver: EffectResolver = {
  id: "dodge_impulse",
  resolve(ctx) {
    const input = ctx.world.get(ctx.entityId, InputState);
    const speed = ctx.content.getGameConfig().dodge.speed;

    const mx = input?.movementX ?? 0;
    const my = input?.movementY ?? 0;
    const moveLen = Math.sqrt(mx * mx + my * my);

    let dx: number, dy: number;
    if (moveLen > 0.1) {
      dx = mx / moveLen;
      dy = my / moveLen;
    } else {
      // No directional input → hop backwards relative to facing.
      const ang = input?.facing ?? ctx.world.get(ctx.entityId, Facing)?.angle ?? 0;
      dx = -Math.cos(ang);
      dy = -Math.sin(ang);
    }

    const z = ctx.world.get(ctx.entityId, Velocity)?.z ?? 0;
    ctx.world.set(ctx.entityId, Velocity, { x: dx * speed, y: dy * speed, z });
  },
};
