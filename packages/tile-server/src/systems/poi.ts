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

import type { World, EntityId } from "@voxim/engine";
import type { ContentService, PoiDef, PoiActivityWave } from "@voxim/content";
import type { System, EventEmitter } from "../system.ts";
import { Position } from "../components/game.ts";
import { PoiTrigger } from "../components/poi.ts";
import { WaveMember, WaveState } from "../components/wave.ts";
import { upsertResourceKey } from "../resources/mutate.ts";
import { Resource } from "../components/resource.ts";
import type { PoiActivityRegistry } from "../poi/mod.ts";
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
    private readonly activities: PoiActivityRegistry,
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
        this.dispatch(world, events, def, position, p.id, poiTrigger.poiInstanceId, triggerId);
        world.set(triggerId, PoiTrigger, { ...poiTrigger, fired: true });
        break;
      }
    }

    this.advanceWaves(world);
  }

  /**
   * wave-POI advancement (T-212 v2). Kept inside PoiSystem's tick per the
   * ticket's own doctrine ("no new System unless PoiSystem is already
   * bloated") — a bounded second pass, only doing work when a WaveState
   * entity exists. Counts living `WaveMember`s per `poiInstanceId`; when a
   * dispatched wave's members have all died and more waves remain, seeds
   * the `wave_timer` Resource so `spawn_next_wave` fires the next wave
   * after `interWaveSeconds`. No hand-rolled countdown.
   */
  private advanceWaves(world: World): void {
    const states = world.query(WaveState);
    if (states.length === 0) return;

    const memberCounts = new Map<string, number>();
    for (const { waveMember } of world.query(WaveMember)) {
      memberCounts.set(waveMember.poiInstanceId, (memberCounts.get(waveMember.poiInstanceId) ?? 0) + 1);
    }

    for (const { entityId: triggerId, waveState } of states) {
      if (waveState.waveIndex >= waveState.totalWaves) continue; // all waves dispatched
      if ((memberCounts.get(waveState.poiInstanceId) ?? 0) > 0) continue; // current wave still alive
      if (world.get(triggerId, Resource)?.values.wave_timer) continue; // timer already running

      const trigger = world.get(triggerId, PoiTrigger);
      const def = trigger ? this.content.pois.get(trigger.poiDefId) : null;
      if (!def || def.type !== "wave") continue;
      const interWaveTicks = (def.activity as PoiActivityWave).interWaveSeconds * 20;
      upsertResourceKey(world, triggerId, "wave_timer", interWaveTicks, interWaveTicks);
      log.info("POI %s: wave cleared, next wave in %ds", waveState.poiInstanceId, interWaveTicks / 20);
    }
  }

  private dispatch(
    world: World,
    events: EventEmitter,
    def: PoiDef,
    pos: { x: number; y: number; z: number },
    playerId: string,
    poiInstanceId: string,
    triggerId: EntityId,
  ): void {
    log.info("POI %s (%s/%s) activated by player %s", poiInstanceId, def.id, def.type, playerId.slice(-6));

    // Registry dispatch over the content-defined `def.type` — every type is
    // a registered PoiActivityHandler (server.ts cross-checks at boot, so
    // get() never throws here). Replaces the per-type switch (T-245).
    this.activities.get(def.type).activate({
      world, events, content: this.content, def, pos, playerId, poiInstanceId, triggerId,
    });
  }
}
