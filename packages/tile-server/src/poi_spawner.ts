/**
 * POI runtime spawn helpers (T-212).
 *
 * Two responsibilities:
 *
 *   1. `placePoiTriggers(world, narrative, zones, content, tileSize)` —
 *      called once at tile boot. For every narrative POI, creates a bare
 *      entity at the zone's centroid with `Position` + `PoiTrigger`.
 *      The PoiSystem picks these up tickwise.
 *
 *   2. `resolveSpawnTable(spawnTableId)` — stub mapping from POI activity
 *      `spawnTable` ids to existing NPC template ids. The 17 authored
 *      POIs reference fictional spawn-table names ("wolf_pack_medium",
 *      "blightspawn_medium", …); a real `data/spawn_tables/` content
 *      category is future work. For v1 the mapping lives here as a
 *      bridge to whatever NPC templates actually ship.
 */

import { newEntityId, type World } from "@voxim/engine";
import type { ContentService } from "@voxim/content";
import { Position } from "./components/game.ts";
import { PoiTrigger } from "./components/poi.ts";
import { createLogger } from "./logger.ts";

const log = createLogger("PoiSpawner");

export interface NarrativePoiInstance {
  id: string;
  poiDefId: string;
  zoneId: number;
  gate: { kind: string; trinketRefs: string[] };
  trinketId: string | null;
  stairId: string | null;
}

export interface PoiZoneCentroid {
  id: number;
  centroid: { x: number; y: number };
  traversal: "path" | "wilderness";
}

/**
 * Default trigger radius in world units when the POI def doesn't
 * declare one (most don't). 6u is roughly two body-widths — close
 * enough that the player has to deliberately approach.
 */
const DEFAULT_TRIGGER_RADIUS = 6;

/**
 * Place trigger markers at every narrative POI's zone centroid. Zones
 * with no matching centroid (sub-threshold or missing — shouldn't happen
 * in practice) get a warn and are skipped.
 *
 * Zone centroids from atlas are in **atlas grid coords** (gridSize²);
 * we scale to tile-server's **world-unit space** (TILE_SIZE²) using the
 * supplied ratio.
 */
export function placePoiTriggers(
  world: World,
  pois: NarrativePoiInstance[],
  zones: PoiZoneCentroid[],
  _content: ContentService,
  tileSize: number,
  atlasGridSize: number,
): number {
  const scale = tileSize / atlasGridSize;
  const zoneById = new Map<number, PoiZoneCentroid>();
  for (const z of zones) zoneById.set(z.id, z);

  let placed = 0;
  for (const poi of pois) {
    const z = zoneById.get(poi.zoneId);
    if (!z) {
      log.warn("POI %s references missing zone %d — skipped", poi.id, poi.zoneId);
      continue;
    }
    const wx = z.centroid.x * scale;
    const wy = z.centroid.y * scale;
    const id = newEntityId();
    world.create(id);
    world.write(id, Position, { x: wx, y: wy, z: 0 });
    world.write(id, PoiTrigger, {
      poiInstanceId: poi.id,
      poiDefId:      poi.poiDefId,
      triggerRadius: DEFAULT_TRIGGER_RADIUS,
      fired:         false,
    });
    placed++;
  }
  log.info("placed %d POI triggers", placed);
  return placed;
}

/**
 * STUB mapping from POI `activity.spawnTable` strings to existing NPC
 * templates. The authored POIs reference fictional table names; until
 * `packages/content/data/spawn_tables/` exists as a content category,
 * this is the bridge. Replace with content lookup once authored.
 *
 * Unknown spawn tables fall back to spawning one generic wolf so the
 * encounter is visible rather than silent.
 */
export interface SpawnTableEntry {
  npcId: string;
  count: number;
}

export function resolveSpawnTable(spawnTable: string): SpawnTableEntry[] {
  return SPAWN_TABLE_STUB[spawnTable] ?? [{ npcId: "wolf", count: 1 }];
}

const SPAWN_TABLE_STUB: Record<string, SpawnTableEntry[]> = {
  // encounter tables (authored POI references)
  wolf_pack_medium:    [{ npcId: "wolf",   count: 3 }],
  bandit_pack_medium:  [{ npcId: "bandit", count: 3 }],
  drowner_swarm_small: [{ npcId: "drowner", count: 2 }],
  blightspawn_medium:  [{ npcId: "drowner", count: 2 }, { npcId: "wolf", count: 1 }],
  // wave POI sub-spawns mapped to closest existing NPC. v2 of T-212
  // (wave state-machine) will iterate these in sequence.
  spectral_pikeman:    [{ npcId: "bandit", count: 1 }],
  spectral_archer:     [{ npcId: "archer", count: 1 }],
  spectral_captain:    [{ npcId: "rotten_knight", count: 1 }],
  hexed_miner:         [{ npcId: "bandit", count: 1 }],
  frost_wolf:          [{ npcId: "wolf",   count: 1 }],
  frost_wolf_alpha:    [{ npcId: "wolf",   count: 1 }],
  // bossfight bossNpcIds (single mapped enemy each — full arena rules
  // are T-212 v2).
  stone_construct:     [{ npcId: "rotten_knight", count: 1 }],
  elder_treant:        [{ npcId: "rotten_knight", count: 1 }],
  abyssal_serpent:     [{ npcId: "drowner", count: 1 }],
  // adds-tables (boss adds)
  construct_motes:     [{ npcId: "bandit", count: 1 }],
  rotwood_spores:      [{ npcId: "wolf",   count: 1 }],
  deep_tide_motes:     [{ npcId: "drowner", count: 1 }],
};
