/**
 * wave POI activity (T-212 v2) — survive N sequential waves.
 *
 * On activation: dispatch wave 0 immediately (its entries always carry
 * `interval: 0` by authoring convention), tag every spawned NPC
 * `WaveMember{poiInstanceId}`, and stamp `WaveState` on the trigger entity.
 * `PoiSystem`'s per-tick wave pass (not a new System — see its header) then
 * owns advancement: once a dispatched wave's members have all died, it
 * seeds a `wave_timer` Resource for `interWaveSeconds`; the timer's
 * `cross@0` threshold fires `spawn_next_wave` (a ResourceEffect) which
 * dispatches the next wave and re-tags its members. No hand-rolled
 * countdown — the inter-wave delay is the Resource primitive.
 */

import type { PoiActivityWave } from "@voxim/content";
import type { PoiActivityHandler } from "../activity.ts";
import { spawnPrefab } from "../../spawner.ts";
import { resolveSpawnTable } from "../../poi_spawner.ts";
import { WaveMember, WaveState } from "../../components/wave.ts";
import { createLogger } from "../../logger.ts";

const log = createLogger("poi:wave");

/** Spawns one wave's entries in a ring around the centroid, tagging each
 * spawned NPC `WaveMember{poiInstanceId}`. Shared by activation (wave 0)
 * and `spawn_next_wave` (waves 1..N). */
export function spawnWave(
  world: Parameters<typeof spawnPrefab>[0],
  content: Parameters<typeof spawnPrefab>[1],
  pos: { x: number; y: number; z: number },
  poiInstanceId: string,
  wave: PoiActivityWave["waves"][number],
): number {
  // resolveSpawnTable resolves the wave entry's `spawn` id to ONE NPC
  // template (the stub tables map every wave sub-spawn id 1:1, e.g.
  // spectral_pikeman -> bandit); wave.count is how many of THAT template
  // this wave entry wants, same convention as encounter's spawnTable.
  const entries = resolveSpawnTable(wave.spawn);
  let spawned = 0;
  for (const e of entries) {
    const total = e.count * wave.count;
    for (let i = 0; i < total; i++) {
      const angle = (spawned / Math.max(1, wave.count)) * Math.PI * 2;
      const r = 1.5 + spawned * 0.3;
      try {
        const id = spawnPrefab(world, content, e.npcId, {
          x: pos.x + Math.cos(angle) * r,
          y: pos.y + Math.sin(angle) * r,
          z: pos.z,
        });
        world.write(id, WaveMember, { poiInstanceId });
        spawned++;
      } catch (err) {
        log.warn("spawn '%s' failed: %s", e.npcId, (err as Error).message);
      }
    }
  }
  return spawned;
}

export const waveActivity: PoiActivityHandler = {
  id: "wave",
  activate({ world, content, def, pos, poiInstanceId, triggerId }) {
    const activity = def.activity as PoiActivityWave;
    const spawned = spawnWave(world, content, pos, poiInstanceId, activity.waves[0]);
    world.write(triggerId, WaveState, {
      poiInstanceId,
      waveIndex: 1,
      totalWaves: activity.waves.length,
    });
    log.info(
      "POI %s: wave 0/%d dispatched, %d members spawned",
      poiInstanceId, activity.waves.length, spawned,
    );
  },
};
