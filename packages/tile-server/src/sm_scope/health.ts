/**
 * `health.*` scope variables — current/max plus fraction for clean threshold
 * comparisons in transition DSL (e.g. `health.frac < 0.25`).
 */

import type { SMScopeContributor } from "./types.ts";
import { Health } from "../components/game.ts";

export const healthContributor: SMScopeContributor = {
  namespace: "health",
  variables: ["health.current", "health.max", "health.frac"],
  contribute({ world, entityId }, scope) {
    const health = world.get(entityId, Health);
    scope["health.current"] = health?.current ?? 0;
    scope["health.max"]     = health?.max ?? 0;
    scope["health.frac"]    = health && health.max > 0 ? health.current / health.max : 0;
  },
};
