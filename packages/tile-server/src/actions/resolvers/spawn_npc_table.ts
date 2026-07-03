/**
 * spawn_npc_table effect resolver (T-212 v2) — spawns NPCs from a resolved
 * spawn table around `ctx.entityId`'s current Position. Used by bossfight's
 * phase-adds triggers (`params.table` names an `addsTable`, e.g.
 * `construct_motes`) — mirrors `poi/activities/encounter.ts`'s spawn-ring
 * placement, generalised to fire from any effect edge (trigger or action).
 */

import type { EffectResolver } from "../effect.ts";
import { Position } from "../../components/game.ts";
import { resolveSpawnTable } from "../../poi_spawner.ts";
import { spawnPrefab } from "../../spawner.ts";
import { createLogger } from "../../logger.ts";

const log = createLogger("spawn_npc_table");

export const spawnNpcTableResolver: EffectResolver = {
  id: "spawn_npc_table",
  resolve(ctx) {
    const table = ctx.params.table;
    if (typeof table !== "string") return;
    const pos = ctx.world.get(ctx.entityId, Position);
    if (!pos) return;

    const entries = resolveSpawnTable(table);
    let spawned = 0;
    for (const e of entries) {
      for (let i = 0; i < e.count; i++) {
        const angle = (spawned / Math.max(1, e.count)) * Math.PI * 2;
        const r = 2 + spawned * 0.4;
        try {
          spawnPrefab(ctx.world, ctx.content, e.npcId, {
            x: pos.x + Math.cos(angle) * r,
            y: pos.y + Math.sin(angle) * r,
            z: pos.z,
          });
          spawned++;
        } catch (err) {
          log.warn("spawn '%s' failed: %s", e.npcId, (err as Error).message);
        }
      }
    }
    log.info("table=%s spawned=%d near entity=%s", table, spawned, ctx.entityId);
  },
};
