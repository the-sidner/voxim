/**
 * spawn_next_wave resource effect (T-212 v2) — `wave_timer`'s `cross@0`
 * threshold on a wave POI's trigger entity. Dispatches the next
 * `PoiActivityWave.waves[]` entry and advances `WaveState.waveIndex`.
 *
 * `ctx.entityId` here is the `PoiTrigger` entity itself (wave_timer is
 * seeded on it by `PoiSystem`'s wave-advance pass, not on the spawned
 * NPCs) — re-fetch the POI def via `PoiTrigger.poiDefId`, same lookup
 * `PoiSystem.dispatch` already does.
 */

import type { PoiActivityWave } from "@voxim/content";
import type { ResourceEffect } from "../effect.ts";
import { PoiTrigger } from "../../components/poi.ts";
import { WaveState } from "../../components/wave.ts";
import { Position } from "../../components/game.ts";
import { spawnWave } from "../../poi/activities/wave.ts";
import { createLogger } from "../../logger.ts";

const log = createLogger("poi:wave");

export const spawnNextWaveEffect: ResourceEffect = {
  id: "spawn_next_wave",
  resolve(ctx) {
    const trigger = ctx.world.get(ctx.entityId, PoiTrigger);
    const state = ctx.world.get(ctx.entityId, WaveState);
    const pos = ctx.world.get(ctx.entityId, Position);
    if (!trigger || !state || !pos) return;

    const def = ctx.content.pois.get(trigger.poiDefId);
    if (!def || def.type !== "wave") return;
    const activity = def.activity as PoiActivityWave;

    if (state.waveIndex >= activity.waves.length) return; // all waves dispatched already

    const spawned = spawnWave(ctx.world, ctx.content, pos, state.poiInstanceId, activity.waves[state.waveIndex]);
    log.info(
      "POI %s: wave %d/%d dispatched, %d members spawned",
      state.poiInstanceId, state.waveIndex, activity.waves.length, spawned,
    );
    ctx.world.set(ctx.entityId, WaveState, { ...state, waveIndex: state.waveIndex + 1 });
  },
};
