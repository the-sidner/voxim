/**
 * LocomotionIntentResolver (T-226c) — a faithful port of the retired CSM
 * locomotion layer's 13 transitions into the action-slot model.
 *
 * The CSM layer was a from-state-aware, priority-ordered FSM. This resolver
 * reproduces it exactly by reading the *current* locomotion slot action
 * (for hysteresis and the from-state allow-lists) plus the same scope the
 * CSM saw (velocity decomposition, input bits, the Airborne marker).
 *
 * Priority order (highest first), matching the CSM transition priorities
 * (sidestep 10 > jump 8 > airborne 5 > velocity 0) and the
 * duration-exits-to-idle (jump/landing/sidestep complete → the slot empties
 * → a steady state is re-picked here):
 *
 *   1. steady + input.dodge + settled    → sidestep   (CSM pri 10; the
 *      `state.elapsed > 0.05` guard ≈ ticksInPhase > 1)
 *   2. steady + input.jump + !airborne   → jump       (CSM pri 8)
 *   3. steady + airborne                 → airborne   (CSM pri 5)
 *   4. cur jump + airborne               → airborne   (CSM jump→airborne)
 *   5. cur airborne + !airborne          → landing    (CSM airborne→landing)
 *   6. steady                            → velocity pick (CSM walk/strafe/
 *      idle transitions, evaluated in JSON order, from-state-aware)
 *   7. otherwise (jump/landing/sidestep mid-action) → null (let it run; on
 *      completion the slot empties and rule 6 re-picks — CSM's
 *      duration-exit-to-idle)
 *
 * "steady" = no current locomotion action (slot just emptied) or the
 * current one is a steady ground state (idle, walk, strafe). Gameplay
 * (jump impulse, dodge i-frames/velocity-lock, airborne detection) is
 * unaffected — it always lived in PhysicsSystem / DodgeSystem reading
 * input + components directly, never `csm.locomotion`. This resolver
 * drives animation only.
 */

import type { World, EntityId } from "@voxim/engine";
import { ACTION_JUMP, ACTION_DODGE, hasAction } from "@voxim/protocol";
import { InputState, Velocity, Facing } from "../components/game.ts";
import { Airborne } from "../components/combat.ts";
import { ActiveActions } from "../components/action.ts";
import type { IntentResolver } from "./dispatcher.ts";

const STEADY = new Set(["idle", "walk_forward", "walk_backward", "strafe_left", "strafe_right"]);

interface VelScope {
  mag: number;
  forward: number;
  strafe: number;
  forwardAbs: number;
  strafeAbs: number;
}

/** Mirrors velocityContributor's decomposition exactly (same right-hand convention). */
function velScope(world: World, id: EntityId): VelScope {
  const v = world.get(id, Velocity);
  const vx = v?.x ?? 0;
  const vy = v?.y ?? 0;
  const ang = world.get(id, Facing)?.angle ?? 0;
  const fwdX = Math.cos(ang);
  const fwdY = Math.sin(ang);
  const forward = vx * fwdX + vy * fwdY;
  const strafe = vy * fwdX - vx * fwdY;
  return {
    mag: Math.sqrt(vx * vx + vy * vy),
    forward,
    strafe,
    forwardAbs: Math.abs(forward),
    strafeAbs: Math.abs(strafe),
  };
}

/**
 * The CSM velocity transitions, evaluated in JSON order (walk_forward,
 * walk_backward, strafe_right, strafe_left, →idle), each from-state-aware.
 * First match wins; no match → stay (`cur`).
 */
function velocityPick(cur: string, s: VelScope): string {
  if (
    cur !== "walk_forward" &&
    s.forward > 0.5 && s.forwardAbs >= s.strafeAbs
  ) return "walk_forward";
  if (
    cur !== "walk_backward" &&
    s.forward < -0.5 && s.forwardAbs >= s.strafeAbs
  ) return "walk_backward";
  if (
    cur !== "strafe_right" &&
    s.strafe > 0.5 && s.strafeAbs > s.forwardAbs
  ) return "strafe_right";
  if (
    cur !== "strafe_left" &&
    s.strafe < -0.5 && s.strafeAbs > s.forwardAbs
  ) return "strafe_left";
  if (cur !== "idle" && s.mag < 0.2) return "idle";
  return cur === "" ? "idle" : cur;
}

export const LocomotionIntentResolver: IntentResolver = {
  resolve(world: World, entityId: EntityId, slots: readonly string[]): Map<string, string | null> {
    const out = new Map<string, string | null>();
    if (!slots.includes("locomotion")) return out;

    const slot = world.get(entityId, ActiveActions)?.states["locomotion"];
    const cur = slot?.actionId ?? "";
    const ticks = slot?.ticksInPhase ?? 0;
    const steady = cur === "" || STEADY.has(cur);

    const a = world.get(entityId, InputState)?.actions ?? 0;
    const jumpHeld = hasAction(a, ACTION_JUMP);
    const dodgeHeld = hasAction(a, ACTION_DODGE);
    const airborne = world.has(entityId, Airborne);

    let want: string | null;
    if (steady && dodgeHeld && ticks > 1) {
      want = "sidestep";
    } else if (steady && jumpHeld && !airborne) {
      want = "jump";
    } else if (steady && airborne) {
      want = "airborne";
    } else if (cur === "jump" && airborne) {
      want = "airborne";
    } else if (cur === "airborne" && !airborne) {
      want = "landing";
    } else if (steady) {
      want = velocityPick(cur, velScope(world, entityId));
    } else {
      // jump / landing / sidestep mid-action: leave it alone. It completes
      // on its phase duration → slot empties → next tick `steady` re-picks
      // (the CSM's elapsed-based exit to idle).
      want = null;
    }
    out.set("locomotion", want);
    return out;
  },
};
