/**
 * `injury` ModifierSource (T-008) — an Injury entry resolves to its
 * game_config.injuries debuff and applies through effective(); additive
 * penalties scale with severity. Runs against real content (broken_leg,
 * deep_gash).
 */
import { assertEquals } from "jsr:@std/assert";
import { World, newEntityId } from "@voxim/engine";
import { JsonSource } from "@voxim/content";
import { Injury } from "../../components/injury.ts";
import type { InjuryEntry } from "../../components/injury.ts";
import { effective, newModifierSourceRegistry } from "../modifier.ts";
import { injurySource } from "./injury.ts";

const content = await JsonSource.load();

function actor(injuries: InjuryEntry[] | null) {
  const reg = newModifierSourceRegistry();
  reg.register(injurySource);
  const w = new World();
  const id = newEntityId();
  w.create(id);
  if (injuries) w.write(id, Injury, { injuries });
  return { reg, ctx: { world: w, content, entityId: id } };
}
const r3 = (n: number) => Math.round(n * 1000) / 1000;

Deno.test("injury: broken_leg slows moveSpeed (mul)", () => {
  const { reg, ctx } = actor([{ typeId: "broken_leg", severity: 1 }]);
  assertEquals(r3(effective(reg, ctx, "moveSpeed", 6)), 4.2); // 6 × 0.7
});

Deno.test("injury: deep_gash lowers armorReduction (add) and scales with severity", () => {
  assertEquals(r3(effective(actor([{ typeId: "deep_gash", severity: 1 }]).reg, actor([{ typeId: "deep_gash", severity: 1 }]).ctx, "armorReduction", 0)), -0.08);
  const sev2 = actor([{ typeId: "deep_gash", severity: 2 }]);
  assertEquals(r3(effective(sev2.reg, sev2.ctx, "armorReduction", 0)), -0.16); // additive × severity
});

Deno.test("injury: multiple injuries stack across stats", () => {
  const { reg, ctx } = actor([
    { typeId: "broken_leg", severity: 1 },
    { typeId: "deep_gash", severity: 1 },
  ]);
  assertEquals(r3(effective(reg, ctx, "moveSpeed", 6)), 4.2);
  assertEquals(r3(effective(reg, ctx, "armorReduction", 0)), -0.08);
});

Deno.test("injury: no Injury component → no contribution", () => {
  const { reg, ctx } = actor(null);
  assertEquals(effective(reg, ctx, "moveSpeed", 6), 6);
});

Deno.test("injury: an unknown injury id is ignored", () => {
  const { reg, ctx } = actor([{ typeId: "spontaneous_combustion", severity: 1 }]);
  assertEquals(effective(reg, ctx, "moveSpeed", 6), 6);
});
