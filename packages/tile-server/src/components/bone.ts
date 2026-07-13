import { defineComponent } from "@voxim/engine";
import { ComponentType } from "@voxim/protocol";
import { boneCodec } from "@voxim/codecs";
import type { BoneData } from "@voxim/codecs";

export type { BoneData };

/**
 * One entity per skeleton bone (T-219). Spawned at skeletal-installer time
 * (spawner.ts's installSkeletonBones), parented via the scene graph
 * (world.setParent) into a chain that mirrors the owning SkeletonDef.bones
 * hierarchy exactly.
 *
 * Deliberately minimal: `boneId` is the only field. `parentBoneId` and
 * `restPose` are NOT stored here — they're already content data
 * (SkeletonDef.bones, keyed by boneId), and the parent-bone ENTITY
 * relationship is the engine's own `Parent` component, replicated
 * alongside this one. Bone TRANSFORMS are never wired at all: motion is
 * derived client-side from AnimationState (already on the wire), exactly
 * as the pre-T-219 boneGroups pipeline already computed it. Structure
 * ships once at spawn; movement is never re-sent.
 */
export const Bone = defineComponent({
  name: "bone" as const,
  wireId: ComponentType.bone,
  codec: boneCodec,
  default: (): BoneData => ({ boneId: "" }),
});
