/**
 * SkillSystem activation path (T-247).
 *
 * Locks the consolidated `activateSkill()` seam: pressing a SKILL_N flag on
 * an off-cooldown slot pays the stamina cost, fires the effect, and stamps
 * the per-slot cooldown — and a slot on cooldown does nothing. Uses a real
 * content load (lore fragments + concept-verb matrix) with a minimal effect
 * registry carrying just the `health` resolver the test skill needs.
 */

import { assert, assertEquals, assertAlmostEquals } from "jsr:@std/assert";
import { World, EventBus, newEntityId } from "@voxim/engine";
import { JsonSource } from "@voxim/content";
import { ACTION_SKILL_1 } from "@voxim/protocol";
import { InputState, Health } from "../components/game.ts";
import { LoreLoadout } from "../components/lore_loadout.ts";
import { Resource } from "../components/resource.ts";
import { newEffectRegistry } from "../actions/effect.ts";
import { HealthSkillResolver } from "../actions/resolvers/skill_effects.ts";
import { SkillSystem } from "./skill.ts";

const content = await JsonSource.load();

function skillSystem(): SkillSystem {
  const effects = newEffectRegistry();
  effects.register(new HealthSkillResolver({ request: () => {} }));
  return new SkillSystem(content, effects);
}

// invoke + MEND + SWIFT → self-heal (effectStat "health", outwardScale 20,
// staminaCostBase 15, inwardScale 4, cooldownTicks 80).
const HEAL_SLOT = { verb: "invoke" as const, outwardFragmentId: "mending_touch", inwardFragmentId: "swift_step" };

function makeHealer(world: World, actions: number, cooldowns = [0, 0, 0, 0]): string {
  const id = newEntityId();
  world.create(id);
  world.write(id, InputState, {
    seq: 1, timestamp: 0, facing: 0, movementX: 0, movementY: 0, actions, chargeMs: 0, rttMs: 0,
  });
  world.write(id, LoreLoadout, {
    skills: [HEAL_SLOT, null, null, null],
    learnedFragmentIds: ["mending_touch", "swift_step"],
    skillCooldowns: cooldowns,
  });
  world.write(id, Resource, { values: { stamina: { value: 100, max: 100 } } });
  world.write(id, Health, { current: 10, max: 100 });
  return id;
}

Deno.test("activation: SKILL_1 heals, spends stamina, stamps the slot cooldown", () => {
  const world = new World();
  const id = makeHealer(world, ACTION_SKILL_1);
  const sys = skillSystem();

  const heal = content.loreFragments.getOrThrow("mending_touch").magnitude * 20;
  const cost = 15 + content.loreFragments.getOrThrow("swift_step").magnitude * 4;

  sys.run(world, new EventBus(), 1 / 20);
  world.applyChangeset();

  assertEquals(world.get(id, Health)!.current, Math.min(100, 10 + heal), "healed by magnitude×outwardScale");
  assertAlmostEquals(world.get(id, Resource)!.values.stamina.value, 100 - cost, 1e-6, "stamina spent");
  assertEquals(world.get(id, LoreLoadout)!.skillCooldowns[0], 80, "slot 0 cooldown stamped");
  assertEquals(world.get(id, LoreLoadout)!.skillCooldowns[1], 0, "untouched slots stay 0");
});

Deno.test("activation: a slot on cooldown does not fire (and just decrements)", () => {
  const world = new World();
  const id = makeHealer(world, ACTION_SKILL_1, [5, 0, 0, 0]);
  const sys = skillSystem();

  sys.run(world, new EventBus(), 1 / 20);
  world.applyChangeset();

  assertEquals(world.get(id, Health)!.current, 10, "no heal — on cooldown");
  assertEquals(world.get(id, Resource)!.values.stamina.value, 100, "no stamina spent");
  assertEquals(world.get(id, LoreLoadout)!.skillCooldowns[0], 4, "cooldown decremented by one tick");
});

Deno.test("activation: no SKILL flag → nothing happens", () => {
  const world = new World();
  const id = makeHealer(world, 0);
  const sys = skillSystem();

  sys.run(world, new EventBus(), 1 / 20);
  world.applyChangeset();

  assertEquals(world.get(id, Health)!.current, 10);
  assertEquals(world.get(id, LoreLoadout)!.skillCooldowns[0], 0);
});
