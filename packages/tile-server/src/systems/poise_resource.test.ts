/**
 * Poise as a Resource — regen path (T-238d).
 *
 * Real content (data/resources/poise.json) + ResourceSystem. Poise damage
 * and the break → stagger-tier decision still live in health_hit_handler
 * (covered by actions/stagger.test.ts); ResourceSystem owns only the
 * pure-regen half this test locks: rate, the per-entity max clamp, and that
 * a broken (0) poise climbs back to full.
 */

import { assertEquals } from "jsr:@std/assert";
import { World, EventBus, newEntityId } from "@voxim/engine";
import { JsonSource } from "@voxim/content";
import { Resource } from "../components/resource.ts";
import { ResourceSystem } from "./resource.ts";
import { newModifierSourceRegistry } from "../modifiers/modifier.ts";
import { newResourceEffectRegistry } from "../resources/effect.ts";
import { newResourceModifierRegistry } from "../resources/modifier.ts";
import type { DeathRequestPort } from "../events/death.ts";

const DT = 1 / 20;
const noDeaths: DeathRequestPort = { request: () => {} };
const content = await JsonSource.load();

function sys(): ResourceSystem {
  return new ResourceSystem(
    content,
    newResourceEffectRegistry(),
    newResourceModifierRegistry(),
    noDeaths,
    newModifierSourceRegistry(),
  );
}

function tick(s: ResourceSystem, w: World): void {
  s.run(w, new EventBus(), DT);
  w.applyChangeset();
}

Deno.test("poise regens at the def rate and clamps at per-entity max", () => {
  const s = sys();
  const w = new World();
  const id = newEntityId();
  w.create(id);
  w.write(id, Resource, { values: { poise: { value: 20, max: 50 } } });

  tick(s, w);
  // poise.json rate 12/s, no modifiers → +12 * 1/20 = +0.6
  assertEquals(Math.round(w.get(id, Resource)!.values.poise.value * 100) / 100, 20.6);

  for (let i = 0; i < 200; i++) tick(s, w);
  assertEquals(w.get(id, Resource)!.values.poise.value, 50); // clamped at max
});

Deno.test("a broken poise (0) recovers back to full — no regen-disable window", () => {
  const s = sys();
  const w = new World();
  const id = newEntityId();
  w.create(id);
  w.write(id, Resource, { values: { poise: { value: 0, max: 50 } } });

  // First tick already regens (the old 0.5s post-break suppression is gone).
  tick(s, w);
  assertEquals(Math.round(w.get(id, Resource)!.values.poise.value * 100) / 100, 0.6);

  for (let i = 0; i < 200; i++) tick(s, w);
  assertEquals(w.get(id, Resource)!.values.poise.value, 50);
});
