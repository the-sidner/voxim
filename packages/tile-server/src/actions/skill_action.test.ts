/**
 * Skill = Action (T-260b).
 *
 * Real content (data/actions/skill_mend.json) through the real dispatcher:
 * a SKILL_1 press becomes primary-slot intent via SkillIntentResolver
 * (overriding the bit-derived primary intent), the dispatcher starts the
 * cast — paying the stamina cost, stamping the per-action cooldown and the
 * GCD (T-260a) — and the heal fires on active:enter after the windup.
 * There is no SkillSystem; this IS the skill activation path.
 */

import { assert, assertEquals, assertAlmostEquals } from "jsr:@std/assert";
import { World, EventBus, newEntityId } from "@voxim/engine";
import { JsonSource } from "@voxim/content";
import { ACTION_SKILL_1 } from "@voxim/protocol";
import { ActorSlots, ActiveActions } from "../components/action.ts";
import { ActionCooldowns } from "../components/action_cooldowns.ts";
import { InputState, Health } from "../components/game.ts";
import { Resource } from "../components/resource.ts";
import { LoreLoadout } from "../components/lore_loadout.ts";
import { ActionDispatcher } from "./dispatcher.ts";
import { CompositeIntentResolver, PrimaryIntentResolver, SkillIntentResolver } from "./intent.ts";
import { newGateRegistry } from "./gate.ts";
import { newEffectRegistry } from "./effect.ts";
import { notStaggeredGate } from "./resolvers/gates.ts";
import { HealthSkillResolver } from "./resolvers/skill_effects.ts";
import { StaminaCostHandler } from "./cost.ts";

const content = await JsonSource.load();

function caster(world: World, actions: number, slot0: string | null = "skill_mend"): string {
  const id = newEntityId();
  world.create(id);
  world.write(id, ActorSlots, { slots: ["primary"] });
  world.write(id, ActiveActions, { states: {} });
  world.write(id, InputState, {
    seq: 1, timestamp: 0, facing: 0, movementX: 0, movementY: 0, actions, chargeMs: 0, rttMs: 0,
  });
  world.write(id, LoreLoadout, { skills: [slot0, null, null, null], learnedFragmentIds: [] });
  world.write(id, Resource, { values: { stamina: { value: 100, max: 100 } } });
  world.write(id, Health, { current: 10, max: 100 });
  return id;
}

function dispatcher(): ActionDispatcher {
  const gates = newGateRegistry();
  gates.register(notStaggeredGate);
  const effects = newEffectRegistry();
  effects.register(new HealthSkillResolver({ request: () => {} }));
  return new ActionDispatcher(
    content, gates, effects,
    new CompositeIntentResolver([new PrimaryIntentResolver(content), SkillIntentResolver]),
    StaminaCostHandler,
  );
}

Deno.test("skill_mend: SKILL_1 press casts through the dispatcher — cost, CD, GCD, heal", () => {
  const world = new World();
  const id = caster(world, ACTION_SKILL_1);
  const d = dispatcher();

  const tick = (t: number) => {
    d.prepare(t);
    d.run(world, new EventBus(), 1 / 20);
    world.applyChangeset();
  };

  tick(1);
  const state = world.get(id, ActiveActions)!.states["primary"];
  assertEquals(state?.actionId, "skill_mend", "the skill press overrode the idle intent");
  assertEquals(state?.phase, "windup");
  assertAlmostEquals(world.get(id, Resource)!.values.stamina.value, 77, 1e-9, "stamina cost paid (23)");
  const ac = world.get(id, ActionCooldowns)!;
  assertEquals(ac.remaining["skill_mend"], 80, "per-action cooldown stamped");
  assertEquals(ac.gcd, content.getGameConfig().lore.globalCooldownTicks, "GCD raised");
  assertEquals(world.get(id, Health)!.current, 10, "no heal during windup");

  // Windup is 8 ticks; the heal fires on active:enter.
  for (let t = 2; t <= 9; t++) tick(t);
  assertEquals(world.get(id, Health)!.current, 50, "heal (+40) fired on active:enter");
});

Deno.test("an empty slot does nothing", () => {
  const world = new World();
  const id = caster(world, ACTION_SKILL_1, null);
  const d = dispatcher();
  d.prepare(1);
  d.run(world, new EventBus(), 1 / 20);
  world.applyChangeset();
  assertEquals(world.get(id, ActiveActions)!.states["primary"]?.actionId, "primary_idle",
    "falls through to the bit-derived primary intent");
  assert(!world.has(id, ActionCooldowns));
});

Deno.test("boot invariant: every configured starting skill is a loaded ActionDef", () => {
  for (const sk of content.getGameConfig().player.startingSkills ?? []) {
    if (sk !== null) assert(content.actions.get(sk), `starting skill "${sk}" must be an ActionDef`);
  }
});
