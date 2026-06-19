/**
 * `species` ModifierSource (T-084) — a species id on the server-only Species
 * component contributes its passive-trait StatModifiers through `effective()`,
 * composing with every other source over one fold. Runs against real content
 * (game_config.species: human/dwarf/elf).
 */
import { assertEquals } from "jsr:@std/assert";
import { World, newEntityId } from "@voxim/engine";
import { JsonSource } from "@voxim/content";
import { Species } from "../../components/species.ts";
import { effective, newModifierSourceRegistry } from "../modifier.ts";
import { speciesSource } from "./species.ts";

const content = await JsonSource.load();

function actor(speciesId: string | null): { reg: ReturnType<typeof newModifierSourceRegistry>; ctx: { world: World; content: typeof content; entityId: string } } {
  const reg = newModifierSourceRegistry();
  reg.register(speciesSource);
  const w = new World();
  const id = newEntityId();
  w.create(id);
  if (speciesId !== null) w.write(id, Species, { speciesId });
  return { reg, ctx: { world: w, content, entityId: id } };
}

Deno.test("species: dwarf adds armorReduction and slows moveSpeed", () => {
  const { reg, ctx } = actor("dwarf");
  // dwarf: armorReduction +0.1 (add), moveSpeed ×0.92 (mul)
  assertEquals(effective(reg, ctx, "armorReduction", 0), 0.1);
  assertEquals(Math.round(effective(reg, ctx, "moveSpeed", 6) * 1000) / 1000, 5.52);
});

Deno.test("species: elf speeds moveSpeed", () => {
  const { reg, ctx } = actor("elf");
  assertEquals(Math.round(effective(reg, ctx, "moveSpeed", 6) * 100) / 100, 6.6);
});

Deno.test("species: human is the inert baseline", () => {
  const { reg, ctx } = actor("human");
  assertEquals(effective(reg, ctx, "moveSpeed", 6), 6);
  assertEquals(effective(reg, ctx, "armorReduction", 0), 0);
});

Deno.test("species: no Species component → no contribution", () => {
  const { reg, ctx } = actor(null);
  assertEquals(effective(reg, ctx, "moveSpeed", 6), 6);
});

Deno.test("species: unknown id contributes nothing (no crash)", () => {
  const { reg, ctx } = actor("gnome_undefined");
  assertEquals(effective(reg, ctx, "moveSpeed", 6), 6);
});
