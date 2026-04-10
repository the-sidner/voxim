/**
 * AnimationSystem — two responsibilities:
 *
 * 1. Derive AnimationState from observable entity state each tick (unchanged).
 *    Rules (highest priority first):
 *      death  — Health.current <= 0
 *      attack — SkillInProgress present
 *      walk   — velocity magnitude > threshold
 *      idle   — otherwise
 *
 * 2. Update arm capsule positions in the entity's Hitbox component each tick.
 *    Parts with boneId in ARM_BONE_IDS are recomputed:
 *      - During attacks: IK-driven from weapon swing path (same IK solver the client uses)
 *      - Otherwise:      rest-pose (static, accumulated from skeleton rest offsets)
 *    All other parts (spine, head, legs) are left untouched — they are written once
 *    at spawn and remain entity-local until the locomotion FK task.
 */
import type { World } from "@voxim/engine";
import type { DeferredEventQueue } from "../deferred_events.ts";
import type { System } from "../system.ts";
import type { ContentStore, SkeletonDef } from "@voxim/content";
import type { AnimationMode, AnimationStateData } from "@voxim/content";
import { evaluateSwingPath, deriveTip } from "@voxim/content";
import { solveTwoBoneIK, quatFromEulerXYZ, applyQuat } from "@voxim/content";
import type { Vec3 } from "@voxim/content";
import { ACTION_CROUCH, hasAction } from "@voxim/protocol";
import { Velocity, Health, SkillInProgress, AnimationState, ModelRef, InputState } from "../components/game.ts";
import type { SkillInProgressData } from "../components/game.ts";
import { Hitbox } from "../components/hitbox.ts";
import type { HitboxData } from "../components/hitbox.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("AnimationSystem");

const WALK_THRESHOLD_SQ = 0.01;

/** Arm bone IDs managed by this system. All other boneId values are left static. */
const ARM_BONE_IDS = new Set(["upper_arm_l", "lower_arm_l", "upper_arm_r", "lower_arm_r"]);

/**
 * Arm bone length in entity-local units.
 * skeleton restZ = 2, model scale = 0.35 → 2 × 0.35 = 0.70
 */
const ARM_BONE_LEN = 0.70;

export class AnimationSystem implements System {
  constructor(private readonly content: ContentStore) {}

  prepare(_tick: number): void {}

  run(world: World, _events: DeferredEventQueue, _dt: number): void {
    for (const { entityId, velocity } of world.query(Velocity, AnimationState)) {
      const health = world.get(entityId, Health);
      if (health && health.current <= 0) {
        this.setAnimState(world, entityId, "death", null);
        this.updateArmHitboxes(world, entityId, null, 0);
        continue;
      }

      const sip = world.get(entityId, SkillInProgress);
      if (sip) {
        const next = this.setAnimState(world, entityId, "attack", sip);
        this.updateArmHitboxes(world, entityId, sip, next?.ticksIntoAction ?? 0);
        continue;
      }

      const inputState = world.get(entityId, InputState);
      const crouching = inputState !== null && hasAction(inputState.actions, ACTION_CROUCH);
      const vxSq = velocity.x * velocity.x + velocity.y * velocity.y;
      const moving = vxSq > WALK_THRESHOLD_SQ;

      let mode: "idle" | "walk" | "crouch" | "crouch_walk";
      if (crouching) {
        mode = moving ? "crouch_walk" : "crouch";
      } else {
        mode = moving ? "walk" : "idle";
      }

      this.setAnimState(world, entityId, mode, null);
      this.updateArmHitboxes(world, entityId, null, 0);
    }
  }

