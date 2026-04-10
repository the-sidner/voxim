/**
 * HitboxSystem — derives entity-local hitbox capsules from the live animation
 * layer stack each tick.
 *
 * Pipeline per entity:
 *   1. evaluateAnimationLayers → bone rotations (Euler XYZ per bone)
 *   2. solveSkeleton           → bone world transforms (solver space)
 *   3. applyHitboxTemplate     → solver-space → entity-local BodyPartVolume[]
 *   4. dirty check             → world.set only when parts changed
 *
 * Static entities (trees, resources) have no AnimationState and are skipped.
 * Their hitbox is written once at spawn by spawner.ts.
 *
 * Performance optimisations:
 *   - posePool / transformPool: pre-allocated Maps per entity, cleared and
 *     reused each tick (zero hot-path allocation after first evaluation).
 *   - Dirty check: byte-level comparison of new vs existing BodyPartVolume[]
 *     avoids unnecessary deferred writes.
 */
import type { World } from "@voxim/engine";
import type { DeferredEventQueue } from "../deferred_events.ts";
import type { System } from "../system.ts";
import type { ContentStore } from "@voxim/content";
import type { BodyPartVolume } from "@voxim/content";
import type { BoneRotation } from "@voxim/content";
import type { BoneTransform } from "@voxim/content";
import {
  evaluateAnimationLayers,
  solveSkeleton,
  applyHitboxTemplate,
  REST_POSE,
} from "@voxim/content";
import { AnimationState, ModelRef } from "../components/game.ts";
import { Hitbox } from "../components/hitbox.ts";
import type { HitboxData } from "../components/hitbox.ts";

export class HitboxSystem implements System {
  /** Per-entity pooled Maps to avoid per-tick allocation. */
  private readonly posePool      = new Map<string, Map<string, BoneRotation>>();
  private readonly transformPool = new Map<string, Map<string, BoneTransform>>();

  constructor(private readonly content: ContentStore) {}

  prepare(_tick: number): void {}

  run(world: World, _events: DeferredEventQueue, _dt: number): void {
    for (const { entityId, animationState, modelRef } of world.query(AnimationState, ModelRef)) {
      const skeleton = this.content.getSkeletonForModel(modelRef.modelId);
      if (!skeleton) continue;

      const boneIndex    = this.content.getBoneIndex(skeleton.id);
      const clipIndex    = this.content.getClipIndex(skeleton.id);
      const maskIndex    = this.content.getMaskIndex(skeleton.id);
      const template     = this.content.getHitboxTemplate(modelRef.modelId, modelRef.seed, modelRef.scaleX);

      // Get or create pooled maps for this entity.
      let poseMap = this.posePool.get(entityId);
      if (!poseMap) { poseMap = new Map(); this.posePool.set(entityId, poseMap); }
      let transformMap = this.transformPool.get(entityId);
      if (!transformMap) { transformMap = new Map(); this.transformPool.set(entityId, transformMap); }

      // Evaluate animation layer stack → bone rotations.
      const poseRotations = animationState.layers.length > 0
        ? evaluateAnimationLayers(skeleton, clipIndex, maskIndex, animationState.layers, poseMap)
        : REST_POSE;

      // FK solve → bone world transforms.
      const boneTransforms = solveSkeleton(skeleton, boneIndex, poseRotations, modelRef.scaleX, transformMap);

      // Derive hitbox capsules from the template + current pose.
      const parts = applyHitboxTemplate(template, boneTransforms);

      if (parts.length === 0) {
        // No template parts — fall back to rest-pose static hitbox.
        const restTransforms = solveSkeleton(skeleton, boneIndex, REST_POSE, modelRef.scaleX);
        const restParts = applyHitboxTemplate(template, restTransforms);
        if (restParts.length > 0 && !partsEqual(world.get(entityId, Hitbox)?.parts, restParts)) {
          world.set(entityId, Hitbox, { parts: restParts } as HitboxData);
        }
      } else if (!partsEqual(world.get(entityId, Hitbox)?.parts, parts)) {
        world.set(entityId, Hitbox, { parts } as HitboxData);
      }
    }
  }
}

// ---- helpers ----

/** Cheap structural equality check — avoids deferred writes when parts haven't changed. */
function partsEqual(a: BodyPartVolume[] | undefined, b: BodyPartVolume[]): boolean {
  if (!a || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i], bi = b[i];
    if (
      ai.id !== bi.id ||
      Math.abs(ai.fromFwd   - bi.fromFwd)   > 1e-4 ||
      Math.abs(ai.fromRight - bi.fromRight) > 1e-4 ||
      Math.abs(ai.fromUp    - bi.fromUp)    > 1e-4 ||
      Math.abs(ai.toFwd     - bi.toFwd)     > 1e-4 ||
      Math.abs(ai.toRight   - bi.toRight)   > 1e-4 ||
      Math.abs(ai.toUp      - bi.toUp)      > 1e-4 ||
      Math.abs(ai.radius    - bi.radius)    > 1e-4
    ) return false;
  }
  return true;
}
