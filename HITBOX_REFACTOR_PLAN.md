# Hitbox Refactor Plan — Full Skeleton-Driven Hitboxes

## Problem Statement

The server and client are running two separate, diverging representations of the same entity:

- **Client**: Runs a full 3-stage skeleton evaluator (FK → constraint producers → IK) every frame. Bone poses are driven by `AnimationState` + velocity + weapon data. Visually accurate.
- **Server**: Only updates the four arm capsules via IK during attacks. All other parts (head, torso, legs) are baked at spawn from rest-pose bone offsets and never updated. `boneId` is intentionally absent from all parts — the position is entity-local, frozen.

The result: a player crouching on the client is still presented to the server as standing upright. A walking NPC has swinging arms on screen but static legs in the hitbox. This will get worse as more animation modes are added (crouch, injuries, etc.).

The correct model: the **server is authoritative on animation state**, the **client predicts locally**, and the **full skeleton drives all hitboxes** — the same way the client already drives its visual representation.

---

## Target Architecture

### Coordinate systems (fixed, do not change)

| Space | Axes |
|---|---|
| Entity-local / game-world | `fwd = Y`, `right = X`, `up = Z` (bone restX=right, restY=fwd, restZ=up) |
| Solver / Three.js local | `x = right`, `y = up`, `z = -fwd` |

All new math lives in solver space internally; convert at boundaries.

### New shared module: `@voxim/content/src/skeleton_solver.ts`

**Responsibility**: Given a skeleton definition and a pose map (bone → Euler XYZ rotation in solver space), produce the world transform (position + orientation quaternion) for every bone in entity-local space.

```typescript
export interface BoneTransform {
  /** Position in entity-local (fwd, right, up) space — relative to entity origin. */
  pos: { fwd: number; right: number; up: number };
  /** Orientation as unit quaternion (solver-space XYZ convention). */
  rot: { x: number; y: number; z: number; w: number };
}

/** Rest-pose map — all bones at identity rotation. */
export const REST_POSE: Map<string, BoneRotation> = new Map();

/**
 * Walk the skeleton hierarchy (root → leaves) and compute each bone's
 * entity-local position and orientation.
 *
 * poseRotations: bone id → Euler XYZ in solver space (same convention as
 * THREE.Euler default order, same as quatFromEulerXYZ input).
 * Bones absent from poseRotations use identity rotation.
 */
export function solveSkeleton(
  skeleton: SkeletonDef,
  poseRotations: ReadonlyMap<string, BoneRotation>,
  scale: number,
): Map<string, BoneTransform>;
```

**Algorithm** (FK walk, root-first topological order):
```
for each bone (root → leaf order):
  parentTransform = result[bone.parent] ?? { pos: origin, rot: IDENTITY }

  // Rest offset: bone coords are (restX=right, restY=fwd, restZ=up) → solver: (restX, restZ, -restY)
  restOffsetSolver = { x: bone.restX * scale, y: bone.restZ * scale, z: -bone.restY * scale }

  // Rotate rest offset by parent orientation
  rotatedOffset = applyQuat(restOffsetSolver, parentTransform.rot)

  // Bone world position (in solver space)
  bonePosSolver = parentTransform.pos (solver) + rotatedOffset

  // Bone orientation = parent * local
  euler = poseRotations.get(bone.id) ?? ZERO_EULER
  localRot = quatFromEulerXYZ(euler.x, euler.y, euler.z)
  boneRot  = quatMultiply(parentTransform.rot, localRot)

  // Store in entity-local (convert position from solver to entity-local)
  result[bone.id] = {
    pos: { fwd: -bonePosSolver.z, right: bonePosSolver.x, up: bonePosSolver.y },
    rot: boneRot,
  }
```

Export from `@voxim/content/mod.ts`. This module has zero external dependencies (only imports from within `@voxim/content`). Add `quatMultiply` as a private helper.

---

### New shared module: `@voxim/content/src/skeleton_pose.ts`