  /** Write AnimationState and return the new value. Returns null if unchanged. */
  private setAnimState(
    world: World,
    entityId: string,
    mode: AnimationMode,
    sip: SkillInProgressData | null,
  ): AnimationStateData | null {
    let attackStyle = "";
    let windupTicks = 0;
    let activeTicks = 0;
    let winddownTicks = 0;
    let ticksIntoAction = 0;
    let weaponActionId = "";

    if (mode === "attack" && sip) {
      const action = this.content.getWeaponAction(sip.weaponActionId);
      if (action) {
        weaponActionId = sip.weaponActionId;
        attackStyle = action.animationStyle;
        windupTicks = action.windupTicks;
        activeTicks = action.activeTicks;
        winddownTicks = action.winddownTicks;
        ticksIntoAction = sip.phase === "windup"
          ? sip.ticksInPhase
          : sip.phase === "active"
          ? windupTicks + sip.ticksInPhase
          : windupTicks + activeTicks + sip.ticksInPhase;
      }
    }

    const next: AnimationStateData = {
      mode,
      attackStyle,
      windupTicks,
      activeTicks,
      winddownTicks,
      ticksIntoAction,
      weaponActionId,
    };

    const current = world.get(entityId, AnimationState);
    if (
      current?.mode === next.mode &&
      current.attackStyle === next.attackStyle &&
      current.windupTicks === next.windupTicks &&
      current.activeTicks === next.activeTicks &&
      current.winddownTicks === next.winddownTicks &&
      current.ticksIntoAction === next.ticksIntoAction &&
      current.weaponActionId === next.weaponActionId
    ) return null;

    if (current?.mode !== next.mode) {
      log.debug(
        "mode: entity=%s %s→%s%s",
        entityId,
        current?.mode ?? "none",
        next.mode,
        next.mode === "attack"
          ? ` style=${next.attackStyle} ticks=${next.windupTicks}+${next.activeTicks}+${next.winddownTicks} into=${next.ticksIntoAction}`
          : "",
      );
    }
    world.set(entityId, AnimationState, next);
    return next;
  }

  // ── Arm hitbox update ───────────────────────────────────────────────────────

