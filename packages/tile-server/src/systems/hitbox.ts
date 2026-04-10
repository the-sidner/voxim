/**
 * HitboxSystem — derives entity-local hitbox capsules from the live skeleton pose each tick.
 *
 * Query: entities with (AnimationState + ModelRef + Velocity + Facing)
 *
 * Pipeline per entity:
 *   1. Determine skeleton from ModelRef.modelId
 *   2. Dispatch pose computation (computeHumanPose / computeWolfPose) based on skeleton
 *   3. solveSkeleton — FK walk produces bone world transforms (solver space)
 *   4. applyHitboxTemplate — solver-space → entity-local BodyPartVolume[]
 *   5. world.set(entityId, Hitbox, { parts })
 *
 * Static entities (trees, resources) have no AnimationState and are skipped here.
 * Their hitbox is written once at spawn by spawner.ts.
 *
 * Note on tick ordering: world.set() writes are deferred until applyChangeset().
 * ActionSystem always reads Hitbox(N-1). The registration order
 * (AnimationSystem → HitboxSystem → ActionSystem) is for logical clarity.
 */
import type { World } from "@voxim/engine";
import type { DeferredEventQueue } from "../deferred_events.ts";
import type { System } from "../system.ts";
import type { ContentStore } from "@voxim/content";
import {
  computeHumanPose,
  computeWolfPose,
  solveSkeleton,
  applyHitboxTemplate,
  REST_POSE,
} from "@voxim/content";
import type { HumanWeaponData } from "@voxim/content";
import { AnimationState, ModelRef, Velocity, Facing } from "../components/game.ts";
import { Hitbox } from "../components/hitbox.ts";
import type { HitboxData } from "../components/hitbox.ts";

export class HitboxSystem implements System {
  private tick = 0;

  constructor(private readonly content: ContentStore) {}

  prepare(serverTick: number): void {
    this.tick = serverTick;
  }

  run(world: World, _events: DeferredEventQueue, _dt: number): void {
    for (const { entityId, animationState, modelRef, velocity, facing } of world.query(
      AnimationState,
      ModelRef,
      Velocity,
      Facing,
    )) {
      const skeleton = this.content.getSkeletonForModel(modelRef.modelId);
      if (!skeleton) continue; // no skeleton → no skeletal hitbox

      const boneIndex = this.content.getBoneIndex(skeleton.id);
      const template = this.content.getHitboxTemplate(modelRef.modelId, modelRef.seed, modelRef.scaleX);

      // Build weapon data if attacking
      let poseRotations: Map<string, { x: number; y: number; z: number }>;

      if (animationState.mode === "attack" && animationState.weaponActionId) {
        const action = this.content.getWeaponAction(animationState.weaponActionId);
        const weaponData: HumanWeaponData | undefined = action
          ? {
            keyframes: action.swingPath.keyframes,
            ikTargets: action.ikTargets,
            windupTicks: animationState.windupTicks,
            activeTicks: animationState.activeTicks,
            winddownTicks: animationState.winddownTicks,
            ticksIntoAction: animationState.ticksIntoAction,
            bladeLength: action.swingPath.defaultBladeLength,
          }
          : undefined;

        poseRotations = skeleton.id === "wolf"
          ? computeWolfPose(animationState.mode, this.tick, velocity.x, velocity.y, {
            windupTicks: animationState.windupTicks,
            activeTicks: animationState.activeTicks,
            winddownTicks: animationState.winddownTicks,
            ticksIntoAction: animationState.ticksIntoAction,
          })
          : computeHumanPose(animationState.mode, this.tick, velocity.x, velocity.y, facing.angle, weaponData);
      } else if (skeleton.id === "wolf") {
        poseRotations = computeWolfPose(animationState.mode, this.tick, velocity.x, velocity.y);
      } else {
        poseRotations = computeHumanPose(animationState.mode, this.tick, velocity.x, velocity.y, facing.angle);
      }

      const boneTransforms = solveSkeleton(skeleton, boneIndex, poseRotations, modelRef.scaleX);
      const parts = applyHitboxTemplate(template, boneTransforms);

      if (parts.length > 0) {
        world.set(entityId, Hitbox, { parts } as HitboxData);
      } else {
        // No template parts — fall back to REST_POSE static hitbox
        const restTransforms = solveSkeleton(skeleton, boneIndex, REST_POSE, modelRef.scaleX);
        const restParts = applyHitboxTemplate(template, restTransforms);
        if (restParts.length > 0) world.set(entityId, Hitbox, { parts: restParts } as HitboxData);
      }
    }
  }
}
