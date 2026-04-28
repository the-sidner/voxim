/**
 * Ballistic kinematics — gravity + integration with no input handling and
 * no horizontal drag.  Suitable for any actor whose only forces during
 * flight are gravity + initial impulse: projectiles, ejected ground items,
 * thrown weapons, future grenades, etc.
 *
 * Distinct from `@voxim/engine`'s stepPhysics, which also handles movement
 * input, jump impulses, ground-contact drag, and air-control acceleration —
 * those belong to actors driven by a controller, not to inert ballistic
 * objects.  Two different policies, one shared math substrate per policy.
 *
 * Pure function: never touches the world; caller decides what to do with
 * the result (commit, destroy, settle, scan for collisions).
 */
import type { Vec3 } from "@voxim/content";

export interface BallisticBody {
  pos: Vec3;
  vel: Vec3;
}

/**
 * Advance a ballistic body by `dt` seconds under gravity.
 *
 * @param gravityScale  Multiplier on the world gravity constant (1.0 for
 *                      ordinary objects; arrows/throwing weapons may want
 *                      < 1.0 for a flatter arc).
 */
export function ballisticStep(
  body: BallisticBody,
  gravity: number,
  gravityScale: number,
  dt: number,
): BallisticBody {
  const newVel: Vec3 = {
    x: body.vel.x,
    y: body.vel.y,
    z: body.vel.z - gravity * gravityScale * dt,
  };
  const newPos: Vec3 = {
    x: body.pos.x + body.vel.x * dt,
    y: body.pos.y + body.vel.y * dt,
    z: body.pos.z + body.vel.z * dt,
  };
  return { pos: newPos, vel: newVel };
}
