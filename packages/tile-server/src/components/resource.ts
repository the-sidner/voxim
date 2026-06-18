/**
 * Resource component (T-238) — every tick-scalar an entity carries.
 *
 * One component holds all of an entity's resources (`values[id] =
 * { value, max }`), matching `ActiveActions`' multi-slot shape so the
 * query + delta stay cheap. `ResourceSystem` is the only writer:
 * integrates each `ResourceDef.rate`, clamps to `[def.bounds.min, max]`
 * (max is per-entity — seeded at spawn, e.g. heritage-scaled stamina),
 * and dispatches threshold effects.
 *
 * Networked (T-262): the client HUD reads the local player's
 * stamina/hunger/thirst/poise from here. The per-tick delta churn is bounded
 * — `ResourceSystem` only emits a change when the integrated value actually
 * moves and isn't bound-clamped, so a rested actor (stamina/poise at max)
 * ships nothing; only hunger/thirst drift and active spend/regen do. (A future
 * optimisation could quantise the sub-unit hunger/thirst drift.)
 * Installed at spawn (stamina/hunger/thirst/poise on actors) and by
 * start_buff (buff_timer) / workstations (crafting_timer).
 */

import { defineComponent } from "@voxim/engine";
import { ComponentType } from "@voxim/protocol";
import { resourceCodec } from "@voxim/codecs";
import type { ResourceData, ResourceValue } from "@voxim/codecs";

export type { ResourceData, ResourceValue };

export const Resource = defineComponent({
  name: "resource" as const,
  wireId: ComponentType.resource,
  codec: resourceCodec,
  default: (): ResourceData => ({ values: {} }),
});
