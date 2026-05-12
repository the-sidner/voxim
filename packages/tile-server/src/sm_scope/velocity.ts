/**
 * `vel.*` scope variables — magnitude + character-relative components.
 *
 * The directional decomposition (forward / strafe + absolute values) is
 * what lets the locomotion layer pick walk-forward vs walk-backward vs
 * strafe-left vs strafe-right deterministically without flickering on
 * diagonal input.
 */

import type { SMScopeContributor } from "./types.ts";
import { Velocity, Facing } from "../components/game.ts";

export const velocityContributor: SMScopeContributor = {
  namespace: "vel",
  variables: ["vel.mag", "vel.forward", "vel.strafe", "vel.forward_abs", "vel.strafe_abs"],
  contribute({ world, entityId }, scope) {
    const vel = world.get(entityId, Velocity);
    const vx = vel?.x ?? 0;
    const vy = vel?.y ?? 0;
    scope["vel.mag"] = Math.sqrt(vx * vx + vy * vy);

    const facingAngle = world.get(entityId, Facing)?.angle ?? 0;
    const fwdX = Math.cos(facingAngle);
    const fwdY = Math.sin(facingAngle);
    const velFwd = vx * fwdX + vy * fwdY;
    // strafe = vel · right. The intent_translator labels the CCW perpendicular
    // (-sin, cos) as "right" — D press at facing=0 produces vel=(0,1). Match
    // that convention so vel.strafe > 0 means moving in the D-key direction.
    const velStrafe = vy * fwdX - vx * fwdY;
    scope["vel.forward"]     = velFwd;
    scope["vel.strafe"]      = velStrafe;
    scope["vel.forward_abs"] = Math.abs(velFwd);
    scope["vel.strafe_abs"]  = Math.abs(velStrafe);
  },
};
