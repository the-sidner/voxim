/**
 * `action.*` scope variables — equipped weapon's current action timing.
 *
 * Only emitted while a SwingContext payload is alive. The CSM's swing.*
 * state durations reference these via the `"$action.windup_seconds"` style
 * duration syntax so per-weapon timing comes from the WeaponActionDef
 * rather than being hardcoded in JSON.
 *
 * Defaults to 0 when no swing is in progress so transitions referencing
 * these vars don't throw mid-idle.
 */

import type { SMScopeContributor } from "./types.ts";
import { SwingContext } from "../components/swing_context.ts";

const SECONDS_PER_TICK = 1 / 20;

export const actionContributor: SMScopeContributor = {
  namespace: "action",
  variables: ["action.windup_seconds", "action.active_seconds", "action.winddown_seconds"],
  contribute({ world, entityId, content }, scope) {
    const swing = world.get(entityId, SwingContext);
    let windup = 0, active = 0, winddown = 0;
    if (swing) {
      const action = content.weaponActions.get(swing.weaponActionId);
      if (action) {
        windup   = action.windupTicks   * SECONDS_PER_TICK;
        active   = action.activeTicks   * SECONDS_PER_TICK;
        winddown = action.winddownTicks * SECONDS_PER_TICK;
      }
    }
    scope["action.windup_seconds"]   = windup;
    scope["action.active_seconds"]   = active;
    scope["action.winddown_seconds"] = winddown;
  },
};