**Responsibility**: The pure-math pose functions (currently buried in the client's `skeleton_evaluator.ts`) extracted so the server can call them too.

```typescript
/**
 * Compute bone rotations for a given animation state and entity kinematics.
 * Returns a map of bone id → Euler XYZ in solver space.
 * This is the platform-independent core that both the server and client use.
 */
export function computeHumanPose(
  mode: AnimationMode,
  tick: number,
  vx: number,
  vy: number,
  facingAngle: number,
  weaponData?: { keyframes: SwingKeyframe[]; ikTargets?: IKTargetDef[]; windupTicks: number; activeTicks: number; winddownTicks: number; ticksIntoAction: number; bladeLength: number },
): Map<string, BoneRotation>;

export function computeWolfPose(
  mode: AnimationMode,
  tick: number,
  vx: number,
  vy: number,
  weaponData?: { windupTicks: number; activeTicks: number; winddownTicks: number; ticksIntoAction: number },
): Map<string, BoneRotation>;
```

All pose logic moves here verbatim from `skeleton_evaluator.ts`. These functions return plain `BoneRotation = { x, y, z }` — no Three.js types. The IK constraint solving (weapon arm IK) is also done here, outputting the final bone rotations directly rather than producing an intermediate constraint list (the constraint solver is an implementation detail of how you get there, not a public API).

Export from `@voxim/content/mod.ts`.

---

### Refactored: `@voxim/content/src/hitbox_derive.ts`

**New output**: bone-local capsule templates instead of baked entity-local positions.

```typescript
/** Capsule geometry in bone-local space (solver coords: x=right, y=up, z=-fwd). */
export interface HitboxPartTemplate {
  id: string;
  /** Bone this part is relative to. Null for root-relative (no skeleton). */
  boneId: string | null;
  fromX: number; fromY: number; fromZ: number;  // solver space
  toX:   number; toY:   number; toZ:   number;  // solver space
  radius: number;                                 // world units (already scaled)
}

export function deriveHitboxTemplate(
  modelId: string,
  seed: number,
  content: ContentStore,
  scale: number,
): HitboxPartTemplate[];
```

**Key change in algorithm**: The `boneOffset` accumulation is **removed**. Each part stores its geometry relative to its bone's origin (just the sub-object's own transform — position and rotation within the parent model). The `boneId` is always set when a sub-object has one; null when the model has no skeleton.

At runtime the system applies the bone world transform (from `solveSkeleton`) to move parts into entity-local space.

`ContentStore` caches the template per `(modelId, seed)` pair so it is computed at most once per entity.

The old `deriveHitboxParts` function is **deleted**. No compatibility shim.

---

### Refactored: `AnimationSystem`

Returns to its original, single responsibility: derive `AnimationMode` from observable state and write `AnimationState`.

The `updateArmHitboxes` method, `ARM_BONE_IDS`, `ARM_BONE_LEN`, `boneWorldPos`, `solverToEntityLocal`, and `ArmIKResult` are **deleted entirely**. The system no longer touches `Hitbox` at all.

New `run` method:

```
1. For each entity with (Velocity + AnimationState):
   a. Derive AnimationMode from Health / SkillInProgress / InputState (same priority logic)
   b. Write AnimationState if changed (unchanged from today)
```

AnimationSystem imports nothing from `@voxim/content` beyond what it already needs for weapon action lookups. It does not import `solveTwoBoneIK`, `quatFromEulerXYZ`, or `applyQuat`.

---

### New system: `HitboxSystem`

A new system added to the tick order **immediately after AnimationSystem**. Its sole job is: read animation state + kinematics → evaluate skeleton → write Hitbox.

```
Runs after: AnimationSystem
Runs before: ActionSystem (hit detection reads Hitbox)

Query: (AnimationState + ModelRef + Velocity + Facing)

For each matching entity:
  a. Read AnimationState (mode, attackStyle, tick fields) from component
  b. Read velocity and facing from Velocity / Facing components
  c. Look up skeleton from ContentStore via ModelRef.modelId
     → if no skeleton: skip (entity has no skeletal hitbox)
  d. Dispatch to shared pose function:
       skeletonId === "human" → computeHumanPose(mode, tick, vx, vy, facing, weaponData)
       skeletonId === "wolf"  → computeWolfPose(mode, tick, vx, vy, weaponData)
     → Map<boneId, BoneRotation>
  e. solveSkeleton(skeleton, poseMap, scale)
     → Map<boneId, BoneTransform>
  f. getHitboxTemplate(modelId, seed, scale) from ContentStore (cached)
  g. applyHitboxTemplate(template, boneTransforms)
     → BodyPartVolume[]  (entity-local, fully resolved)
  h. world.set(entityId, Hitbox, { parts })
```

HitboxSystem imports: `computeHumanPose`, `computeWolfPose`, `solveSkeleton`, `applyHitboxTemplate` from `@voxim/content`. It does not do any geometry math itself.

System registration in `server.ts` (tick order):
```
... AnimationSystem → HitboxSystem → (ActionSystem already after) ...
```

---

### Refactored: `skeleton_evaluator.ts` (client)

The client evaluator becomes a **thin Three.js rendering wrapper** around the shared modules:

