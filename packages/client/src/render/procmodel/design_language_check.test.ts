/**
 * design_language_check (T-301) — boot coherence check pins. Mirrors
 * registry.test.ts's structure: the real content must pass; targeted bad
 * fixtures must throw with a specific reason.
 */
import { assert, assertThrows } from "jsr:@std/assert";
import { JsonSource } from "@voxim/content";
import type { ContentService, MaterialDef } from "@voxim/content";
import { registerBuiltinGenerators, registerGenerator } from "./mod.ts";
import { crossCheckDesignLanguage } from "./design_language_check.ts";

const content = await JsonSource.load("packages/content/data");
registerBuiltinGenerators();

/** A registry-backed fake ContentRegistry good enough for `content.materials`
 *  reads (`.get`/`.getOrThrow`/`.values`) — avoids depending on internal
 *  ContentRegistry construction while still exercising the real palette. */
function fakeMaterials(extra: MaterialDef[]): ContentService["materials"] {
  const byName = new Map<string, MaterialDef>();
  for (const m of content.materials.values()) byName.set(m.name, m);
  for (const m of extra) byName.set(m.name, m);
  return {
    get: (id: string) => byName.get(id),
    getOrThrow: (id: string) => {
      const m = byName.get(id);
      if (!m) throw new Error(`no such material '${id}'`);
      return m;
    },
    values: () => byName.values(),
    ids: () => byName.keys(),
    forEach: (fn: (v: MaterialDef) => void) => byName.forEach(fn),
    byTag: () => [],
  } as unknown as ContentService["materials"];
}

Deno.test("T-301: crossCheckDesignLanguage passes on the real content", () => {
  crossCheckDesignLanguage(content); // throws on any violation — reaching here is the pass
});

Deno.test("T-301: throws on an unknown generator", () => {
  const bad = {
    getPalette: () => content.getPalette(),
    materials: content.materials,
    scatter: { values: () => [] },
    procModels: { values: () => [{ id: "broken", generator: "no_such_generator", params: {} }] },
  } as unknown as ContentService;
  assertThrows(() => crossCheckDesignLanguage(bad), Error, "unknown generator");
});

Deno.test("T-301: throws on a scatter referencing an unknown material", () => {
  const bad = {
    getPalette: () => content.getPalette(),
    materials: content.materials,
    procModels: { values: () => [] },
    scatter: { values: () => [{ id: "bad_scatter", material: "no_such_material", procModel: "oak" }] },
  } as unknown as ContentService;
  assertThrows(() => crossCheckDesignLanguage(bad), Error, "unknown material");
});

Deno.test("T-301: throws when a procModel's base params put a signal hue on structural mass", () => {
  // A rogue material whose color happens to resolve to the reserved "blood"
  // swatch, WITHOUT being tagged "decal" or designated a signal material via
  // palette.materials — the genuine violation this check exists to catch
  // (ordinary palette auto-snap can never produce this; only a bad override
  // or a hand-set literal color can).
  const rogueColor = parseInt(content.getPalette().ramp["blood"].replace("#", ""), 16);
  const rogue: MaterialDef = {
    id: 9001, name: "rogue_signal_solid", color: rogueColor, roughness: 0.5, metallic: 0, emissive: 0,
    solid: true, walkable: true,
    properties: { hardness: 0.5, density: 0.5, flexibility: 0.5, flammability: 0, toughness: 0.5 },
  };
  const bad = {
    getPalette: () => content.getPalette(),
    materials: fakeMaterials([rogue]),
    scatter: { values: () => [] },
    procModels: {
      values: () => [{
        id: "bad_solid",
        generator: "boulder_grammar",
        params: { radiusRange: [1, 2], flatten: 0.5, lumpiness: 0.5, material: "rogue_signal_solid" },
      }],
    },
  } as unknown as ContentService;
  assertThrows(() => crossCheckDesignLanguage(bad), Error, "signal-hue color");
});

Deno.test("T-301: a morphTiers signal-hue material is EXEMPT (the state-ladder escape hatch)", () => {
  // Same "corrupted" reference, but confined to morphTiers (like the real
  // fern.json/oak.json content) — must NOT throw.
  const ok = {
    getPalette: () => content.getPalette(),
    materials: content.materials,
    scatter: { values: () => [] },
    procModels: {
      values: () => [{
        id: "ok_morph",
        generator: "boulder_grammar",
        params: { radiusRange: [1, 2], flatten: 0.5, lumpiness: 0.5, material: "stone" },
        morphTiers: [{ material: "corrupted" }],
      }],
    },
  } as unknown as ContentService;
  crossCheckDesignLanguage(ok); // must not throw
});

Deno.test("T-301: a decal-tagged material is exempt from the signal-hue rule", () => {
  // 'blood' is tagged "decal" and resolves to the reserved 'blood' swatch —
  // exempt because decal materials are never structural mass.
  const bloodMat = content.materials.getOrThrow("blood");
  assert((bloodMat.tags ?? []).includes("decal"), "fixture assumption: blood is tagged decal");
  const ok = {
    getPalette: () => content.getPalette(),
    materials: content.materials,
    scatter: { values: () => [] },
    procModels: {
      values: () => [{
        id: "ok_decal",
        generator: "boulder_grammar",
        params: { radiusRange: [1, 2], flatten: 0.5, lumpiness: 0.5, material: "blood" },
      }],
    },
  } as unknown as ContentService;
  crossCheckDesignLanguage(ok); // must not throw
});

// A purpose-built badly-behaved generator: emits a single voxel floating well
// above the model-space ground plane, to exercise the invariant in isolation
// (every REAL generator today already ground-anchors correctly, so this
// can't be demonstrated by misconfiguring a real one's params).
registerGenerator("__test_floating_blob", (_seed, _params, ctx) => [
  { cx: 0, cy: 0, cz: 5, sx: 1, sy: 1, sz: 1, materialId: ctx.resolveMaterial("stone") },
]);

Deno.test("T-301: a character-class generator emitting off the ground plane throws", () => {
  const bad = {
    getPalette: () => content.getPalette(),
    materials: content.materials,
    scatter: { values: () => [] },
    procModels: {
      values: () => [{
        id: "floating_character",
        generator: "__test_floating_blob",
        class: "character",
        params: {},
      }],
    },
  } as unknown as ContentService;
  assertThrows(() => crossCheckDesignLanguage(bad), Error, "ground plane");
});

Deno.test("T-301: a character-class generator emitting AT the ground plane passes", () => {
  registerGenerator("__test_grounded_blob", (_seed, _params, ctx) => [
    { cx: 0, cy: 0, cz: 0.5, sx: 1, sy: 1, sz: 1, materialId: ctx.resolveMaterial("stone") },
  ]);
  const ok = {
    getPalette: () => content.getPalette(),
    materials: content.materials,
    scatter: { values: () => [] },
    procModels: {
      values: () => [{
        id: "grounded_character",
        generator: "__test_grounded_blob",
        class: "character",
        params: {},
      }],
    },
  } as unknown as ContentService;
  crossCheckDesignLanguage(ok); // must not throw
});

Deno.test("T-302: humanoid_grammar (procmodels/human.json) is a real class:'character' generator and passes the ground-plane check", () => {
  const humanProcModel = content.procModels.get("human");
  assert(humanProcModel, "'human' procModel should exist (T-302)");
  assert(humanProcModel!.class === "character", "'human' should declare class:'character'");
  // crossCheckDesignLanguage() above already ran this generator against the
  // real content and would have thrown if it weren't ground-anchored —
  // reaching here is the pass.
});
