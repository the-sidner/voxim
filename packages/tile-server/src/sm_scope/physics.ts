/**
 * `physics.*` scope variables — currently just the airborne marker.
 *
 * PhysicsSystem owns the `Airborne` component; presence ⟺ feet off ground
 * this tick.
 */

import type { SMScopeContributor } from "./types.ts";
import { Airborne } from "../components/combat.ts";

export const physicsContributor: SMScopeContributor = {
  namespace: "physics",
  variables: ["physics.airborne"],
  contribute({ world, entityId }, scope) {
    scope["physics.airborne"] = world.has(entityId, Airborne);
  },
};
