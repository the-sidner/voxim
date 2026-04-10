/**
 * Hitbox template derivation and application.
 *
 * Two-step pipeline:
 *   1. deriveHitboxTemplate — at spawn (or cached): converts a model's sub-objects
 *      into bone-local capsule templates in solver space. No live animation data
 *      required — the bone offset is intentionally NOT accumulated here.
 *   2. applyHitboxTemplate — every tick (for animated entities) or once (for
 *      static entities): applies live bone world transforms to produce entity-local
 *      BodyPartVolume capsules ready for hit detection.
 *
 * This file is the ONLY place in the codebase that converts solver-space
 * coordinates (x=right, y=up, z=-fwd) to entity-local (right=X, fwd=Y, up=Z).
 * All upstream math (solveSkeleton, computeHumanPose, applyQuat) stays in
 * solver space. The outbound conversion happens once, at the bottom of
 * applyHitboxTemplate.
 *
 * PRNG ordering contract: the hitbox !== false check happens AFTER the
 * probability draw and pool-selection draw so the seed sequence stays in sync
 * with resolveSubObjects and the hitbox covers the same sub-objects that the
 * client renders.
 *
 * Entity-local coordinate system: right=X, fwd=Y, up=Z.
 * Solver space: x=right, y=up, z=-fwd.
 * Sub-model AABB voxel coordinates use entity-local convention.
 */
import type { BodyPartVolume, Hitbox, SubObjectRef } from "./types.ts";
import type { ContentStore } from "./store.ts";
import type { BoneTransform } from "./skeleton_solver.ts";
import { quatFromEulerXYZ, applyQuat } from "./ik_solver.ts";
import type { Quat } from "./ik_solver.ts";

/** Minimum capsule radius in voxel units. Parts below this threshold are skipped. */
const MIN_RADIUS_VOXELS = 0.1;

const IDENTITY_QUAT: Quat = { x: 0, y: 0, z: 0, w: 1 };

// ── PRNG (mulberry32 — identical to store.ts; kept local to avoid private dep) ──

