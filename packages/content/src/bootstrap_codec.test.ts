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
  const blob = await encodeBootstrap(src);
  const dst = await decodeBootstrap(blob);

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
  assertEquals(dst.actions.size,             src.actions.size);
  assertEquals(dst.animationLibraries.size,  src.animationLibraries.size);

  // Libraries: clip ids per archetype must match exactly, and the binary
  // anim codec must round-trip every track + keyframe (f32 precision).
  for (const lib of src.animationLibraries.values()) {
    const dstLib = dst.animationLibraries.getOrThrow(lib.id);
    assertEquals(Object.keys(dstLib.clips).sort(), Object.keys(lib.clips).sort());
    for (const [clipId, srcClip] of Object.entries(lib.clips)) {
      const dstClip = dstLib.clips[clipId];
      assertEquals(dstClip.loop, srcClip.loop);
      assertEquals(dstClip.durationSeconds, srcClip.durationSeconds);
      assertEquals(Object.keys(dstClip.tracks).sort(), Object.keys(srcClip.tracks).sort());
      for (const [boneId, srcFrames] of Object.entries(srcClip.tracks)) {
        const dstFrames = dstClip.tracks[boneId];
        assertEquals(dstFrames.length, srcFrames.length);
        // Spot-check first/last keyframe at f32 tolerance.
        const tol = 1e-6;
        for (const idx of [0, srcFrames.length - 1]) {
          if (idx < 0) continue;
          const s = srcFrames[idx], d = dstFrames[idx];
          if (Math.abs(s.time - d.time) > tol) throw new Error(`time drift in ${lib.id}/${clipId}/${boneId}[${idx}]`);
          if (Math.abs(s.rotX - d.rotX) > tol) throw new Error(`rotX drift in ${lib.id}/${clipId}/${boneId}[${idx}]`);
          if (Math.abs(s.rotY - d.rotY) > tol) throw new Error(`rotY drift in ${lib.id}/${clipId}/${boneId}[${idx}]`);
          if (Math.abs(s.rotZ - d.rotZ) > tol) throw new Error(`rotZ drift in ${lib.id}/${clipId}/${boneId}[${idx}]`);
        }
      }
    }
  }
});

Deno.test("bootstrap codec preserves item content (sample probe)", async () => {
  const src = await JsonSource.load();
  const blob = await encodeBootstrap(src);
  const dst = await decodeBootstrap(blob);

  // Probe the canonical biped skeleton + its archetype tag (T-179 / T-178)
  const biped = dst.skeletons.getOrThrow("biped");
  assertEquals(biped.bones.length, src.skeletons.getOrThrow("biped").bones.length);
  assertEquals(biped.archetype, "biped");

  // Per-prefab morphRanges survive the codec (T-180 / T-305 — drowner now
  // jitters around its long-armed identity instead of a fixed body).
  const drownerPrefab = dst.prefabs.getOrThrow("drowner");
  assertEquals(drownerPrefab.morphRanges?.armLength?.min, 1.25);
  assertEquals(drownerPrefab.morphRanges?.armLength?.max, 1.55);

  // Tag indexing rebuilt on hydrate
  const metals = dst.materials.byTag("metal").map((m) => m.name).sort();
  assertEquals(metals, ["copper", "iron", "steel", "worn_iron"]);

  // Singleton config
  assertEquals(typeof dst.getGameConfig().player.inventoryCapacity, "number");
});

Deno.test("bootstrap codec rejects bad magic / wrong version", async () => {
  // Minimum envelope is 16 bytes: magic + version + jsonLen(=0) + animLen(=0).
  const garbage = new Uint8Array(16);
  new DataView(garbage.buffer).setUint32(0, 0xdeadbeef, true);
  let threw = false;
  try { await decodeBootstrap(garbage); } catch (e) {
    threw = true;
    if (!(e as Error).message.includes("bad magic")) throw e;
  }
  assertEquals(threw, true);

  // Correct magic, wrong version
  const wrongVer = new Uint8Array(16);
  const view = new DataView(wrongVer.buffer);
  view.setUint32(0, 0x564f5842, true);
  view.setUint32(4, BOOTSTRAP_VERSION + 99, true);
  view.setUint32(8, 0, true);   // jsonLen
  view.setUint32(12, 0, true);  // animLen
  threw = false;
  try { await decodeBootstrap(wrongVer); } catch (e) {
    threw = true;
    if (!(e as Error).message.includes("version")) throw e;
  }
  assertEquals(threw, true);
});

Deno.test("bootstrap codec rejects truncated body", async () => {
  const src = await JsonSource.load();
  const blob = await encodeBootstrap(src);
  const truncated = blob.slice(0, blob.length - 100);
  let threw = false;
  try { await decodeBootstrap(truncated); } catch (e) {
    threw = true;
    if (!(e as Error).message.includes("truncated")) throw e;
  }
  assertEquals(threw, true);
});
