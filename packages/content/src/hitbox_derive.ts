/**
 * deriveHitboxParts — auto-derive BodyPartVolume capsules from a model's
 * sub-objects at spawn time.
 *
 * Rules:
 *   - For each resolved sub-object (hitbox !== false): derive one capsule from
 *     the sub-model's AABB. The longest axis becomes the capsule axis; the
 *     largest of the other two half-extents becomes the radius.
 *   - Sub-object transform (translation + Euler XYZ rotation) is applied to
 *     the capsule endpoints to place them in parent space.
 *   - Bone-driven sub-objects (boneId set) get an additional rest-pose offset
 *     accumulated from the skeleton hierarchy.
 *   - If a sub-model's AABB produces radius < MIN_RADIUS_VOXELS the part is
 *     silently skipped (degenerate shape, useless for hit detection).
 *   - If a model has no sub-objects the model's own AABB is used as a single
 *     fallback capsule.
 *
 * PRNG ordering contract: the hitbox !== false check happens AFTER the
 * probability draw and pool-selection draw so the seed sequence stays in sync
 * with resolveSubObjects and the hitbox covers the same sub-objects that the
 * client renders.
 *
 * Entity-local coordinate system: fwd=Y, right=X, up=Z.
 * AABB voxel coordinates use the same convention.
 */
import type { BodyPartVolume, ModelDefinition, SubObjectRef, SkeletonDef } from "./types.ts";
import type { ContentStore } from "./store.ts";
import { quatFromEulerXYZ, applyQuat } from "./ik_solver.ts";

/** Minimum capsule radius in voxel units. Parts below this threshold are skipped. */
const MIN_RADIUS_VOXELS = 0.1;

// ── PRNG (mulberry32 — identical to store.ts; kept local so this module has no
//    dependency on the private implementation in store.ts) ────────────────────

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

interface LocalPt { x: number; y: number; z: number }

interface CapsuleLocal {
  p1: LocalPt;
  p2: LocalPt;
  radius: number; // voxel units
}

/** Derive a capsule from a model's AABB. Returns null for degenerate shapes. */
function capsuleFromModel(model: ModelDefinition): CapsuleLocal | null {
  const { minX, minY, minZ, maxX, maxY, maxZ } = model.hitbox;
  const extX = maxX - minX;
  const extY = maxY - minY;
  const extZ = maxZ - minZ;
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const cz = (minZ + maxZ) / 2;

  let hl: number;
  let radius: number;
  let p1: LocalPt;
  let p2: LocalPt;

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

/** Apply a sub-object's rotation + translation (+ optional bone offset) to a point. */
function transformPoint(
  p: LocalPt,
  transform: SubObjectRef["transform"],
  boneOffset: LocalPt,
): LocalPt {
  const q = quatFromEulerXYZ(transform.rotX, transform.rotY, transform.rotZ);
  const r = applyQuat(p, q);
  return {
    x: r.x + transform.x + boneOffset.x,
    y: r.y + transform.y + boneOffset.y,
    z: r.z + transform.z + boneOffset.z,
  };
}

/**
 * Walk the skeleton hierarchy to accumulate the rest-pose position of a bone
 * in entity-local (parent-model) space.
 *
 * NOTE: BoneDef only stores rest translation (restX/Y/Z), not rest rotation.
 * If bones ever gain rest rotations this accumulation would need to compose
 * quaternions instead.
 */
function boneRestPos(boneId: string, skeleton: SkeletonDef): LocalPt {
  const boneMap = new Map(skeleton.bones.map((b) => [b.id, b]));
  let x = 0, y = 0, z = 0;
  let current = boneMap.get(boneId);
  while (current) {
    x += current.restX;
    y += current.restY;
    z += current.restZ;
    current = current.parent ? boneMap.get(current.parent) : undefined;
  }
  return { x, y, z };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Auto-derive BodyPartVolume capsules for a model at spawn time.
 *
 * @param modelId  Root model to derive hitbox for.
 * @param seed     Procedural seed — must match ModelRef.seed for this entity.
 * @param content  ContentStore for model and skeleton lookups.
 * @param scale    Uniform entity scale (e.g. 0.35). Converts voxel units to
 *                 entity-local units.
 */
export function deriveHitboxParts(
  modelId: string,
  seed: number,
  content: ContentStore,
  scale: number,
): BodyPartVolume[] {
  const model = content.getModel(modelId);
  if (!model) return [];

  // Leaf model — no sub-objects, fall back to top-level AABB
  if (!model.subObjects || model.subObjects.length === 0) {
    return fallbackFromAabb(model, modelId, scale);
  }

  const skeleton = content.getSkeletonForModel(modelId);
  const rand = makePrng(seed);
  const parts: BodyPartVolume[] = [];

  for (const sub of model.subObjects) {
    // ── Reproduce resolveSubObjects PRNG consumption ─────────────────────────
    // Probability draw (consumed even if we skip this sub-object for hitbox)
    const prob = sub.probability ?? 1.0;
    const probRoll = prob < 1.0 ? rand() : 0; // consume RNG only when needed
    if (prob < 1.0 && probRoll >= prob) continue;

    // Pool selection draw
    let subModelId: string | undefined;
    if (sub.pool && sub.pool.length > 0) {
      subModelId = sub.pool[Math.floor(rand() * sub.pool.length)];
    } else {
      subModelId = sub.modelId;
    }
    if (!subModelId) continue;

    // ── Opt-out check — AFTER PRNG consumption ───────────────────────────────
    if (sub.hitbox === false) continue;

    const subModel = content.getModel(subModelId);
    if (!subModel) continue;

    const capsule = capsuleFromModel(subModel);
    if (!capsule) continue; // degenerate AABB (zero radius)

    const boneOffset: LocalPt = (sub.boneId && skeleton)
      ? boneRestPos(sub.boneId, skeleton)
      : { x: 0, y: 0, z: 0 };

    const tp1 = transformPoint(capsule.p1, sub.transform, boneOffset);
    const tp2 = transformPoint(capsule.p2, sub.transform, boneOffset);

    parts.push({
      id: subModelId,
      // boneId intentionally absent — position is entity-local, not bone-local
      fromRight: tp1.x * scale,
      fromFwd:   tp1.y * scale,
      fromUp:    tp1.z * scale,
      toRight:   tp2.x * scale,
      toFwd:     tp2.y * scale,
      toUp:      tp2.z * scale,
      radius:    capsule.radius * scale,
    });
  }

  if (parts.length === 0) {
    return fallbackFromAabb(model, modelId, scale);
  }
  return parts;
}

function fallbackFromAabb(model: ModelDefinition, id: string, scale: number): BodyPartVolume[] {
  const capsule = capsuleFromModel(model);
  if (!capsule) return [];
  return [{
    id,
    fromRight: capsule.p1.x * scale,
    fromFwd:   capsule.p1.y * scale,
    fromUp:    capsule.p1.z * scale,
    toRight:   capsule.p2.x * scale,
    toFwd:     capsule.p2.y * scale,
    toUp:      capsule.p2.z * scale,
    radius:    capsule.radius * scale,
  }];
}
