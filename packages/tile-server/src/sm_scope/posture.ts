/**
 * `posture.*` scope variables (T-226b).
 *
 * The posture CSM layer was retired — posture is now a slot action that
 * installs the `Crouched` tag. The locomotion layer is still CSM-resident
 * and still selects crouch clip variants via paramOverrides; this
 * contributor re-exposes the tag under the scope name those overrides read,
 * so the locomotion projection is byte-identical to the pre-migration CSM.
 *
 * `posture.crouched` carries the same one-tick lag the old
 * `csm.posture == crouched` read had: the tag is a deferred write committed
 * at end-of-tick, observed here on the next tick — exactly as the CSM's
 * deferred layerState write was observed a tick late before.
 *
 * Deleted when the locomotion layer itself migrates (T-226c): the crouch
 * variant becomes an animation-side rule keyed on the tag directly.
 */

import type { SMScopeContributor } from "./types.ts";
import { Crouched } from "../components/tags.ts";

export const postureContributor: SMScopeContributor = {
  namespace: "posture",
  variables: ["posture.crouched"],
  contribute({ world, entityId }, scope) {
    scope["posture.crouched"] = world.has(entityId, Crouched);
  },
};
