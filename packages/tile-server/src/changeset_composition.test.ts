/**
 * Same-tick write composition (T-249 move 2 — the ticket's "Done when").
 *
 * The op-log + world.mutate conversions: two same-tick hits both subtract
 * health; two DoT buffs stack; a stamina spend and the regen tick on one
 * Resource compose; and a kill only visible in the composed total is
 * caught by DeathSystem's health≤0 sweep.
 */

import { assert, assertEquals, assertAlmostEquals } from "jsr:@std/assert";
import { Registry, World, EventBus, newEntityId } from "@voxim/engine";
import type { EntityId } from "@voxim/engine";
import { JsonSource } from "@voxim/content";
import type { ContentService } from "@voxim/content";
import { TileEvents } from "@voxim/protocol";
import { Health, Position } from "./components/game.ts";
import { Resource } from "./components/resource.ts";
import { BuffSpec } from "./components/buff.ts";
import type { ActiveActionState } from "./components/action.ts";
import type { ResolveContext } from "./actions/effect.ts";
import { HealthSkillResolver } from "./actions/resolvers/skill_effects.ts";
import { buffTickResolver, spawnBuffChild } from "./actions/resolvers/buff.ts";
import { spendStamina } from "./combat/helpers.ts";
import { ResourceSystem } from "./systems/resource.ts";
import { DeathSystem } from "./systems/death.ts";
import type { DeathHook } from "./systems/death.ts";
import { newResourceEffectRegistry } from "./resources/effect.ts";
import { newResourceModifierRegistry } from "./resources/modifier.ts";
import { equipmentStatModifier } from "./resources/modifiers/equipment_stat.ts";
import { newModifierSourceRegistry } from "./modifiers/modifier.ts";
import { equipmentSource } from "./modifiers/sources/equipment.ts";
import type { DeathRequestPort } from "./events/death.ts";

const DT = 1 / 20;
const content = await JsonSource.load();
const noDeaths: DeathRequestPort = { request: () => {} };
const STATE: ActiveActionState = { actionId: "", phase: "", ticksInPhase: 0, initiator: "intent" };

function fxCtx(world: World, events: EventBus, entityId: EntityId, params: Record<string, unknown>): ResolveContext {
  return {
    world, events, entityId, slot: "skill", state: STATE,
    content: {} as ContentService, params, edge: "enter", serverTick: 0,
  };
}

Deno.test("two same-tick damage writers both subtract (no lost update)", () => {
  const world = new World();
  const events = new EventBus();
  const caster = newEntityId();
  world.create(caster);
  world.write(caster, Position, { x: 0, y: 0, z: 0 });
  const target = newEntityId();
  world.create(target);
  world.write(target, Position, { x: 1, y: 0, z: 0 });
  world.write(target, Health, { current: 100, max: 100 });

  const r = new HealthSkillResolver(noDeaths);
  const params = { magnitude: 30, targeting: "entity", range: 10, overrideTargetId: target };
  r.resolve(fxCtx(world, events, caster, params));
  r.resolve(fxCtx(world, events, caster, params));
  world.applyChangeset();

  assertEquals(world.get(target, Health)!.current, 40, "both 30-damage hits landed");
});

Deno.test("two DoT buffs on one parent stack", () => {
  const world = new World();
  const events = new EventBus();
  const parent = newEntityId();
  world.create(parent);
  world.write(parent, Health, { current: 50, max: 100 });

  const a = spawnBuffChild(world, parent, { stat: "health", op: "add", value: 0, tickDelta: -5 }, 100);
  const b = spawnBuffChild(world, parent, { stat: "health", op: "add", value: 0, tickDelta: -5 }, 100);
  assert(world.get(a, BuffSpec) && world.get(b, BuffSpec));

  // Both buff children fire their hold:tick the same tick.
  buffTickResolver.resolve(fxCtx(world, events, a, {}));
  buffTickResolver.resolve(fxCtx(world, events, b, {}));
  world.applyChangeset();

  assertEquals(world.get(parent, Health)!.current, 40, "both DoTs applied");
});

Deno.test("a stamina spend and the regen tick on one Resource compose", () => {
  const world = new World();
  const mods = newResourceModifierRegistry();
  mods.register(equipmentStatModifier);
  const sources = newModifierSourceRegistry();
  sources.register(equipmentSource);
  const resourceSystem = new ResourceSystem(content, newResourceEffectRegistry(), mods, noDeaths, sources);

  const id = newEntityId();
  world.create(id);
  world.write(id, Resource, { values: { stamina: { value: 50, max: 100 } } });

  // Same tick: ResourceSystem integrates (+8/s × 1/20 = +0.4), then a
  // spend of 10 — under last-write-wins one of the two was lost.
  resourceSystem.run(world, new EventBus(), DT);
  assert(spendStamina(world, id, 10), "spend affordable against committed state");
  world.applyChangeset();

  assertAlmostEquals(world.get(id, Resource)!.values.stamina.value, 40.4, 1e-9, "regen + spend both landed");
});

Deno.test("composed-lethal: two survivable hits kill via DeathSystem's sweep", () => {
  const world = new World();
  const events = new EventBus();
  const caster = newEntityId();
  world.create(caster);
  world.write(caster, Position, { x: 0, y: 0, z: 0 });
  const target = newEntityId();
  world.create(target);
  world.write(target, Position, { x: 1, y: 0, z: 0 });
  world.write(target, Health, { current: 50, max: 100 });

  // Each hit reads committed 50, computes 20 (survivable) — no death
  // request from either; the composed total is 0.
  const deathRequests: EntityId[] = [];
  const r = new HealthSkillResolver({ request: (p) => deathRequests.push(p.entityId) });
  const params = { magnitude: 30, targeting: "entity", range: 10, overrideTargetId: target };
  r.resolve(fxCtx(world, events, caster, params));
  r.resolve(fxCtx(world, events, caster, params));
  world.applyChangeset();

  assertEquals(deathRequests.length, 0, "neither hit saw the kill");
  assertEquals(world.get(target, Health)!.current, 0, "composed total is lethal");

  // Next tick: the sweep catches it.
  const died: EntityId[] = [];
  events.subscribe(TileEvents.EntityDied, (p: { entityId: EntityId }) => died.push(p.entityId));
  const deathSystem = new DeathSystem(new Registry<DeathHook>());
  deathSystem.run(world, events, DT);
  world.applyChangeset();

  assertEquals(died, [target], "sweep killed the composed-lethal entity");
  assert(!world.isAlive(target));
});
