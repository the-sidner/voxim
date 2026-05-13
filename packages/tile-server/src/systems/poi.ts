/**
 * POI runtime system (T-212).
 *
 * Walks every `PoiTrigger` entity each tick, checks whether any player
 * is within `triggerRadius`, and on the first crossing dispatches the
 * POI's activity by type:
 *
 *   encounter   → spawn NPCs from the resolved spawn table at the
 *                 POI's centroid via `spawnPrefab`.
 *   exploration → emit a `LoreInternalised` event to the triggering
 *                 player carrying the POI's `loreId`.
 *   bossfight/wave/action/puzzle → log + emit a generic "PoiActivated"
 *                 log line for now. Full implementations land in
 *                 T-212 v2 (per-type adapter modules).
 *
 * After firing, `PoiTrigger.fired` flips true. Encounters with
 * `regenAfterTicks: N` would reset it after N ticks elapsed; for v1
 * encounters stay fired until tile reset.
 *
 * Scope note: the spawn-table mapping is the stub from `poi_spawner.ts`
 * (no `data/spawn_tables/` content category yet). All player checks
 * use Position + InputState's `seq > 0` proxy to identify "actual
 * players" vs. NPCs (NPCs don't have InputState seq advancement).
 */

import type { World } from "@voxim/engine";
import { TileEvents } from "@voxim/protocol";
import type { ContentService, PoiDef } from "@voxim/content";
import type { System, EventEmitter } from "../system.ts";
import { Position } from "../components/game.ts";
import { PoiTrigger } from "../components/poi.ts";
import { spawnPrefab } from "../spawner.ts";
import { resolveSpawnTable } from "../poi_spawner.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("PoiSystem");

/**
 * Players are entities with the `Player` marker (in practice, any
 * entity in `tile.sessions`). For the system we use a callback so the
 * tile-server can hand us its session set without coupling the system
 * to session internals.
 */
export type ListPlayersFn = () => IterableIterator<string>;

export class PoiSystem implements System {
  constructor(
    private readonly content: ContentService,
    private readonly listPlayers: ListPlayersFn,
  ) {}

  run(world: World, events: EventEmitter, _dt: number): void {
    const triggers = world.query(PoiTrigger, Position);
    if (triggers.length === 0) return;

    // Cache player positions once per tick.
    const players: Array<{ id: string; x: number; y: number }> = [];
    for (const pid of this.listPlayers()) {
      const pos = world.get(pid, Position);
      if (!pos) continue;
      players.push({ id: pid, x: pos.x, y: pos.y });
    }
    if (players.length === 0) return;

    for (const { entityId: triggerId, poiTrigger, position } of triggers) {
      if (poiTrigger.fired) continue;
      const r2 = poiTrigger.triggerRadius * poiTrigger.triggerRadius;
      for (const p of players) {
        const dx = p.x - position.x;
        const dy = p.y - position.y;
        if (dx * dx + dy * dy > r2) continue;
        // First crossing — fire.
        const def = this.content.pois.get(poiTrigger.poiDefId);
        if (!def) {
          log.warn("POI %s references unknown def %s", poiTrigger.poiInstanceId, poiTrigger.poiDefId);
          break;
        }
        this.dispatch(world, events, def, position, p.id, poiTrigger.poiInstanceId);
        world.set(triggerId, PoiTrigger, { ...poiTrigger, fired: true });
        break;
      }
    }
  }

  private dispatch(
    world: World,
    events: EventEmitter,
    def: PoiDef,
    pos: { x: number; y: number; z: number },
    playerId: string,
    poiInstanceId: string,
  ): void {
    log.info("POI %s (%s/%s) activated by player %s", poiInstanceId, def.id, def.type, playerId.slice(-6));

    switch (def.type) {
      case "encounter": {
        const entries = resolveSpawnTable(def.activity.spawnTable);
        for (const e of entries) {
          for (let i = 0; i < e.count; i++) {
            // Spread spawns in a small ring around the centroid so they
            // don't pile into one pixel.
            const angle = (i / e.count) * Math.PI * 2;
            const r = 1.5 + i * 0.3;
            try {
              spawnPrefab(world, this.content, e.npcId, {
                x: pos.x + Math.cos(angle) * r,
                y: pos.y + Math.sin(angle) * r,
                z: pos.z,
              });
            } catch (err) {
              log.warn("spawn '%s' failed: %s", e.npcId, (err as Error).message);
            }
          }
        }
        break;
      }
      case "exploration": {
        events.publish(TileEvents.LoreInternalised, {
          entityId: playerId,
          fragmentId: def.activity.loreId,
        });
        break;
      }
      case "bossfight":
      case "wave":
      case "action":
      case "puzzle":
        // Stub for T-212 v2 — full per-type adapters land later.
        log.info("  stub: %s not yet implemented", def.type);
        break;
    }
  }
}