```typescript
export function evaluatePose(
  skeletonId: string,
  mode: AnimationMode,
  // ... same signature ...
): Map<string, THREE.Euler> {
  // 1. Dispatch to shared pose function
  const poseMap = skeletonId === "human"
    ? computeHumanPose(mode, tick, vx, vy, facing, weaponData)
    : computeWolfPose(mode, tick, vx, vy, weaponData);

  // 2. Convert BoneRotation → THREE.Euler for the renderer
  return new Map([...poseMap].map(([k, v]) => [k, new THREE.Euler(v.x, v.y, v.z)]));
}
```

All of the current inline pose functions (`lowerBodyLocomotion`, `upperBodyLocomotion`, `weaponAnimationLayer`, `solveConstraints`, `lowerBodyDeath`, etc.) **move to `skeleton_pose.ts`** and are deleted from `skeleton_evaluator.ts`. The file becomes short.

---

### Refactored: `spawner.ts`

For **static entities** (trees, resources, world objects — no AnimationState):

```typescript
// Instead of deriveHitboxParts (deleted), compute from template + rest pose:
const template = content.getHitboxTemplate(modelId, seed, scale);
const skeleton = content.getSkeletonForModel(modelId);
const boneTransforms = skeleton
  ? solveSkeleton(skeleton, REST_POSE, scale)
  : new Map();
const parts = applyHitboxTemplate(template, boneTransforms);
world.write(id, Hitbox, { parts });
```

For **animated entities** (players, NPCs): do **not** write a Hitbox at spawn. AnimationSystem writes it on the first tick.

The old `content.getModelHitboxDef()` lookup and the fallback to `deriveHitboxParts` are both **deleted**. One code path.

---

### `applyHitboxTemplate` utility

Shared helper (lives in `@voxim/content/src/hitbox_derive.ts` alongside the template derivation):

```typescript
/**
 * Apply bone transforms to a hitbox template, producing entity-local
 * BodyPartVolume capsules ready for hit detection and network transmission.
 */
export function applyHitboxTemplate(
  template: HitboxPartTemplate[],
  boneTransforms: ReadonlyMap<string, BoneTransform>,
): BodyPartVolume[];
```

Used by both the spawner (rest pose for static entities) and HitboxSystem (live pose for animated entities). Same function, different inputs.

---

### `BodyPartVolume` wire format

**Unchanged.** The Hitbox component on the wire still carries entity-local capsule endpoints. The change is only in how the server derives them. No protocol bump required.

---

## Migration Steps (ordered, no skipping)

### Step 1 — `skeleton_solver.ts` in `@voxim/content`
- Add `quatMultiply` as a private helper in `ik_solver.ts` (or inline in the new file).
- Implement `solveSkeleton` with topological sort (bones are already parent-before-child in the JSON but sort defensively).
- Export `solveSkeleton`, `BoneTransform`, and `REST_POSE` from `mod.ts`.
- Write a standalone unit test (Deno test) with the human skeleton: verify that rest-pose shoulder positions match the known constants (`SHOULDER_REST_Y = 1.75`, etc.).

### Step 2 — `skeleton_pose.ts` in `@voxim/content`
- Move all pose functions out of `skeleton_evaluator.ts` into `skeleton_pose.ts`.
- Change all `THREE.Euler` to `BoneRotation`. Change all `pose.set(key, new THREE.Euler(x,y,z))` to `pose.set(key, {x,y,z})`.
- The weapon IK constraint logic (currently in `weaponAnimationLayer` + `solveConstraints`) is computed here and emits final bone rotations directly (no intermediate constraint list exposed).
- Export `computeHumanPose`, `computeWolfPose` from `mod.ts`.

### Step 3 — Refactor `skeleton_evaluator.ts` (client)
- Delete all pose functions (they are now in `skeleton_pose.ts`).
- Rewrite to call `computeHumanPose`/`computeWolfPose` and convert `BoneRotation` → `THREE.Euler`.
- Verify client renders identically to before (no visual change).

### Step 4 — Refactor `hitbox_derive.ts`
- Replace `deriveHitboxParts` with `deriveHitboxTemplate` (bone-local output, no baked bone offsets).
- Add `applyHitboxTemplate` helper.
- Delete `boneRestPos` helper (no longer needed after this refactor — the solver handles it).
- Remove `deriveHitboxParts` export from `mod.ts`. Add `deriveHitboxTemplate`, `applyHitboxTemplate`, `HitboxPartTemplate` exports.

### Step 5 — Add template caching to `ContentStore`
- Add `getHitboxTemplate(modelId, seed, scale): HitboxPartTemplate[]` that calls `deriveHitboxTemplate` and caches by `${modelId}:${seed}:${scale}`.
- This is purely additive; no breaking changes to existing ContentStore API yet.

