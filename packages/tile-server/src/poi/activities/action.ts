/**
 * action POI activity (T-212 v2) — single interaction prompt (chalice
 * pedestal, signal brazier, …).
 *
 * On activation: spawn `activity.interactionPrefab` at the centroid,
 * tagged `PoiInteractable{poiInstanceId, verb, consumable}`. The USE half
 * (player clicks it) is a separate command-driven leg — `PoiSystem`
 * handles `CommandType.UseEntity` in its own tick (see `systems/poi.ts`),
 * not here; `activate()` only ever fires once per POI (proximity trigger),
 * while a use can happen any tick after.
 */

import type { PoiActivityAction } from "@voxim/content";
import type { PoiActivityHandler } from "../activity.ts";
import { spawnPrefab } from "../../spawner.ts";
import { PoiInteractable } from "../../components/poi.ts";
import { createLogger } from "../../logger.ts";

const log = createLogger("poi:action");

export const actionActivity: PoiActivityHandler = {
  id: "action",
  activate({ world, content, def, pos, poiInstanceId }) {
    const activity = def.activity as PoiActivityAction;
    try {
      const id = spawnPrefab(world, content, activity.interactionPrefab, { x: pos.x, y: pos.y, z: pos.z });
      world.write(id, PoiInteractable, {
        poiInstanceId, verb: activity.verb, consumable: activity.consumable,
      });
      log.info(
        "POI %s: interactable '%s' (verb=%s consumable=%s) spawned",
        poiInstanceId, activity.interactionPrefab, activity.verb, activity.consumable,
      );
    } catch (err) {
      log.warn("interactionPrefab spawn '%s' failed: %s", activity.interactionPrefab, (err as Error).message);
    }
  },
};
