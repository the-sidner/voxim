/**
 * ResourceSystem substrate (T-238a).
 *
 * Hand-built ResourceDefs + a minimal World — no JSON load. Covers rate
 * integration, bounds clamp, the rateModifier chain, sustained vs cross
 * threshold dispatch, and unknown-resource tolerance.
 */

import { assert, assertEquals } from "jsr:@std/assert";
import { World, EventBus, newEntityId } from "@voxim/engine";
import { StaticContentStore } from "@voxim/content";
import type { ResourceDef } from "@voxim/content";
import { Resource } from "../components/resource.ts";
import { ResourceSystem } from "./resource.ts";
import { newModifierSourceRegistry } from "../modifiers/modifier.ts";
import { newResourceEffectRegistry } from "../resources/effect.ts";
import type { ResourceEffect } from "../resources/effect.ts";
import { newResourceModifierRegistry } from "../resources/modifier.ts";
import type { ResourceRateModifier } from "../resources/modifier.ts";
import { destroySelfEffect } from "../resources/effects/destroy_self.ts";
import type { DeathRequestPort } from "../events/death.ts";

const DT = 1 / 20;
const noDeaths: DeathRequestPort = { request: () => {} };

function content(...defs: ResourceDef[]): StaticContentStore {
  const s = new StaticContentStore();
  for (const d of defs) s.registerResource(d);
  return s;
}

function entityWith(world: World, values: Record<string, { value: number; max: number }>): string {
  const id = newEntityId();
  world.create(id);
  world.write(id, Resource, { values });
  return id;
}

function tick(sys: ResourceSystem, world: World): void {
  sys.run(world, new EventBus(), DT);
  world.applyChangeset();
}

Deno.test("integrates the rate and clamps to [min, per-entity max]", () => {
  const c = content({ id: "stamina", scope: "entity", bounds: { min: 0, max: 100 }, rate: 10 });
  const sys = new ResourceSystem(c, newResourceEffectRegistry(), newResourceModifierRegistry(), noDeaths, newModifierSourceRegistry());
  const w = new World();
  const id = entityWith(w, { stamina: { value: 95, max: 100 } });

  tick(sys, w);
  assertEquals(w.get(id, Resource)!.values.stamina.value, 95.5); // +10*1/20

  for (let i = 0; i < 100; i++) tick(sys, w);
  assertEquals(w.get(id, Resource)!.values.stamina.value, 100); // clamped at per-entity max
});

Deno.test("negative rate clamps at bounds.min", () => {
  const c = content({ id: "hunger", scope: "entity", bounds: { min: 0, max: 100 }, rate: -50 });
  const sys = new ResourceSystem(c, newResourceEffectRegistry(), newResourceModifierRegistry(), noDeaths, newModifierSourceRegistry());
  const w = new World();
  const id = entityWith(w, { hunger: { value: 1, max: 100 } });
  tick(sys, w);
  tick(sys, w);
  assertEquals(w.get(id, Resource)!.values.hunger.value, 0);
});

Deno.test("rateModifier chain transforms the rate in order", () => {
  const c = content({
    id: "stamina", scope: "entity", bounds: { min: 0, max: 100 }, rate: 10,
    rateModifiers: [{ kind: "halve" }, { kind: "offset", params: { by: -1 } }],
  });
  const mods = newResourceModifierRegistry();
  const halve: ResourceRateModifier = { id: "halve", rate: (_c, r) => r * 0.5 };
  const offset: ResourceRateModifier = {
    id: "offset",
    rate: (ctx, r) => r + (ctx.params.by as number),
  };
  mods.register(halve);
  mods.register(offset);
  const sys = new ResourceSystem(c, newResourceEffectRegistry(), mods, noDeaths, newModifierSourceRegistry());
  const w = new World();
  const id = entityWith(w, { stamina: { value: 50, max: 100 } });

  tick(sys, w);
  // rate: 10 → halve → 5 → offset(-1) → 4 ; +4*1/20 = +0.2
  assertEquals(Math.round(w.get(id, Resource)!.values.stamina.value * 100) / 100, 50.2);
});

Deno.test("sustained threshold fires every in-zone tick; cross fires once on entry", () => {
  const c = content({
    id: "hunger", scope: "entity", bounds: { min: 0, max: 100 }, rate: 100,
    thresholds: [
      { at: 100, dir: "above", edge: "sustained", effect: "starve" },
      { at: 50, dir: "above", edge: "cross", effect: "warn" },
    ],
  });
  const fx = newResourceEffectRegistry();
  let starve = 0, warn = 0;
  const starveEffect: ResourceEffect = { id: "starve", resolve: () => { starve++; } };
  const warnEffect: ResourceEffect = { id: "warn", resolve: () => { warn++; } };
  fx.register(starveEffect);
  fx.register(warnEffect);
  const sys = new ResourceSystem(c, fx, newResourceModifierRegistry(), noDeaths, newModifierSourceRegistry());
  const w = new World();
  const id = entityWith(w, { hunger: { value: 48, max: 100 } });

  tick(sys, w); // 48 → 53: crosses 50 (warn once), not yet ≥100
  assertEquals(warn, 1);
  assertEquals(starve, 0);
  tick(sys, w); // 53 → 58: still above 50, cross must NOT refire
  assertEquals(warn, 1);

  for (let i = 0; i < 20; i++) tick(sys, w); // drives to/holds 100
  assertEquals(w.get(id, Resource)!.values.hunger.value, 100);
  assert(starve >= 2, "sustained fires every tick while pinned at the cap");
  assertEquals(warn, 1, "cross still only fired once");
});

Deno.test("lifetime: cross@0 → destroy_self destroys the entity (T-241)", () => {
  // The data/resources/lifetime.json shape: rate -20 (=-1/tick at 20Hz),
  // cross below 0 → destroy_self. Replaces LifetimeSystem.
  const c = content({
    id: "lifetime", scope: "entity", bounds: { min: 0, max: 1 }, rate: -20,
    thresholds: [{ at: 0, dir: "below", edge: "cross", effect: "destroy_self" }],
  });
  const fx = newResourceEffectRegistry();
  fx.register(destroySelfEffect);
  const sys = new ResourceSystem(c, fx, newResourceModifierRegistry(), noDeaths, newModifierSourceRegistry());
  const w = new World();
  const id = entityWith(w, { lifetime: { value: 2, max: 2 } }); // 2 ticks left

  tick(sys, w); // 2 → 1
  assert(w.isAlive(id), "alive while lifetime > 0");
  tick(sys, w); // 1 → 0: crosses, destroy_self
  assertEquals(w.isAlive(id), false);
});

Deno.test("unknown resource id is skipped, not thrown", () => {
  const c = content(); // no defs
  const sys = new ResourceSystem(c, newResourceEffectRegistry(), newResourceModifierRegistry(), noDeaths, newModifierSourceRegistry());
  const w = new World();
  const id = entityWith(w, { ghost: { value: 5, max: 10 } });
  tick(sys, w);
  assertEquals(w.get(id, Resource)!.values.ghost.value, 5); // untouched
});
