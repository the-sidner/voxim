/**
 * T-323 — the wolf's hittable volume must match its visible body.
 *
 * Integration test (real on-disk content, like registry_smoke.test.ts) rather
 * than a synthetic fixture: the bug this pins is specific to
 * `data/models/wolf.json`'s authored sub-object `hitbox` flags, not to
 * `deriveHitboxTemplate`'s generic logic (already covered by
 * hitbox_derive.test.ts's synthetic-skeleton tests).
 *
 * Root cause (T-323): every wolf sub-object except body+head was authored
 * `"hitbox": false` — legs and tail rendered but had ZERO hittable volume.
 * Fix: every visible wolf sub-object now derives its capsule from its own
 * voxel AABB (the exact geometry the client renders) — the same mechanism
 * body/head already used, so there is no second/parallel size table.
 */
import { assertEquals } from "jsr:@std/assert";
import { JsonSource } from "./loader.ts";

const WOLF_BONES = [
  "body", "head", "tail",
  "fl_upper", "fl_lower", "fr_upper", "fr_lower",
  "rl_upper", "rl_lower", "rr_upper", "rr_lower",
];

Deno.test("wolf hitbox: every visible bone gets a capsule (no silent legs/tail gap)", async () => {
  const store = await JsonSource.load();
  const scale = store.getGameConfig().world.defaultEntityScale * (store.prefabs.getOrThrow("wolf").modelScale ?? 1);
  const template = store.getHitboxTemplate("wolf", 12345, scale);

  const boneIds = template.map((p) => p.boneId).sort();
  assertEquals(boneIds, [...WOLF_BONES].sort());
});

Deno.test("wolf hitbox: capsule radii sit in a sane band relative to the wolf's own voxel geometry (not DEFAULT_BONE_RADIUS=0.20 raw, not zero)", async () => {
  const store = await JsonSource.load();
  const modelScale = store.prefabs.getOrThrow("wolf").modelScale ?? 1;
  const scale = store.getGameConfig().world.defaultEntityScale * modelScale;
  const template = store.getHitboxTemplate("wolf", 12345, scale);

  // Independently compute each part's expected radius straight from its own
  // sub-model's authored voxel AABB (the SAME source deriveHitboxTemplate
  // reads) — proves the capsule radius is honestly geometry-derived, not a
  // hardcoded biped-shaped constant landing on a wolf bone by coincidence.
  const model = store.models.get("wolf")!;
  for (const sub of model.subObjects) {
    const aabb = store.getModelAabb(sub.modelId!)!;
    const extX = aabb.maxX - aabb.minX;
    const extY = aabb.maxY - aabb.minY;
    const extZ = aabb.maxZ - aabb.minZ;
    const exts = [extX, extY, extZ].sort((a, b) => a - b);
    // capsuleFromAabb: radius = max of the two SMALLER extents / 2.
    const expectedRadius = (exts[1] / 2) * scale;

    const part = template.find((p) => p.boneId === sub.boneId)!;
    assertEquals(part !== undefined, true, `no hitbox part for bone '${sub.boneId}'`);
    assertEquals(Math.abs(part.radius - expectedRadius) < 1e-9, true,
      `bone '${sub.boneId}': radius ${part.radius} != expected ${expectedRadius} (derived from '${sub.modelId}' own voxel AABB)`);

    // Sane band: strictly positive, and nowhere near the flat
    // DEFAULT_BONE_RADIUS=0.20 (raw) * scale fallback a biped-keyed table
    // would have produced for every one of these non-biped bone ids.
    assertEquals(part.radius > 0, true);
    const defaultBoneRadiusFallback = 0.20 * scale;
    // At least one real part must clearly diverge from the flat fallback —
    // proves the geometry, not a table lookup, is driving the numbers.
    if (sub.boneId === "body") {
      assertEquals(Math.abs(part.radius - defaultBoneRadiusFallback) > 0.05, true);
    }
  }
});
