/**
 * bossfight POI activity (T-212 v2) — single high-stakes boss encounter.
 *
 * On activation: spawn `activity.bossNpcId` at the centroid (resolved
 * through the same `resolveSpawnTable` stub bridge `wave`/`encounter` use
 * — the authored POIs reference fictional boss ids like `stone_construct`
 * that map to real NPC templates), tag it `BossArenaLink{poiInstanceId}`.
 *
 * Phase-triggered adds (`arenaRules.phaseTriggers` × `addsTable`) are
 * content triggers (`data/triggers/boss_phase_add_*.json`, `on:
 * damage_taken`, `as: target`, gated by the existing `health_below` gate)
 * granted to the boss by a live-presence `TriggerSource` reading
 * `BossArenaLink` — see `triggers/boss_arena_source.ts`. That path is a
 * live entity taking damage, so the TriggerSystem's next-tick buffered
 * drain sees it alive; no ordering hazard there (only the DEATH unlock has
 * one — see `deathhooks/boss_arena_unlock.ts`).
 *
 * `arenaRules.lockEntry` is read but NOT enforced (v1 scope cut, see
 * TICKETS.md T-212): no entity-vs-entity collision substrate exists in
 * `PhysicsSystem` to make a spawned blocker prop actually block movement,
 * and building one is disproportionate to one activity's transient need.
 * The fight is fully playable end-to-end; the arena is just skippable-past.
 */

import type { PoiActivityBossfight } from "@voxim/content";
import type { PoiActivityHandler } from "../activity.ts";
import { spawnPrefab } from "../../spawner.ts";
import { resolveSpawnTable } from "../../poi_spawner.ts";
import { BossArenaLink } from "../../components/boss_arena.ts";
import { createLogger } from "../../logger.ts";

const log = createLogger("poi:bossfight");

export const bossfightActivity: PoiActivityHandler = {
  id: "bossfight",
  activate({ world, content, def, pos, poiInstanceId }) {
    const activity = def.activity as PoiActivityBossfight;
    const entries = resolveSpawnTable(activity.bossNpcId);
    if (entries.length === 0) {
      log.warn("POI %s: bossNpcId '%s' resolved to no spawn entries", poiInstanceId, activity.bossNpcId);
      return;
    }
    // Bosses are single-entry spawn tables (SPAWN_TABLE_STUB maps each
    // bossNpcId 1:1) — spawn the first entry's template once.
    const { npcId } = entries[0];
    try {
      const id = spawnPrefab(world, content, npcId, { x: pos.x, y: pos.y, z: pos.z });
      world.write(id, BossArenaLink, { poiInstanceId, poiDefId: def.id });
      log.info(
        "POI %s: boss '%s' (npc=%s) spawned, lockEntry=%s (data-only, unenforced — see TICKETS.md)",
        poiInstanceId, activity.bossNpcId, npcId, activity.arenaRules.lockEntry,
      );
    } catch (err) {
      log.warn("boss spawn '%s' failed: %s", npcId, (err as Error).message);
    }
  },
};
