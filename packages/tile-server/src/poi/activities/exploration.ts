/**
 * exploration POI activity (T-245) — emit `LoreInternalised` to the
 * triggering player carrying the POI's lore fragment. Lifted verbatim from
 * PoiSystem's `case "exploration"`.
 */

import { TileEvents } from "@voxim/protocol";
import type { PoiActivityExploration } from "@voxim/content";
import type { PoiActivityHandler } from "../activity.ts";

export const explorationActivity: PoiActivityHandler = {
  id: "exploration",
  activate({ events, def, playerId }) {
    const activity = def.activity as PoiActivityExploration;
    events.publish(TileEvents.LoreInternalised, {
      entityId: playerId,
      fragmentId: activity.loreId,
    });
  },
};
