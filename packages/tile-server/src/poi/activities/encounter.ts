/**
 * encounter POI activity (T-245) — spawn NPCs from the resolved spawn
 * table around the POI centroid. Lifted verbatim from PoiSystem's
 * `case "encounter"`; only its home moved.
 */

import type { PoiActivityEncounter } from "@voxim/content";
import type { PoiActivityHandler } from "../activity.ts";
import { spawnPrefab } from "../../spawner.ts";
import { resolveSpawnTable } from "../../poi_spawner.ts";
import { createLogger } from "../../logger.ts";

const log = createLogger("poi:encounter");

export const encounterActivity: PoiActivityHandler = {
  id: "encounter",
  activate({ world, content, def, pos }) {
    const activity = def.activity as PoiActivityEncounter;
    const entries = resolveSpawnTable(activity.spawnTable);
    for (const e of entries) {
      for (let i = 0; i < e.count; i++) {
        // Spread spawns in a small ring around the centroid so they
        // don't pile into one pixel.
        const angle = (i / e.count) * Math.PI * 2;
        const r = 1.5 + i * 0.3;
        try {
          spawnPrefab(world, content, e.npcId, {
            x: pos.x + Math.cos(angle) * r,
            y: pos.y + Math.sin(angle) * r,
            z: pos.z,
          });
        } catch (err) {
          log.warn("spawn '%s' failed: %s", e.npcId, (err as Error).message);
        }
      }
    }
  },
};
