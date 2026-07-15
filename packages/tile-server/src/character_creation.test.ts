/**
 * Character creation (T-071) — server-side validation of a fresh player's
 * join-time selections. The client choice is advisory; this resolver is the
 * trust boundary: a valid species is honoured, an invalid/absent one falls
 * back to the config default, and lore picks are filtered to known fragment
 * ids. Runs against real content (game_config.species: human/dwarf/elf + the
 * lore registry).
 */
import { assertEquals, assert } from "jsr:@std/assert";
import { World } from "@voxim/engine";
import { JsonSource } from "@voxim/content";
import { resolveCharacterSelections } from "./character_creation.ts";
import { spawnPrefab } from "./spawner.ts";
import { Species } from "./components/species.ts";
import { LoreLoadout } from "./components/lore_loadout.ts";
import { ModelRef } from "./components/game.ts";

const content = await JsonSource.load();
const defaultSpecies = content.getGameConfig().player.species ?? "human";

Deno.test("character creation: a valid species is honoured", () => {
  assertEquals(resolveCharacterSelections(content, { speciesId: "dwarf" }).speciesId, "dwarf");
  assertEquals(resolveCharacterSelections(content, { speciesId: "elf" }).speciesId, "elf");
});

Deno.test("character creation: an unknown species falls back to the config default", () => {
  assertEquals(
    resolveCharacterSelections(content, { speciesId: "gnome_undefined" }).speciesId,
    defaultSpecies,
  );
});

Deno.test("character creation: absent species → config default", () => {
  assertEquals(resolveCharacterSelections(content, {}).speciesId, defaultSpecies);
  assertEquals(resolveCharacterSelections(content, undefined).speciesId, defaultSpecies);
});

Deno.test("character creation: empty-string species → config default (not honoured)", () => {
  assertEquals(resolveCharacterSelections(content, { speciesId: "" }).speciesId, defaultSpecies);
});

Deno.test("character creation: lore picks are filtered to known fragment ids", () => {
  // Pick a real fragment id from the loaded content (any one is fine).
  const known = [...content.loreFragments.values()][0]?.id;
  if (!known) throw new Error("test fixture: no lore fragments loaded");

  const out = resolveCharacterSelections(content, {
    initialFragmentIds: [known, "fragment_that_does_not_exist", known],
  });
  // Unknown dropped; duplicate of `known` collapsed; order preserved.
  assertEquals(out.fragmentIds, [known]);
});

Deno.test("character creation: no lore picks → empty learned set", () => {
  assertEquals(resolveCharacterSelections(content, { speciesId: "human" }).fragmentIds, []);
});

// ---- spawn integration: the resolved selections land on the entity ----

Deno.test("character creation: chosen species + lore land on the spawned player", () => {
  const world = new World();
  const known = [...content.loreFragments.values()][0]?.id;
  if (!known) throw new Error("test fixture: no lore fragments loaded");

  const resolved = resolveCharacterSelections(content, {
    speciesId: "elf",
    initialFragmentIds: [known],
  });
  const id = spawnPrefab(world, content, "player", {
    speciesId: resolved.speciesId,
    initialFragmentIds: resolved.fragmentIds,
  });

  assertEquals(world.get(id, Species)?.speciesId, "elf");
  assertEquals(world.get(id, LoreLoadout)?.learnedFragmentIds, [known]);
});

Deno.test("character creation: no selections → config default species + empty lore", () => {
  const world = new World();
  const id = spawnPrefab(world, content, "player", {});
  assertEquals(world.get(id, Species)?.speciesId, defaultSpecies);
  assertEquals(world.get(id, LoreLoadout)?.learnedFragmentIds, []);
});

// ---- T-085: species visual variants — morphValues land on ModelRef ----

Deno.test("T-085: a dwarf spawns shorter + wider than a human at the same seed", () => {
  const world = new World();
  const seed = 12345;

  const dwarfId = spawnPrefab(world, content, "player", { speciesId: "dwarf", seed });
  const humanId = spawnPrefab(world, content, "player", { speciesId: "human", seed });

  const dwarfMorphs = world.get(dwarfId, ModelRef)?.morphValues ?? {};
  const humanMorphs = world.get(humanId, ModelRef)?.morphValues ?? {};

  const dwarfDef = content.getGameConfig().species.dwarf;
  assert(dwarfDef.morphValues, "test fixture: dwarf must declare morphValues");

  // Every dwarf-declared morph key resolved to exactly the species value —
  // same seed as the human, so any difference is the species base, not T-190
  // per-instance variety.
  for (const [key, value] of Object.entries(dwarfDef.morphValues!)) {
    assertEquals(dwarfMorphs[key], value, `dwarf.${key} should equal the species morphValue`);
  }

  // Shorter: legLength and torsoHeight both down vs. human at the same seed.
  assert(dwarfMorphs.legLength < humanMorphs.legLength, "dwarf legLength should be shorter");
  assert(dwarfMorphs.torsoHeight < humanMorphs.torsoHeight, "dwarf torsoHeight should be shorter");
  // Wider: shoulderWidth and hipWidth both up vs. human at the same seed.
  assert(dwarfMorphs.shoulderWidth > humanMorphs.shoulderWidth, "dwarf shoulderWidth should be wider");
  assert(dwarfMorphs.hipWidth > humanMorphs.hipWidth, "dwarf hipWidth should be wider");
});

Deno.test("T-085: an elf spawns taller + more slender than a human at the same seed", () => {
  const world = new World();
  const seed = 987;

  const elfId = spawnPrefab(world, content, "player", { speciesId: "elf", seed });
  const humanId = spawnPrefab(world, content, "player", { speciesId: "human", seed });

  const elfMorphs = world.get(elfId, ModelRef)?.morphValues ?? {};
  const humanMorphs = world.get(humanId, ModelRef)?.morphValues ?? {};

  assert(elfMorphs.legLength > humanMorphs.legLength, "elf legLength should be taller");
  assert(elfMorphs.shoulderWidth < humanMorphs.shoulderWidth, "elf shoulderWidth should be slimmer");
  assert(elfMorphs.hipWidth < humanMorphs.hipWidth, "elf hipWidth should be slimmer");
});

Deno.test("T-085: human has no species-driven morph bias — same seed as itself is stable", () => {
  const world = new World();
  const seed = 42;
  const id1 = spawnPrefab(world, content, "player", { speciesId: "human", seed });
  const id2 = spawnPrefab(world, content, "player", { speciesId: "human", seed });
  assertEquals(world.get(id1, ModelRef)?.morphValues, world.get(id2, ModelRef)?.morphValues);
});

Deno.test("T-085: same species + same seed → identical body (deterministic per character)", () => {
  const world = new World();
  const seed = 555;
  const a = spawnPrefab(world, content, "player", { speciesId: "dwarf", seed });
  const b = spawnPrefab(world, content, "player", { speciesId: "dwarf", seed });
  assertEquals(world.get(a, ModelRef)?.morphValues, world.get(b, ModelRef)?.morphValues);
});

Deno.test("T-085: an unresolved speciesId (no character-creation validation applied) gets no species morph bias", () => {
  const world = new World();
  const seed = 42;
  // spawnPrefab itself does no species validation (that's character_creation's
  // job) — an id absent from game_config.species simply contributes no morphs,
  // same as omitting speciesId entirely.
  const id = spawnPrefab(world, content, "player", { speciesId: "not_a_real_species", seed });
  const humanId = spawnPrefab(world, content, "player", { speciesId: "human", seed });
  assertEquals(world.get(id, ModelRef)?.morphValues, world.get(humanId, ModelRef)?.morphValues);
});
