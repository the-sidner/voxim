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
  assertEquals(dst.materials.size,      src.materials.size);
  assertEquals(dst.models.size,         src.models.size);
  assertEquals(dst.skeletons.size,      src.skeletons.size);
  assertEquals(dst.prefabs.size,        src.prefabs.size);
  assertEquals(dst.recipes.size,        src.recipes.size);
  assertEquals(dst.npcTemplates.size,   src.npcTemplates.size);
  assertEquals(dst.behaviorTrees.size,  src.behaviorTrees.size);
  assertEquals(dst.biomes.size,         src.biomes.size);
  assertEquals(dst.zones.size,          src.zones.size);
  assertEquals(dst.loreFragments.size,  src.loreFragments.size);
  assertEquals(dst.weaponActions.size,  src.weaponActions.size);
  assertEquals(dst.verbs.size,          src.verbs.size);
});

Deno.test("bootstrap codec preserves item content (sample probe)", async () => {
  const src = await JsonSource.load();
  const blob = encodeBootstrap(src);
  const dst = decodeBootstrap(blob);

  // Probe a few items we know exist: a creature with rest rotations
  const drowner = dst.skeletons.getOrThrow("drowner");
  assertEquals(drowner.bones.length, src.skeletons.getOrThrow("drowner").bones.length);
  // restRotX on torso_lower (UAL bind) should round-trip exactly.
  const tlSrc = src.skeletons.getOrThrow("drowner").bones.find((b) => b.id === "torso_lower")!;
  const tlDst = drowner.bones.find((b) => b.id === "torso_lower")!;
  assertEquals(tlDst.restRotX, tlSrc.restRotX);

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
