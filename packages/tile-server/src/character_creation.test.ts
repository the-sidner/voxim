/**
 * Character creation (T-071) — server-side validation of a fresh player's
 * join-time selections. The client choice is advisory; this resolver is the
 * trust boundary: a valid species is honoured, an invalid/absent one falls
 * back to the config default, and lore picks are filtered to known fragment
 * ids. Runs against real content (game_config.species: human/dwarf/elf + the
 * lore registry).
 */
import { assertEquals } from "jsr:@std/assert";
import { World } from "@voxim/engine";
import { JsonSource } from "@voxim/content";
import { resolveCharacterSelections } from "./character_creation.ts";
import { spawnPrefab } from "./spawner.ts";
import { Species } from "./components/species.ts";
import { LoreLoadout } from "./components/lore_loadout.ts";

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
