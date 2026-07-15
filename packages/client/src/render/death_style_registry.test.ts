/**
 * Death-style registry (T-339) — style -> handler dispatch + boot cross-
 * check. Pure, headless.
 */
import { assert, assertEquals, assertThrows } from "jsr:@std/assert";
import { StaticContentStore, JsonSource } from "@voxim/content";
import type { DeathStyleDef } from "@voxim/content";
import {
  registerBuiltinDeathStyles,
  registerDeathStyle,
  getDeathStyleHandler,
  crossCheckDeathStyles,
} from "./death_style_registry.ts";

Deno.test("registerBuiltinDeathStyles: dissolve is registered (the one stateless builtin)", () => {
  registerBuiltinDeathStyles();
  assert(getDeathStyleHandler("dissolve"));
});

Deno.test("crossCheckDeathStyles: throws on a DeathStyleDef naming an unregistered style", () => {
  const store = new StaticContentStore();
  const bogus = { id: "bogus", style: "ragdoll", resourceKey: "x" } as unknown as DeathStyleDef;
  store.registerDeathStyle(bogus);
  assertThrows(() => crossCheckDeathStyles(store), Error, "unknown style");
});

Deno.test("crossCheckDeathStyles: passes clean against the real loaded content (dissolve.json + crumble.json)", async () => {
  // game.ts registers the real CrumbleController-backed handler before the
  // cross-check runs; a stub stands in for it here.
  registerDeathStyle("crumble", () => {});
  const content = await JsonSource.load();
  crossCheckDeathStyles(content); // must not throw
  assertEquals([...content.deathStyles.values()].map((d) => d.id).sort(), ["crumble", "dissolve"]);
});