function makePrng(seed: number): () => number {
  let s = seed >>> 0;
  return (): number => {
    s = (s + 0x6D2B79F5) >>> 0;
    let z = Math.imul(s ^ (s >>> 15), 1 | s);
    z = (z + Math.imul(z ^ (z >>> 7), 61 | z)) ^ z;
    return ((z ^ (z >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Geometry helpers ─────────────────────────────────────────────────────────

interface Vec3Local { x: number; y: number; z: number }

interface CapsuleLocal {
  p1: Vec3Local;
  p2: Vec3Local;
  radius: number; // voxel units
}

/** Derive a capsule from an AABB. Returns null for degenerate shapes. */
function capsuleFromAabb(aabb: Hitbox): CapsuleLocal | null {
  const { minX, minY, minZ, maxX, maxY, maxZ } = aabb;
  const extX = maxX - minX;
  const extY = maxY - minY;
  const extZ = maxZ - minZ;
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const cz = (minZ + maxZ) / 2;

  let hl: number;
  let radius: number;
  let p1: Vec3Local;
  let p2: Vec3Local;

  if (extX >= extY && extX >= extZ) {
    hl = extX / 2;
    radius = Math.max(extY, extZ) / 2;
    p1 = { x: cx - hl, y: cy, z: cz };
    p2 = { x: cx + hl, y: cy, z: cz };
  } else if (extY >= extX && extY >= extZ) {
    hl = extY / 2;
    radius = Math.max(extX, extZ) / 2;
    p1 = { x: cx, y: cy - hl, z: cz };
    p2 = { x: cx, y: cy + hl, z: cz };
  } else {
    hl = extZ / 2;
    radius = Math.max(extX, extY) / 2;
    p1 = { x: cx, y: cy, z: cz - hl };
    p2 = { x: cx, y: cy, z: cz + hl };
  }

  if (radius < MIN_RADIUS_VOXELS) return null;
  return { p1, p2, radius };
}

/**
 * Apply sub-object rotation + translation in entity-local space,
 * then convert the result from entity-local to solver space.
 *
 * Entity-local: right=x, fwd=y, up=z
 * Solver space:  x=right, y=up, z=-fwd
 */
function transformToSolver(
  p: Vec3Local,
  transform: SubObjectRef["transform"],
): Vec3Local {
  const q = quatFromEulerXYZ(transform.rotX, transform.rotY, transform.rotZ);
  const r = applyQuat(p, q);
  // Apply translation (entity-local)
  const ex = r.x + transform.x;
  const ey = r.y + transform.y;
  const ez = r.z + transform.z;
  // Convert entity-local → solver: sx=right=ex, sy=up=ez, sz=-fwd=-ey
  return { x: ex, y: ez, z: -ey };
}

// ── Public types and API ──────────────────────────────────────────────────────

/**
 * Capsule geometry in bone-local solver space (x=right, y=up, z=-fwd).
 * Both endpoints are relative to the bone's origin (from solveSkeleton).
 * For boneId=null, endpoints are relative to the entity origin.
 */
export interface HitboxPartTemplate {
  id: string;
  /** Bone this part is relative to. Null for root/entity-origin-relative. */
  boneId: string | null;
  fromX: number; fromY: number; fromZ: number; // solver space, bone-local
  toX:   number; toY:   number; toZ:   number; // solver space, bone-local
  radius: number;                               // world units (already scaled)
}

/**
 * Derive bone-local capsule templates for a model at spawn/cache time.
 *
 * The bone rest-pose offset is NOT accumulated here — it is applied dynamically
 * by applyHitboxTemplate using live bone world transforms from solveSkeleton.
 *
 * @param modelId  Root model to derive hitbox for.
 * @param seed     Procedural seed — must match ModelRef.seed for this entity.
 * @param content  ContentStore for model lookups.
 * @param scale    Uniform entity scale (e.g. 0.35). Converts voxel units to world units.
 */
export function deriveHitboxTemplate(
  modelId: string,
  seed: number,
  content: ContentStore,
  scale: number,
): HitboxPartTemplate[] {
  const model = content.getModel(modelId);
  if (!model) return [];

  // Leaf model — no sub-objects, fall back to voxel-derived AABB
  if (!model.subObjects || model.subObjects.length === 0) {
    const aabb = content.getModelAabb(modelId);
    if (!aabb) return [];
    return fallbackFromAabb(aabb, modelId, scale);
  }

  const rand = makePrng(seed);
  const parts: HitboxPartTemplate[] = [];

  for (const sub of model.subObjects) {
    // ── Reproduce resolveSubObjects PRNG consumption ─────────────────────────
    const prob = sub.probability ?? 1.0;
    const probRoll = prob < 1.0 ? rand() : 0;
    if (prob < 1.0 && probRoll >= prob) continue;

    let subModelId: string | undefined;
    if (sub.pool && sub.pool.length > 0) {
      subModelId = sub.pool[Math.floor(rand() * sub.pool.length)];
    } else {
      subModelId = sub.modelId;
    }
    if (!subModelId) continue;

    // ── Opt-out check — AFTER PRNG consumption ───────────────────────────────
    if (sub.hitbox === false) continue;

    const subAabb = content.getModelAabb(subModelId);
    if (!subAabb) continue;

    const capsule = capsuleFromAabb(subAabb);
    if (!capsule) continue;

    // Apply sub-object transform (entity-local) then convert to solver space.
    // The bone rest offset is NOT added here — applyHitboxTemplate handles that.
    const sp1 = transformToSolver(capsule.p1, sub.transform);
    const sp2 = transformToSolver(capsule.p2, sub.transform);

    parts.push({
      id: subModelId,
      boneId: sub.boneId ?? null,
      fromX: sp1.x * scale, fromY: sp1.y * scale, fromZ: sp1.z * scale,
      toX:   sp2.x * scale, toY:   sp2.y * scale, toZ:   sp2.z * scale,
      radius: capsule.radius * scale,
    });
  }

  if (parts.length === 0) {
    const rootAabb = content.getModelAabb(modelId);
    if (!rootAabb) return [];
    return fallbackFromAabb(rootAabb, modelId, scale);
  }
  return parts;
}

/**
 * Apply bone world transforms to a hitbox template, producing entity-local
 * BodyPartVolume capsules ready for hit detection and network transmission.
 *
 * This is the SINGLE place in the codebase that converts solver-space
 * coordinates to entity-local. All upstream math stays in solver space.
 *
 * For each part:
 *   1. Look up bone transform (solver-space position + orientation).
 *      If boneId is null, identity transform at origin is used.
 *   2. Rotate bone-local endpoint by the bone's orientation quaternion.
 *   3. Add the bone's world position (both in solver space).
 *   4. Convert resulting solver-space absolute position to entity-local:
 *        right = x,  fwd = -z,  up = y
 */
export function applyHitboxTemplate(
  template: HitboxPartTemplate[],
  boneTransforms: ReadonlyMap<string, BoneTransform>,
): BodyPartVolume[] {
  const parts: BodyPartVolume[] = [];

  for (const t of template) {
    const bt = t.boneId !== null ? boneTransforms.get(t.boneId) : undefined;
    const bonePos = bt?.pos ?? { x: 0, y: 0, z: 0 };
    const boneRot: Quat = bt?.rot ?? IDENTITY_QUAT;

    // Rotate bone-local endpoints by bone orientation (solver space)
    const rf = applyQuat({ x: t.fromX, y: t.fromY, z: t.fromZ }, boneRot);
    const rt = applyQuat({ x: t.toX,   y: t.toY,   z: t.toZ   }, boneRot);

    // Add bone world position → absolute solver-space positions
    const af = { x: rf.x + bonePos.x, y: rf.y + bonePos.y, z: rf.z + bonePos.z };
    const at = { x: rt.x + bonePos.x, y: rt.y + bonePos.y, z: rt.z + bonePos.z };

    // Convert solver-space → entity-local: right=x, fwd=-z, up=y
    parts.push({
      id: t.id,
      fromRight: af.x, fromFwd: -af.z, fromUp: af.y,
      toRight:   at.x, toFwd:  -at.z,  toUp:  at.y,
      radius: t.radius,
    });
  }

  return parts;
}

// ── private helpers ───────────────────────────────────────────────────────────

function fallbackFromAabb(aabb: Hitbox, id: string, scale: number): HitboxPartTemplate[] {
  const capsule = capsuleFromAabb(aabb);
  if (!capsule) return [];
  // Fallback: entity-local axis-aligned capsule, convert to solver space.
  // Entity-local AABB: x=right, y=fwd, z=up → solver: x=right, y=up, z=-fwd
  const sp1 = { x: capsule.p1.x, y: capsule.p1.z, z: -capsule.p1.y };
  const sp2 = { x: capsule.p2.x, y: capsule.p2.z, z: -capsule.p2.y };
  return [{
    id,
    boneId: null,
    fromX: sp1.x * scale, fromY: sp1.y * scale, fromZ: sp1.z * scale,
    toX:   sp2.x * scale, toY:   sp2.y * scale, toZ:   sp2.z * scale,
    radius: capsule.radius * scale,
  }];
}
