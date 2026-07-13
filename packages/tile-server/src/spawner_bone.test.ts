/**
 * T-219 — the scene probe: skeletal spawns produce one real ECS entity per
 * skeleton bone, scene-graph parented to mirror the SkeletonDef hierarchy,
 * and equipped starter gear attaches to the correct bone (or falls back to
 * the holder root when the holder's skeleton has no matching bone — a
 * wolf's bite has nowhere to hold "in hand").
 */

import { assert, assertEquals } from "jsr:@std/assert";
import { World } from "@voxim/engine";
import { JsonSource } from "@voxim/content";
import { spawnPrefab, findBoneEntity } from "./spawner.ts";
import { Equipment } from "./components/equipment.ts";
import { Bone } from "./components/bone.ts";

const content = await JsonSource.load();

Deno.test("T-219: a skeletal NPC (bandit, biped) spawns one bone entity per SkeletonDef.bones, correctly parented", () => {
  const world = new World();
  const bandit = spawnPrefab(world, content, "bandit", { x: 0, y: 0, z: 0 });

  const skeleton = content.getSkeletonForModel("biped_skeletal");
  assert(skeleton, "biped_skeletal resolves a skeleton");
  assertEquals(skeleton.bones.length, 17);

  const boneEntities = world.descendants(bandit).filter((d) => world.has(d, Bone));
  assertEquals(boneEntities.length, 17, "one bone entity per SkeletonDef.bones entry");

  // Every bone entity's Bone.boneId is a real bone name, and each is unique.
  const boneIds = new Set(boneEntities.map((d) => world.get(d, Bone)!.boneId));
  assertEquals(boneIds.size, 17);
  for (const bone of skeleton.bones) assert(boneIds.has(bone.id), `missing bone entity for '${bone.id}'`);

  // The root bone's entity parents directly to the character root.
  const rootBoneEntity = boneEntities.find((d) => world.get(d, Bone)!.boneId === "root")!;
  assertEquals(world.getParent(rootBoneEntity), bandit);

  // A non-root bone's entity parents to ITS parent bone's entity (not the
  // character root directly) — reproduces the skeleton's own chain.
  const handRBoneEntity = findBoneEntity(world, bandit, "hand_r");
  assert(handRBoneEntity, "bandit has a hand_r bone entity");
  const lowerArmRBoneEntity = findBoneEntity(world, bandit, "lower_arm_r");
  assert(lowerArmRBoneEntity, "bandit has a lower_arm_r bone entity");
  assertEquals(world.getParent(handRBoneEntity), lowerArmRBoneEntity);
});

Deno.test("T-219/T-220: bandit's starter weapon (single-bone slot) attaches to its hand_r bone entity", () => {
  const world = new World();
  const bandit = spawnPrefab(world, content, "bandit", { x: 0, y: 0, z: 0 });

  const weaponEntity = world.get(bandit, Equipment)?.weapon?.entityId;
  assert(weaponEntity, "bandit spawned with a weapon entity (wooden_sword, per the NPC template)");

  const handRBoneEntity = findBoneEntity(world, bandit, "hand_r");
  assert(handRBoneEntity, "bandit has a hand_r bone entity");
  assertEquals(world.getParent(weaponEntity as string), handRBoneEntity);
});

Deno.test("T-219: a skeletal NPC with no hand-bone naming (wolf) spawns 11 bone entities", () => {
  const world = new World();
  const wolf = spawnPrefab(world, content, "wolf", { x: 0, y: 0, z: 0 });

  const skeleton = content.getSkeletonForModel("wolf");
  assert(skeleton, "wolf model resolves a skeleton");
  assertEquals(skeleton.bones.length, 11);

  const boneEntities = world.descendants(wolf).filter((d) => world.has(d, Bone));
  assertEquals(boneEntities.length, 11);
});

Deno.test("T-219/T-220: resolveAttachParent falls back to the holder root when the skeleton has no matching bone (wolf's fang)", () => {
  const world = new World();
  const wolf = spawnPrefab(world, content, "wolf", { x: 0, y: 0, z: 0 });

  const fangEntity = world.get(wolf, Equipment)?.weapon?.entityId;
  assert(fangEntity, "wolf spawned with a weapon entity (wolf_bite, per the NPC template)");

  // The wolf skeleton has no "hand_r" bone — EQUIP_SLOT_PRIMARY_BONE's
  // weapon->hand_r mapping can't resolve, so the item parents directly to
  // the wolf root itself, not to any bone.
  assert(findBoneEntity(world, wolf, "hand_r") === null, "wolf has no hand_r bone");
  assertEquals(world.getParent(fangEntity as string), wolf);
});
