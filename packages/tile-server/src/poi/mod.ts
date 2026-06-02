/**
 * POI activity module (T-245) — registry + built-in activity handlers.
 *
 * To add a new POI activity type: implement `PoiActivityHandler` in a file
 * under `activities/`, and register it below. Mirrors `ai/bt/mod.ts` and
 * the action effect/gate registries. `server.ts` cross-checks every
 * `PoiDef.type` against this registry at boot — fail fast on an unknown
 * type rather than silently no-op at runtime.
 */

import { Registry } from "@voxim/engine";
import type { PoiActivityHandler, PoiActivityRegistry } from "./activity.ts";
import { encounterActivity } from "./activities/encounter.ts";
import { explorationActivity } from "./activities/exploration.ts";
import { makeUnimplementedActivity } from "./activities/unimplemented.ts";

export type { PoiActivityHandler, PoiActivityContext, PoiActivityRegistry } from "./activity.ts";

/** Authored in content but not yet built — registered as no-op adapters so
 * every PoiDef.type resolves (T-212 v2 fills these in). */
const UNIMPLEMENTED = ["bossfight", "wave", "action", "puzzle"] as const;

export function newPoiActivityRegistry(): PoiActivityRegistry {
  const r = new Registry<PoiActivityHandler>();
  r.register(encounterActivity);
  r.register(explorationActivity);
  for (const t of UNIMPLEMENTED) r.register(makeUnimplementedActivity(t));
  return r;
}
