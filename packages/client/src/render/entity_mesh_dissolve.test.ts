/**
 * Death-dissolve bone-distance helpers (T-311 P5c) — pure, no THREE/WebGL
 * needed. Pins the shape `upgradeToSkeletonModel` relies on to fray a
 * bone-segment sub-object based on how far out on the limb it sits, without
 * ever touching VoxelNode/bone_segment.json.
 */
import { assert, assertEquals } from "jsr:@std/assert";
import type { SkeletonDef } from "@voxim/content";
import { boneSegmentLength, computeBoneDistanceTable } from "./entity_mesh.ts";

function bone(
  id: string,
  parent: string | null,
  restX: number,
  restY: number,
  restZ: number,
): SkeletonDef["bones"][number] {
  return { id, parent, restX, restY, restZ };
}

Deno.test("boneSegmentLength: Euclidean length of the rest offset", () => {
  assertEquals(boneSegmentLength(bone("a", null, 3, 4, 0)), 5);
  assertEquals(boneSegmentLength(bone("a", null, 0, 0, 0)), 0);
});

Deno.test("computeBoneDistanceTable: root bone sits at distance 0", () => {
  const skeleton = { id: "test", bones: [bone("root", null, 0, 0, 1)] } as unknown as SkeletonDef;
  const table = computeBoneDistanceTable(skeleton);
  assertEquals(table.distance.get("root"), 1);
  assertEquals(table.maxDistance, 1);
});

Deno.test("computeBoneDistanceTable: distance accumulates parent-to-child down a chain", () => {
  // root -> torso (len 2) -> arm (len 3) -> hand (len 1): cumulative 2, 5, 6.
  const skeleton = {
    id: "test",
    bones: [
      bone("root", null, 0, 0, 0),
      bone("torso", "root", 0, 0, 2),
      bone("arm", "torso", 3, 0, 0),
      bone("hand", "arm", 0, 1, 0),
    ],
  } as unknown as SkeletonDef;
  const table = computeBoneDistanceTable(skeleton);
  assertEquals(table.distance.get("root"), 0);
  assertEquals(table.distance.get("torso"), 2);
  assertEquals(table.distance.get("arm"), 5);
  assertEquals(table.distance.get("hand"), 6);
  assertEquals(table.maxDistance, 6, "the farthest bone (hand) sets the normalising divisor");
});

Deno.test("computeBoneDistanceTable: two independent limbs both measure from the shared root", () => {
  const skeleton = {
    id: "test",
    bones: [
      bone("root", null, 0, 0, 0),
      bone("arm_l", "root", 2, 0, 0),
      bone("hand_l", "arm_l", 1, 0, 0),
      bone("arm_r", "root", -2, 0, 0),
      bone("hand_r", "arm_r", -3, 0, 0),
    ],
  } as unknown as SkeletonDef;
  const table = computeBoneDistanceTable(skeleton);
  assertEquals(table.distance.get("hand_l"), 3);
  assertEquals(table.distance.get("hand_r"), 5);
  assertEquals(table.maxDistance, 5, "the longer limb (hand_r) sets the divisor, not the first one visited");
  // hand_l's normalised fraction (3/5 = 0.6) sits well inside a typical
  // frayBandWidth's outer band — this is the number resolveFrayCoreness consumes.
  assert((table.distance.get("hand_l")! / table.maxDistance) < 1);
});
