/**
 * Skill effect resolvers on the unified substrate (T-246).
 *
 * Locks the behaviour the retired `effects/` registry had, now that the
 * five effects are ordinary action `EffectResolver`s driven by `params`:
 * stat-modifier effects spawn buff children, `health` heals/drains a
 * target (and requests death on lethal), `flee` forces NPC job queues.
 */

import { assert, assertEquals, assertAlmostEquals } from "jsr:@std/assert";
import { World, EventBus, newEntityId } from "@voxim/engine";
import type { EntityId } from "@voxim/engine";
import type { ContentService } from "@voxim/content";
import { TileEvents } from "@voxim/protocol";
import { Health, Position } from "../../components/game.ts";
import { NpcJobQueue } from "../../components/npcs.ts";
import { BuffSpec } from "../../components/buff.ts";
import type { ActiveActionState } from "../../components/action.ts";
import type { ResolveContext } from "../effect.ts";
import {
  speedSkillEffect, damageBoostSkillEffect, shieldSkillEffect, fleeSkillEffect, HealthSkillResolver,
} from "./skill_effects.ts";

const STATE: ActiveActionState = { actionId: "", phase: "", ticksInPhase: 0, initiator: "intent" };

function ctx(
  world: World, events: EventBus, entityId: EntityId,
  params: Record<string, unknown>, serverTick = 0,
): ResolveContext {
  // Skill effect resolvers read only entityId + params; content/slot/state
  // are inert here (the synthetic dispatch shape SkillSystem supplies).
  return {
    world, events, entityId, slot: "skill", state: STATE,
    content: {} as ContentService, params, edge: "enter", serverTick,
  };
}

function buffChildOf(world: World, parent: EntityId) {
  for (const id of world.getChildren(parent)) {
    const spec = world.get(id, BuffSpec);
    if (spec) return spec;
  }
  return null;
}

Deno.test("speed: spawns a moveSpeed×(1+mag) buff child", () => {
  const world = new World();
  const id = newEntityId();
  world.create(id);
  speedSkillEffect.resolve(ctx(world, new EventBus(), id, { magnitude: 0.5, durationTicks: 60 }));
  const spec = buffChildOf(world, id);
  assert(spec, "expected a buff child");
  assertEquals(spec, { stat: "moveSpeed", op: "mul", value: 1.5, tickDelta: 0 });
});

Deno.test("damage_boost / shield: damageDealt up, damageTaken down", () => {
  const world = new World();
  const a = newEntityId(); world.create(a);
  damageBoostSkillEffect.resolve(ctx(world, new EventBus(), a, { magnitude: 0.25, durationTicks: 40 }));
  assertEquals(buffChildOf(world, a), { stat: "damageDealt", op: "mul", value: 1.25, tickDelta: 0 });

  const b = newEntityId(); world.create(b);
  shieldSkillEffect.resolve(ctx(world, new EventBus(), b, { magnitude: 40, durationTicks: 40 }));
  // factor = clamp(0.2, 0.95, 1 - 40/100) = 0.6
  const spec = buffChildOf(world, b)!;
  assertEquals(spec.stat, "damageTaken");
  assertAlmostEquals(spec.value, 0.6, 1e-9);
});

Deno.test("health self: heals up to max", () => {
  const world = new World();
  const id = newEntityId(); world.create(id);
  world.write(id, Health, { current: 50, max: 100 });
  const r = new HealthSkillResolver({ request: () => {} });
  r.resolve(ctx(world, new EventBus(), id, { magnitude: 30, targeting: "self" }));
  world.applyChangeset();
  assertEquals(world.get(id, Health)!.current, 80);
});

Deno.test("health drain: damages target, drains to caster, requests death on lethal", () => {
  const world = new World();
  const events = new EventBus();
  const damage: number[] = [];
  events.subscribe(TileEvents.DamageDealt, (p: { amount: number }) => damage.push(p.amount));

  const caster = newEntityId(); world.create(caster);
  world.write(caster, Position, { x: 0, y: 0, z: 0 });
  world.write(caster, Health, { current: 50, max: 100 });
  const target = newEntityId(); world.create(target);
  world.write(target, Position, { x: 1, y: 0, z: 0 });
  world.write(target, Health, { current: 20, max: 100 });

  const requested: EntityId[] = [];
  const r = new HealthSkillResolver({ request: (req: { entityId: EntityId }) => requested.push(req.entityId) });
  // magnitude 30 > target 20 → stolen clamped to 20, target dies, caster +20
  r.resolve(ctx(world, events, caster, {
    magnitude: 30, targeting: "entity", range: 10, drainToCaster: true, overrideTargetId: target,
  }));
  world.applyChangeset();

  assertEquals(world.get(target, Health)!.current, 0);
  assertEquals(world.get(caster, Health)!.current, 70, "drained 20 to caster");
  assertEquals(damage, [20]);
  assertEquals(requested, [target], "death requested on lethal");
});

Deno.test("flee: forces nearby NPC job queues into a flee job", () => {
  const world = new World();
  const caster = newEntityId(); world.create(caster);
  world.write(caster, Position, { x: 0, y: 0, z: 0 });
  const npc = newEntityId(); world.create(npc);
  world.write(npc, Position, { x: 2, y: 0, z: 0 });
  world.write(npc, NpcJobQueue, { current: null, scheduled: [], plan: null });

  fleeSkillEffect.resolve(ctx(world, new EventBus(), caster, { durationTicks: 60, range: 10 }, 100));
  world.applyChangeset();

  const job = world.get(npc, NpcJobQueue)!.current;
  assertEquals(job?.type, "flee");
  assertEquals((job as { expiresAt: number }).expiresAt, 160);
});
