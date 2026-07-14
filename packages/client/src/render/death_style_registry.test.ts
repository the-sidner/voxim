/**
 * Death-style registry (T-339) — style -> handler dispatch + boot cross-
 * check. Pure, headless.
 */
import { assert, assertEquals, assertThrows } from "jsr:@std/assert";
import { StaticContentStore, JsonSource } from "@voxim/content";
import type { DeathStyleDef } from "@voxim/content";
import {
  registerBuiltinDeathStyles,
  getDeathStyleHandler,
  deathStyleIds,
  crossCheckDeathStyles,
} from "./death_style_registry.ts";

Deno.test("registerBuiltinDeathStyles: dissolve and crumble are both registered (crumble as a placeholder until VoximRenderer overwrites it)", () => {
  registerBuiltinDeathStyles();
  assert(getDeathStyleHandler("dissolve"));
  assert(getDeathStyleHandler("crumble"));
  assertEquals(deathStyleIds().sort(), ["crumble", "dissolve"]);
});

Deno.test("crossCheckDeathStyles: throws on a DeathStyleDef naming an unregistered style", () => {
  const store = new StaticContentStore();
  const bogus = { id: "bogus", style: "ragdoll", resourceKey: "x" } as unknown as DeathStyleDef;
  store.registerDeathStyle(bogus);
  assertThrows(() => crossCheckDeathStyles(store), Error, "unknown style");
});

Deno.test("crossCheckDeathStyles: passes clean against the real loaded content (dissolve.json + crumble.json)", async () => {
  const content = await JsonSource.load();
  crossCheckDeathStyles(content); // must not throw
  assertEquals([...content.deathStyles.values()].map((d) => d.id).sort(), ["crumble", "dissolve"]);
});
