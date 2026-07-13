/**
 * TrainingDummySystem (T-327) — the combat-feel tuning pipeline's practice
 * target auto-heal. The "never dies" half lives in health_hit_handler.ts's
 * floor (covered by health_hit_handler tests / the dummy's design doc); this
 * covers only the recovery timing this system owns: hold at low health,
 * then snap to full once `healDelayTicks` pass with no further drop.
 */

import { assertEquals } from "jsr:@std/assert";
import { World, EventBus, newEntityId } from "@voxim/engine";
import { Health } from "../components/game.ts";
import { TrainingDummy } from "../components/training_dummy.ts";
import { TrainingDummySystem } from "./training_dummy_system.ts";

function tick(s: TrainingDummySystem, w: World, serverTick: number): void {
  s.prepare(serverTick);
  s.run(w, new EventBus(), 1 / 20);
  w.applyChangeset();
}

Deno.test("stays at reduced health until healDelayTicks pass, then snaps to full", () => {
  const s = new TrainingDummySystem();
  const w = new World();
  const id = newEntityId();
  w.create(id);
  w.write(id, Health, { current: 40, max: 100 });
  w.write(id, TrainingDummy, { healDelayTicks: 5, lastHitTick: 0, lastObservedHealth: 40 });

  // Ticks 1-4: still within the delay window, health untouched.
  for (let t = 1; t <= 4; t++) tick(s, w, t);
  assertEquals(w.get(id, Health)!.current, 40);

  // Tick 5: delay elapsed (5 - 0 >= 5) — snap to full.
  tick(s, w, 5);
  assertEquals(w.get(id, Health)!.current, 100);
});

Deno.test("a fresh hit restarts the delay clock instead of healing early", () => {
  const s = new TrainingDummySystem();
  const w = new World();
  const id = newEntityId();
  w.create(id);
  w.write(id, Health, { current: 40, max: 100 });
  w.write(id, TrainingDummy, { healDelayTicks: 5, lastHitTick: 0, lastObservedHealth: 40 });

  for (let t = 1; t <= 4; t++) tick(s, w, t);

  // A second hit lands at tick 5 (health drops further) — clock restarts.
  w.write(id, Health, { current: 20, max: 100 });
  tick(s, w, 5);
  assertEquals(w.get(id, Health)!.current, 20);
  assertEquals(w.get(id, TrainingDummy)!.lastHitTick, 5);

  // Ticks 6-9 still within the NEW delay window.
  for (let t = 6; t <= 9; t++) tick(s, w, t);
  assertEquals(w.get(id, Health)!.current, 20);

  // Tick 10: 10 - 5 >= 5 — heals.
  tick(s, w, 10);
  assertEquals(w.get(id, Health)!.current, 100);
});

Deno.test("a full-health dummy is left alone (no-op)", () => {
  const s = new TrainingDummySystem();
  const w = new World();
  const id = newEntityId();
  w.create(id);
  w.write(id, Health, { current: 100, max: 100 });
  w.write(id, TrainingDummy, { healDelayTicks: 5, lastHitTick: 0, lastObservedHealth: 100 });

  for (let t = 1; t <= 20; t++) tick(s, w, t);
  assertEquals(w.get(id, Health)!.current, 100);
});
