/**
 * wave POI activity tests (T-212 v2).
 *
 * Uses real content (`forgotten_garrison`, type "wave") — no bake
 * dependency, mirrors `poi_system.test.ts`'s harness. Verifies:
 *   - activation dispatches wave 0 and tags spawned NPCs WaveMember.
 *   - PoiSystem's per-tick wave-advance pass seeds wave_timer once wave 0's
 *     members are all dead.
 *   - the wave_timer Resource's cross@0 threshold fires spawn_next_wave,
 *     which dispatches wave 1 and advances WaveState.
 */

import { assert, assertEquals } from "jsr:@std/assert";
import { World, EventBus, newEntityId } from "@voxim/engine";
import { JsonSource } from "@voxim/content";
import { Position } from "../../components/game.ts";
import { PoiTrigger } from "../../components/poi.ts";
import { WaveMember, WaveState } from "../../components/wave.ts";
import { Resource } from "../../components/resource.ts";
import { PoiSystem } from "../../systems/poi.ts";
import { newPoiActivityRegistry } from "../mod.ts";
import { ResourceSystem } from "../../systems/resource.ts";
import { newResourceEffectRegistry } from "../../resources/effect.ts";
import { newResourceModifierRegistry } from "../../resources/modifier.ts";
import { equipmentStatModifier } from "../../resources/modifiers/equipment_stat.ts";
import { newModifierSourceRegistry } from "../../modifiers/modifier.ts";
import { spawnNextWaveEffect } from "../../resources/effects/spawn_next_wave.ts";
import type { DeathRequestPort } from "../../events/death.ts";

const activities = newPoiActivityRegistry();
const content = await JsonSource.load();
const noDeaths: DeathRequestPort = { request: () => {} };
const DT = 1 / 20;

function resourceSystem(): ResourceSystem {
  const fx = newResourceEffectRegistry();
  fx.register(spawnNextWaveEffect);
  const mods = newResourceModifierRegistry();
  mods.register(equipmentStatModifier);
  return new ResourceSystem(content, fx, mods, noDeaths, newModifierSourceRegistry());
}

function placeTrigger(world: World, poiDefId: string, poiInstanceId: string) {
  const pid = newEntityId();
  world.create(pid);
  world.write(pid, Position, { x: 100, y: 100, z: 0 });

  const tid = newEntityId();
  world.create(tid);
  world.write(tid, Position, { x: 100, y: 100, z: 0 });
  world.write(tid, PoiTrigger, {
    poiInstanceId, poiDefId, triggerRadius: 5, fired: false,
  });
  return { pid, tid };
}

Deno.test("wave: activation spawns wave 0 and tags members", async () => {
  const world = new World();
  const events = new EventBus();
  const { pid, tid } = placeTrigger(world, "forgotten_garrison", "forgotten_garrison_z1");

  const sys = new PoiSystem(content, activities, () => [pid].values());
  sys.run(world, events, DT);
  world.applyChangeset();

  assertEquals(world.get(tid, PoiTrigger)?.fired, true);
  const state = world.get(tid, WaveState);
  assert(state, "expected WaveState on the trigger entity");
  assertEquals(state!.waveIndex, 1);
  assertEquals(state!.totalWaves, 3); // forgotten_garrison.json: 3 waves

  const members = world.query(WaveMember).filter((m) => m.waveMember.poiInstanceId === "forgotten_garrison_z1");
  assertEquals(members.length, 3, "wave 0 has count:3");
});

Deno.test("wave: PoiSystem seeds wave_timer once wave 0's members are all dead", async () => {
  const world = new World();
  const events = new EventBus();
  const { pid, tid } = placeTrigger(world, "forgotten_garrison", "forgotten_garrison_z1");

  const sys = new PoiSystem(content, activities, () => [pid].values());
  sys.run(world, events, DT);
  world.applyChangeset();

  // No timer yet — members still alive.
  sys.run(world, events, DT);
  world.applyChangeset();
  assertEquals(world.get(tid, Resource)?.values.wave_timer, undefined);

  // Kill every WaveMember.
  for (const { entityId } of world.query(WaveMember)) {
    world.destroy(entityId);
  }
  world.applyChangeset();

  sys.run(world, events, DT);
  world.applyChangeset();

  const timer = world.get(tid, Resource)?.values.wave_timer;
  assert(timer, "expected wave_timer to be seeded once wave 0 clears");
  assertEquals(timer!.value, 15 * 20); // forgotten_garrison interWaveSeconds=15
});

Deno.test("wave: wave_timer cross@0 dispatches wave 1 and advances WaveState", async () => {
  const world = new World();
  const events = new EventBus();
  const { tid } = placeTrigger(world, "forgotten_garrison", "forgotten_garrison_z1");

  // Seed WaveState + wave_timer directly (skip activation — this test is
  // scoped to the timer→spawn_next_wave leg).
  world.write(tid, WaveState, { poiInstanceId: "forgotten_garrison_z1", waveIndex: 1, totalWaves: 3 });
  world.write(tid, Resource, { values: { wave_timer: { value: 2, max: 2 } } });

  const rsys = resourceSystem();
  for (let i = 0; i < 3; i++) {
    rsys.run(world, events, DT);
    world.applyChangeset();
  }

  const state = world.get(tid, WaveState);
  assertEquals(state?.waveIndex, 2, "wave 1 dispatched -> waveIndex advances to 2");

  const wave1Members = world.query(WaveMember).filter((m) => m.waveMember.poiInstanceId === "forgotten_garrison_z1");
  assertEquals(wave1Members.length, 2, "forgotten_garrison wave index 1 has count:2");
});