  private updateArmHitboxes(
    world: World,
    entityId: string,
    sip: SkillInProgressData | null,
    ticksIntoAction: number,
  ): void {
    const hitbox = world.get(entityId, Hitbox);
    if (!hitbox) return;

    // Only process if any parts use arm bones
    if (!hitbox.parts.some((p) => p.boneId && ARM_BONE_IDS.has(p.boneId))) return;

    const modelRef = world.get(entityId, ModelRef);
    if (!modelRef) return;

    const skeleton = this.content.getSkeletonForModel(modelRef.modelId);
    if (!skeleton) return;

    const scale = modelRef.scaleX;

    // Pre-compute IK results for left and right arms if attacking
    let ikL: ArmIKResult | null = null;
    let ikR: ArmIKResult | null = null;

    if (sip) {
      const action = this.content.getWeaponAction(sip.weaponActionId);
      if (action?.ikTargets) {
        const totalTicks = action.windupTicks + action.activeTicks + action.winddownTicks;
        const t = totalTicks > 0 ? Math.min(ticksIntoAction / totalTicks, 1.0) : 1.0;
        const swing = evaluateSwingPath(action.swingPath.keyframes, t);

        for (const ik of action.ikTargets) {
          const side = ik.chain[0].endsWith("_l") ? "l" : "r";

          // IK target in entity-local (fwd, right, up)
          const srcLocal = ik.source === "hilt"
            ? swing.hilt
            : deriveTip(swing.hilt, swing.bladeDir, 1.0);

          // Shoulder world position in entity-local
          const shoulder = boneWorldPos(`upper_arm_${side}`, skeleton, scale);

          // Convert IK target and shoulder to solver space (x=right, y=up, z=−fwd)
          // then compute target relative to shoulder
          const targetSolver: Vec3 = {
            x: srcLocal.right - shoulder.right,
            y: srcLocal.up    - shoulder.up,
            z: -(srcLocal.fwd - shoulder.fwd),
          };
          const poleSolver: Vec3 = {
            x: ik.poleHint.right,
            y: ik.poleHint.up,
            z: -ik.poleHint.fwd,
          };

          const { rotA, rotB } = solveTwoBoneIK(
            ARM_BONE_LEN,
            ARM_BONE_LEN,
            targetSolver,
            poleSolver,
          );

          // Elbow position: apply rotA to rest-down (0,−1,0) → elbowDir, then scale by boneLen
          const qA = quatFromEulerXYZ(rotA.x, rotA.y, rotA.z);
          const elbowDirSolver = applyQuat({ x: 0, y: -1, z: 0 }, qA);
          const elbowSolver: Vec3 = {
            x: elbowDirSolver.x * ARM_BONE_LEN,
            y: elbowDirSolver.y * ARM_BONE_LEN,
            z: elbowDirSolver.z * ARM_BONE_LEN,
          };

          // Wrist position: apply rotB (in bone B local space) to rest-down, transform back
          const qB = quatFromEulerXYZ(rotB.x, rotB.y, rotB.z);
          // wristDir in bone A local space = applyQuat(applyQuat(restDown, qB), qA)
          const wristDirBLocal = applyQuat({ x: 0, y: -1, z: 0 }, qB);
          const wristDirSolver = applyQuat(wristDirBLocal, qA);
          const wristSolver: Vec3 = {
            x: elbowSolver.x + wristDirSolver.x * ARM_BONE_LEN,
            y: elbowSolver.y + wristDirSolver.y * ARM_BONE_LEN,
            z: elbowSolver.z + wristDirSolver.z * ARM_BONE_LEN,
          };

          // Convert back to entity-local relative to entity origin (add shoulder offset)
          const elbow = solverToEntityLocal(elbowSolver, shoulder);
          const wrist = solverToEntityLocal(wristSolver, shoulder);

          const result: ArmIKResult = { shoulder, elbow, wrist };
          if (side === "l") ikL = result;
          else ikR = result;
        }
      }
    }

    // Update each arm part
    let changed = false;
    const updatedParts = hitbox.parts.map((part) => {
      if (!part.boneId || !ARM_BONE_IDS.has(part.boneId)) return part;

      const side = part.boneId.endsWith("_l") ? "l" : "r";
      const isUpper = part.boneId.startsWith("upper_arm");
      const ikResult = side === "l" ? ikL : ikR;

      let fromPos: { fwd: number; right: number; up: number };
      let toPos:   { fwd: number; right: number; up: number };

      if (ikResult) {
        if (isUpper) {
          fromPos = ikResult.shoulder;
          toPos   = ikResult.elbow;
        } else {
          fromPos = ikResult.elbow;
          toPos   = ikResult.wrist;
        }
      } else {
        // Rest pose: bone world position from accumulated rest offsets
        const bonePos = boneWorldPos(part.boneId, skeleton, scale);
        fromPos = bonePos;
        toPos   = { fwd: bonePos.fwd, right: bonePos.right, up: bonePos.up - ARM_BONE_LEN };
      }

      if (
        part.fromFwd   !== fromPos.fwd   || part.fromRight !== fromPos.right ||
        part.fromUp    !== fromPos.up    || part.toFwd     !== toPos.fwd     ||
        part.toRight   !== toPos.right   || part.toUp      !== toPos.up
      ) {
        changed = true;
        return {
          ...part,
          fromFwd:   fromPos.fwd,   fromRight: fromPos.right, fromUp:  fromPos.up,
          toFwd:     toPos.fwd,     toRight:   toPos.right,   toUp:    toPos.up,
        };
      }
      return part;
    });

    if (changed) {
      world.set(entityId, Hitbox, { parts: updatedParts } as HitboxData);
    }
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

interface ArmIKResult {
  shoulder: { fwd: number; right: number; up: number };
  elbow:    { fwd: number; right: number; up: number };
  wrist:    { fwd: number; right: number; up: number };
}

/**
 * Accumulate rest-pose bone position in entity-local (fwd, right, up) space.
 * Walks the parent chain from the named bone to the root, summing rest offsets.
 * BoneDef rest coords: restX = right, restY = fwd, restZ = up.
 */
function boneWorldPos(
  boneId: string,
  skeleton: SkeletonDef,
  scale: number,
): { fwd: number; right: number; up: number } {
  let fwd = 0, right = 0, up = 0;
  let current: string | null = boneId;
  while (current !== null) {
    const bone = skeleton.bones.find((b) => b.id === current);
    if (!bone) break;
    right += bone.restX * scale;
    fwd   += bone.restY * scale;
    up    += bone.restZ * scale;
    current = bone.parent;
  }
  return { fwd, right, up };
}

/**
 * Convert a position from solver space (x=right, y=up, z=−fwd) relative to shoulder
 * back into entity-local (fwd, right, up) absolute position.
 */
function solverToEntityLocal(
  solverRelative: Vec3,
  shoulder: { fwd: number; right: number; up: number },
): { fwd: number; right: number; up: number } {
  return {
    fwd:   shoulder.fwd   + (-solverRelative.z),
    right: shoulder.right +   solverRelative.x,
    up:    shoulder.up    +   solverRelative.y,
  };
}
