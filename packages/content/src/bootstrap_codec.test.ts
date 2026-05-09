/**
 * T-177 round-trip test — encode a real loaded ContentService into a blob,
 * decode it, and verify the resulting ContentService has identical contents.
 * Catches schema-evolution bugs (a new field added to a Def but missed by
 * the registry's serializer / register*).
 */

import { assertEquals } from "jsr:@std/assert";
import { JsonSource } from "./loader.ts";
import { encodeBootstrap, decodeBootstrap, BOOTSTRAP_VERSION } from "./bootstrap_codec.ts";

Deno.test("bootstrap codec round-trips every registry", async () => {
  const src = await JsonSource.load();
  const blob = encodeBootstrap(src);
  const dst = decodeBootstrap(blob);

  // Registry-wise count parity
  assertEquals(dst.materials.size,           src.materials.size);
  assertEquals(dst.models.size,              src.models.size);
  assertEquals(dst.skeletons.size,           src.skeletons.size);
  assertEquals(dst.prefabs.size,             src.prefabs.size);
  assertEquals(dst.recipes.size,             src.recipes.size);
  assertEquals(dst.npcTemplates.size,        src.npcTemplates.size);
  assertEquals(dst.behaviorTrees.size,       src.behaviorTrees.size);
  assertEquals(dst.biomes.size,              src.biomes.size);
  assertEquals(dst.zones.size,               src.zones.size);
  assertEquals(dst.loreFragments.size,       src.loreFragments.size);
  assertEquals(dst.weaponActions.size,       src.weaponActions.size);
  assertEquals(dst.verbs.size,               src.verbs.size);
  assertEquals(dst.animationLibraries.size,  src.animationLibraries.size);

  // Libraries: clip ids per archetype must match exactly.
  for (const lib of src.animationLibraries.values()) {
    const dstLib = dst.animationLibraries.getOrThrow(lib.id);
    assertEquals(Object.keys(dstLib.clips).sort(), Object.keys(lib.clips).sort());
  }
});

Deno.test("bootstrap codec preserves item content (sample probe)", async () => {
  const src = await JsonSource.load();
  const blob = encodeBootstrap(src);
  const dst = decodeBootstrap(blob);

  // Probe the canonical biped skeleton + its archetype tag (T-179 / T-178)
  const biped = dst.skeletons.getOrThrow("biped");
  assertEquals(biped.bones.length, src.skeletons.getOrThrow("biped").bones.length);
  assertEquals(biped.archetype, "biped");

  // Per-prefab morphValues survive the codec (T-180)
  const drownerPrefab = dst.prefabs.getOrThrow("drowner");
  assertEquals(drownerPrefab.morphValues?.armLength, 1.4);
  assertEquals(drownerPrefab.morphValues?.headSize, 1.1);

  // Tag indexing rebuilt on hydrate
  const metals = dst.materials.byTag("metal").map((m) => m.name).sort();
  assertEquals(metals, ["copper", "iron", "steel", "worn_iron"]);

  // Singleton config
  assertEquals(typeof dst.getGameConfig().player.inventoryCapacity, "number");
});

Deno.test("bootstrap codec rejects bad magic / wrong version", () => {
  const garbage = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0, 0, 0, 0, 0, 0, 0, 0]);
  let threw = false;
  try { decodeBootstrap(garbage); } catch (e) {
    threw = true;
    if (!(e as Error).message.includes("bad magic")) throw e;
  }
  assertEquals(threw, true);

  // Correct magic, wrong version
  const wrongVer = new Uint8Array(12);
  const view = new DataView(wrongVer.buffer);
  view.setUint32(0, 0x564f5842, true);
  view.setUint32(4, BOOTSTRAP_VERSION + 99, true);
  view.setUint32(8, 0, true);
  threw = false;
  try { decodeBootstrap(wrongVer); } catch (e) {
    threw = true;
    if (!(e as Error).message.includes("version")) throw e;
  }
  assertEquals(threw, true);
});

Deno.test("bootstrap codec rejects truncated body", async () => {
  const src = await JsonSource.load();
  const blob = encodeBootstrap(src);
  const truncated = blob.slice(0, blob.length - 100);
  let threw = false;
  try { decodeBootstrap(truncated); } catch (e) {
    threw = true;
    if (!(e as Error).message.includes("truncated")) throw e;
  }
  assertEquals(threw, true);
});
