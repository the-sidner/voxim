/**
 * Unimplemented POI activities (T-245) — bossfight / wave / action / puzzle
 * are authored in content but not yet built. Registered as explicit no-op
 * adapters so every `PoiDef.type` has a home and the boot cross-check
 * passes (rather than silently falling through a switch). Each graduates to
 * its own file under `activities/` when implemented — one handler file +
 * one register() call, no engine edit. Behaviour is identical to the old
 * switch's stub branch: log and do nothing.
 */

import type { PoiActivityHandler } from "../activity.ts";
import { createLogger } from "../../logger.ts";

export function makeUnimplementedActivity(type: string): PoiActivityHandler {
  const log = createLogger(`poi:${type}`);
  return {
    id: type,
    activate({ poiInstanceId }) {
      log.info("stub: %s not yet implemented (POI %s)", type, poiInstanceId);
    },
  };
}