### Step 6 — Refactor `AnimationSystem` + create `HitboxSystem`
- In `AnimationSystem`: delete `updateArmHitboxes`, `boneWorldPos`, `solverToEntityLocal`, `ARM_BONE_IDS`, `ARM_BONE_LEN`, `ArmIKResult`. The system reverts to its original single job: derive AnimationMode, write AnimationState.
- Create `packages/tile-server/src/systems/hitbox.ts` — the new `HitboxSystem`.
- HitboxSystem queries `(AnimationState + ModelRef + Velocity + Facing)` and implements the full loop: pose → solveSkeleton → applyHitboxTemplate → write Hitbox.
- Register HitboxSystem in `server.ts` immediately after AnimationSystem and before ActionSystem.

### Step 7 — Refactor `spawner.ts`
- Remove all `deriveHitboxParts` call sites.
- Remove the `content.getModelHitboxDef()` lookup and the pre-baked hitbox path.
- For static entities: write Hitbox at spawn from `applyHitboxTemplate(template, solveSkeleton(skeleton, REST_POSE, scale))`.
- For animated entities (players, NPCs): do not write Hitbox at spawn — HitboxSystem writes it on tick 1.

### Step 8 — Delete dead code
- Delete `getModelHitboxDef` from ContentStore (pre-baked hitbox lookup, now unused).
- Confirm `deriveHitboxParts` is fully gone (`grep -r deriveHitboxParts` returns nothing).
- Confirm `AnimationSystem` no longer imports anything hitbox-related.
- Run `deno check` — zero errors.

### Step 9 — Smoke test
- `deno task demo`
- Confirm players, NPCs, and trees are all hittable.
- Enable hitbox debug overlay — verify capsules track the visible skeleton.

---

## Rules for Claude (Hard Constraints)

**These apply to every file touched in this refactor. No exceptions.**

1. **Delete, do not deprecate.** When a function is replaced, delete it. Do not add `@deprecated` comments, do not rename to `_old`, do not leave it "for now". If it was used somewhere, fix that call site before deleting.

2. **One hitbox derivation pipeline.** After this refactor, there is exactly one function that produces a `BodyPartVolume[]` from entity state: `applyHitboxTemplate`. The spawner and AnimationSystem both call it. If you find yourself adding a third call site that works differently, stop and reconsider.

3. **No ARM_BONE_IDS or equivalent.** Do not hard-code lists of bones that get special treatment. The new system treats all bones uniformly. If a part has a `boneId`, it gets the bone's transform. If it doesn't, it's root-relative. That's the only distinction.

4. **No Three.js in `@voxim/content`.** The content package is shared between server and client. It must not import Three.js. Pose functions return `BoneRotation = { x, y, z }`. The client wraps these in `THREE.Euler`. This boundary must not be blurred.

5. **No server-only fast-paths that skip bone evaluation.** It is not acceptable to short-circuit the skeleton evaluation for "simple" modes like idle or walk. Every animated entity gets a full skeleton evaluation every tick. If performance is a concern, profile first, then optimize the solver — do not add conditional skipping.

6. **`AnimationSystem` does not touch `Hitbox`.** Its job is animation mode derivation only. `HitboxSystem` owns all Hitbox writes for animated entities. The spawner owns Hitbox writes for static entities (rest pose, one time). These are the only two places that write Hitbox. Do not add hitbox logic back into AnimationSystem for any reason.

7. **The wire format does not change.** `BodyPartVolume` fields (`fromFwd`, `fromRight`, `fromUp`, `toFwd`, `toRight`, `toUp`, `radius`) are entity-local capsule endpoints. The codec does not change. The `boneId` field on `BodyPartVolume` is **removed** — it was a server implementation detail that should never have been on the wire type. After the refactor, all parts in the Hitbox component are entity-local and fully resolved.

8. **Client skeleton evaluator must produce identical visual output.** After step 3, run the demo and compare visually. If something looks different, fix it before continuing. Do not proceed through the remaining steps with a broken visual.

9. **Complete each step before starting the next.** `deno check` must pass at the end of every step. Do not batch steps.

10. **Crouching spine layer is out of scope.** Crouching currently drives the AnimationMode. The spine-layer approach (blending crouch on top of attack animation) is a separate follow-up. Do not design for it here.

---

## Acceptance Criteria

- `grep -r "ARM_BONE_IDS\|updateArmHitboxes\|deriveHitboxParts\|getModelHitboxDef\|boneWorldPos"` returns zero results.
- `AnimationSystem` does not import `Hitbox`, `solveTwoBoneIK`, or `applyHitboxTemplate`.
- `grep -r "THREE" packages/content/` returns zero results.
- `deno check` passes with zero errors.
- Hitbox debug overlay shows capsules that track the live skeleton (crouch posture, attack arms, walk lean).
- Trees and resources remain hittable after the spawner change.
- No new `// TODO`, `// FIXME`, or `// deprecated` comments introduced.
