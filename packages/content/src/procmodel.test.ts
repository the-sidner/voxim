/**
 * Procedural-model content pipeline (T-285a) — the inert foundation: the
 * `procmodels/` + `scatter/` categories load, the loader cross-checks
 * scatter→procModel, and both survive the bootstrap blob round-trip (the wire
 * path the client consumes). The generator-id cross-check is client-side
 * (generators live there) — exercised by the client procmodel test.
 */
import { assert, assertEquals } from "jsr:@std/assert";
import { JsonSource } from "./loader.ts";
import { encodeBootstrap, decodeBootstrap } from "./bootstrap_codec.ts";
import { validateScatterDef, validateProcModelDef } from "./loader.ts";

const content = await JsonSource.load("packages/content/data");

Deno.test("T-285a: the oak procmodel + forest_oak scatter load", () => {
  const oak = content.procModels.get("oak");
  assert(oak, "oak procModel registered");
  assertEquals(oak!.generator, "tree_grammar");

  const forest = content.scatter.get("forest_oak");
  assert(forest, "forest_oak scatter registered");
  assertEquals(forest!.procModel, "oak");
  assertEquals(forest!.kind, 2, "forest boundary kind");
  assertEquals(forest!.pool, 4);
});

Deno.test("T-285a: every scatter references a registered procModel (loader cross-check holds)", () => {
  for (const s of content.scatter.values()) {
    assert(content.procModels.get(s.procModel), `scatter "${s.id}" → procModel "${s.procModel}"`);
  }
});

Deno.test("T-285a: procModels + scatter survive the bootstrap blob round-trip", async () => {
  const blob = await encodeBootstrap(content);
  const decoded = await decodeBootstrap(blob);
  assertEquals(
    [...decoded.procModels.values()].map((p) => p.id).sort(),
    [...content.procModels.values()].map((p) => p.id).sort(),
  );
  assertEquals(
    [...decoded.scatter.values()].map((s) => s.id).sort(),
    [...content.scatter.values()].map((s) => s.id).sort(),
  );
  // The opaque params ride through verbatim.
  assertEquals(decoded.procModels.get("oak")!.params, content.procModels.get("oak")!.params);
});

Deno.test("T-285a: validators reject malformed defs", () => {
  let threw = false;
  try { validateProcModelDef({ id: "x", generator: "", params: {} }); } catch { threw = true; }
  assert(threw, "empty generator rejected");
  threw = false;
  try { validateScatterDef({ id: "y", kind: 2, procModel: "oak", pool: 0, stride: 7, baseScale: 1, scaleJitter: [1, 1], rotate: false }); } catch { threw = true; }
  assert(threw, "pool < 1 rejected");
});
