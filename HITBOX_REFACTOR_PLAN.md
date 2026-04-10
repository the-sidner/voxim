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

| Space | Axes | Used for |
|---|---|---|
| Entity-local / game-world | `fwd = Y`, `right = X`, `up = Z` (bone restX=right, restY=fwd, restZ=up) | ECS components, wire format, hit detection |
| Solver space | `x = right`, `y = up`, `z = -fwd` | All internal math — FK walk, IK, pose output |

**Rule: all math in solver space. Convert at the two boundaries only.**

- **In**: entity-local bone rest offsets → solver space at the start of `solveSkeleton`
- **Out**: solver-space bone positions → entity-local at the end of `applyHitboxTemplate`

No other coordinate conversions anywhere. `solveSkeleton`, `computeHumanPose`, `computeWolfPose`, `solveTwoBoneIK`, and `applyHitboxTemplate` all work exclusively in solver space. `BoneTransform.pos` stores solver-space coordinates internally — only `applyHitboxTemplate` converts to entity-local when writing `BodyPartVolume` endpoints. This keeps all the math reusable and free of conversion bugs.

### New shared module: `@voxim/content/src/skeleton_solver.ts`

**Responsibility**: Given a skeleton definition and a pose map (bone → Euler XYZ rotation in solver space), produce the world transform (position + orientation quaternion) for every bone in entity-local space.

```typescript
export interface BoneTransform {
  /** Position in solver space (x=right, y=up, z=-fwd) — relative to entity origin. */
  pos: { x: number; y: number; z: number };
  /** Orientation as unit quaternion in solver space. */
  rot: { x: number; y: number; z: number; w: number };
}

/** Empty map — used to request rest-pose evaluation (all bones at identity rotation). */
export const REST_POSE: ReadonlyMap<string, BoneRotation> = new Map();

/**
 * Walk the skeleton hierarchy (root → leaves) and compute each bone's
 * transform in solver space (x=right, y=up, z=-fwd), relative to entity origin.
 *
 * poseRotations: bone id → Euler XYZ in solver space.
 * Bones absent from poseRotations use identity rotation.
 *
 * ContentStore provides a pre-built Map<boneId, BoneDef> per skeleton
 * (getBoneIndex) so this function never does linear searches.
 */
export function solveSkeleton(
  skeleton: SkeletonDef,
  boneIndex: ReadonlyMap<string, BoneDef>,  // pre-cached by ContentStore
  poseRotations: ReadonlyMap<string, BoneRotation>,
  scale: number,
): Map<string, BoneTransform>;
```

**Algorithm** (FK walk, root-first topological order, entirely in solver space):
```
for each bone (root → leaf order):
  parentTransform = result[bone.parent] ?? { pos: {0,0,0}, rot: IDENTITY }

  // Convert bone rest offset from entity-local to solver space — one-time conversion
  // entity-local: right=restX, fwd=restY, up=restZ
  // solver:       x=right,    y=up,      z=-fwd
  restOffsetSolver = { x: bone.restX * scale, y: bone.restZ * scale, z: -bone.restY * scale }

  // Rotate rest offset into parent's orientation (stays in solver space)
  rotatedOffset = applyQuat(restOffsetSolver, parentTransform.rot)

  // Accumulate position in solver space
  bonePos = parentTransform.pos + rotatedOffset

  // Compose orientation: parent * local
  euler    = poseRotations.get(bone.id) ?? { x:0, y:0, z:0 }
  localRot = quatFromEulerXYZ(euler.x, euler.y, euler.z)
  boneRot  = quatMultiply(parentTransform.rot, localRot)

  result[bone.id] = { pos: bonePos, rot: boneRot }
  // pos remains in solver space — applyHitboxTemplate converts to entity-local at output
```

Export from `@voxim/content/mod.ts`. Zero external dependencies (only imports from within `@voxim/content`). `quatMultiply` added as a private helper in `ik_solver.ts`.

---

### Extended: `AnimationStateData`

Add one field to carry the weapon action identity through to HitboxSystem (and the client):

```typescript
export interface AnimationStateData {
  mode: AnimationMode;
  attackStyle: string;
  windupTicks: number;
  activeTicks: number;
  winddownTicks: number;
  ticksIntoAction: number;
  /** WeaponActionDef id driving the current attack. Empty string for non-attack modes.
   *  Required by HitboxSystem to look up swingPath keyframes and ikTargets. */
  weaponActionId: string;   // ← new field
}
```

`AnimationSystem` already reads `sip.weaponActionId` from `SkillInProgress` — it just needs to pass it through to `AnimationStateData`. `HitboxSystem` calls `content.getWeaponAction(anim.weaponActionId)` to get keyframes and ikTargets for the pose functions. The client uses it identically. Add this field to the codec in `@voxim/codecs`.

---

### New shared module: `@voxim/content/src/skeleton_pose.ts`

**Responsibility**: The pure-math pose functions (currently buried in the client's `skeleton_evaluator.ts`) extracted so the server can call them too. All output is in solver space — no Three.js types.

```typescript
/**
 * Compute bone rotations for a given animation state and entity kinematics.
 * Returns a map of bone id → Euler XYZ in solver space (x=right, y=up, z=-fwd).
 * This is the platform-independent core used by both HitboxSystem and the client.
 */
export function computeHumanPose(
  mode: AnimationMode,
  tick: number,
  vx: number,
  vy: number,
  facingAngle: number,
  weaponData?: {
    keyframes: SwingKeyframe[];
    ikTargets?: IKTargetDef[];
    windupTicks: number;
    activeTicks: number;
    winddownTicks: number;
    ticksIntoAction: number;
    bladeLength: number;
  },
): Map<string, BoneRotation>;

export function computeWolfPose(
  mode: AnimationMode,
  tick: number,
  vx: number,
  vy: number,
  weaponData?: {
    windupTicks: number;
    activeTicks: number;
    winddownTicks: number;
    ticksIntoAction: number;
  },
): Map<string, BoneRotation>;
```

All pose logic moves here verbatim from `skeleton_evaluator.ts`. The IK constraint solving (weapon arm IK, currently `weaponAnimationLayer` + `solveConstraints`) is computed here and emits final bone rotations directly — no intermediate constraint list is exposed as a public type.

Export from `@voxim/content/mod.ts`.

---

### Refactored: `@voxim/content/src/hitbox_derive.ts`

**New output**: bone-local capsule templates in solver space, instead of baked entity-local positions.

```typescript
/**
 * Capsule geometry in bone-local solver space (x=right, y=up, z=-fwd).
 * Both endpoints are relative to the bone's origin (from solveSkeleton).
 * For boneId=null, endpoints are relative to entity origin (root-relative).
 */
export interface HitboxPartTemplate {
  id: string;
  /** Bone this part is relative to. Null for root/entity-origin-relative. */
  boneId: string | null;
  fromX: number; fromY: number; fromZ: number;  // solver space, bone-local
  toX:   number; toY:   number; toZ:   number;  // solver space, bone-local
  radius: number;                                 // world units (already scaled)
}

export function deriveHitboxTemplate(
  modelId: string,
  seed: number,
  content: ContentStore,
  scale: number,
): HitboxPartTemplate[];
```

**Key change in algorithm**: The `boneOffset` accumulation (the old `boneRestPos` walk) is **removed**. Each part stores its geometry in bone-local solver space — just the sub-object's own transform applied to the capsule. The `boneId` is always preserved when a sub-object has one; null otherwise.

`applyHitboxTemplate` applies the live bone world transform (from `solveSkeleton`) to move each part from bone-local into entity-local — this is where the one outbound coordinate conversion happens.

`ContentStore` caches the template per `(modelId, seed, scale)` so it is computed at most once per entity type. Also caches a `Map<boneId, BoneDef>` per skeleton (the bone index) so `solveSkeleton` never does linear searches.

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

A new system added to the tick order immediately after AnimationSystem. Its sole job is: read animation state + kinematics → evaluate skeleton → write Hitbox.

```
Runs after: AnimationSystem
Registered before ActionSystem in server.ts

Query: (AnimationState + ModelRef + Velocity + Facing)

Fields captured in prepare(serverTick):
  this.tick = serverTick   ← drives gait cycle / breathing Math.sin calls

For each matching entity:
  a. Read AnimationState (mode, weaponActionId, tick fields) from component
  b. Read velocity (vx, vy) from Velocity, facing angle from Facing
  c. Look up skeleton from ContentStore via ModelRef.modelId
     → if no skeleton: skip (entity has no skeletal hitbox)
  d. If mode === "attack": fetch weaponData via content.getWeaponAction(anim.weaponActionId)
     to get keyframes, ikTargets, bladeLength — passed to pose function
  e. Dispatch to shared pose function (by skeletonId):
       "human" → computeHumanPose(mode, this.tick, vx, vy, facing, weaponData)
       "wolf"  → computeWolfPose(mode, this.tick, vx, vy, weaponData)
     → Map<boneId, BoneRotation>  (solver space)
  f. solveSkeleton(skeleton, boneIndex, poseMap, scale)
     → Map<boneId, BoneTransform>  (solver space)
  g. getHitboxTemplate(modelId, seed, scale) from ContentStore (cached)
  h. applyHitboxTemplate(template, boneTransforms)
     → BodyPartVolume[]  (entity-local, outbound conversion done here)
  i. world.set(entityId, Hitbox, { parts })
```

**Note on tick ordering**: In this ECS, `world.set()` writes are deferred until `applyChangeset()`. No system reads another system's writes within the same tick — ActionSystem in tick N always reads `Hitbox(N-1)`. The registration order (AnimationSystem → HitboxSystem → ActionSystem) is for logical clarity and future correctness, not a data dependency within the same tick.

HitboxSystem imports: `computeHumanPose`, `computeWolfPose`, `solveSkeleton`, `applyHitboxTemplate` from `@voxim/content`. It does no geometry math itself.

System registration in `server.ts`:
```
... AnimationSystem → HitboxSystem → ActionSystem → ...
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
 *
 * This is the single place where solver-space coordinates are converted to
 * entity-local (fwd=Y, right=X, up=Z). All upstream math stays in solver space.
 *
 * For each part:
 *   1. Look up bone transform (solver-space position + orientation) from boneTransforms.
 *      If boneId is null, use identity transform at origin.
 *   2. Rotate the bone-local endpoint by the bone's orientation quaternion.
 *   3. Add the bone's world position (both in solver space).
 *   4. Convert resulting solver-space point to entity-local:
 *        fwd = -z,  right = x,  up = y
 */
export function applyHitboxTemplate(
  template: HitboxPartTemplate[],
  boneTransforms: ReadonlyMap<string, BoneTransform>,
): BodyPartVolume[];
```

Used by both the spawner (with `REST_POSE` transforms for static entities) and HitboxSystem (with live transforms for animated entities). Same function, different inputs.

---

### `BodyPartVolume` wire format

**Unchanged.** The Hitbox component on the wire still carries entity-local capsule endpoints. The change is only in how the server derives them. No protocol bump required.

---

## Migration Steps (ordered, no skipping)

### Step 1 — `skeleton_solver.ts` in `@voxim/content`
- Add `quatMultiply` as a private helper in `ik_solver.ts`.
- Implement `solveSkeleton` working entirely in solver space. Accepts a pre-built `boneIndex: ReadonlyMap<string, BoneDef>` (no linear searches inside the function).
- `BoneTransform.pos` is solver-space — do not convert to entity-local here.
- Export `solveSkeleton`, `BoneTransform`, `REST_POSE` from `mod.ts`.
- Write a Deno unit test with the human skeleton at rest pose: verify shoulder positions match the known constant (`SHOULDER_REST_Y = 1.75` in Three.js units, which is `y = 1.75` in solver space).

### Step 2 — Extend `AnimationStateData` + codec
- Add `weaponActionId: string` to `AnimationStateData` in `packages/content/src/types.ts`.
- Update the codec in `packages/codecs/src/components.ts` to encode/decode the new field.
- Update `AnimationSystem` to write `weaponActionId: sip?.weaponActionId ?? ""` into `AnimationStateData`.
- `deno check` must pass before continuing.

### Step 3 — `skeleton_pose.ts` in `@voxim/content`
- Move all pose functions out of `skeleton_evaluator.ts` into `skeleton_pose.ts`.
- Replace all `THREE.Euler` with `BoneRotation`. Replace all `pose.set(key, new THREE.Euler(x,y,z))` with `pose.set(key, {x,y,z})`.
- The weapon IK constraint logic (`weaponAnimationLayer` + `solveConstraints`) is collapsed into the pose function and emits final bone rotations directly — no intermediate constraint list exposed.
- Export `computeHumanPose`, `computeWolfPose` from `mod.ts`.

### Step 4 — Refactor `skeleton_evaluator.ts` (client)
- Delete all pose functions (now in `skeleton_pose.ts`).
- Rewrite to call `computeHumanPose`/`computeWolfPose` and convert `BoneRotation → THREE.Euler`.
- Verify client renders identically to before (visual check).

### Step 5 — Refactor `hitbox_derive.ts`
- Replace `deriveHitboxParts` with `deriveHitboxTemplate` (bone-local solver-space output, no baked bone offsets, `boneRestPos` deleted).
- Add `applyHitboxTemplate` — this is the single place converting solver-space → entity-local on output.
- Remove `deriveHitboxParts` export from `mod.ts`. Add `deriveHitboxTemplate`, `applyHitboxTemplate`, `HitboxPartTemplate`.

### Step 6 — Add caching to `ContentStore`
- Add `getBoneIndex(skeletonId): ReadonlyMap<string, BoneDef>` — cached per skeleton type (one entry per skeleton, not per entity).
- Add `getHitboxTemplate(modelId, seed, scale): HitboxPartTemplate[]` — cached per `${modelId}:${seed}:${scale}`.
- Purely additive, no breaking changes yet.

### Step 7 — Refactor `AnimationSystem` + create `HitboxSystem`
- In `AnimationSystem`: delete `updateArmHitboxes`, `boneWorldPos`, `solverToEntityLocal`, `ARM_BONE_IDS`, `ARM_BONE_LEN`, `ArmIKResult`. System reverts to single job: derive AnimationMode, write AnimationState.
- Create `packages/tile-server/src/systems/hitbox.ts` with `HitboxSystem`.
- HitboxSystem captures `serverTick` in `prepare()` for use in `run()`.
- Register HitboxSystem in `server.ts` immediately after AnimationSystem.

### Step 8 — Refactor `spawner.ts`
- Remove all `deriveHitboxParts` call sites and the `getModelHitboxDef` lookup.
- Static entities: write Hitbox at spawn via `applyHitboxTemplate(template, solveSkeleton(skeleton, boneIndex, REST_POSE, scale))`.
- Animated entities (players, NPCs): do not write Hitbox at spawn — HitboxSystem writes it on tick 1.

### Step 9 — Delete dead code
- Delete `getModelHitboxDef` from ContentStore.
- Confirm with grep: `deriveHitboxParts`, `getModelHitboxDef`, `boneWorldPos`, `ARM_BONE_IDS`, `updateArmHitboxes` — all zero results.
- Confirm `AnimationSystem` imports nothing hitbox-related.
- `deno check` — zero errors.

### Step 10 — Smoke test
- `deno task demo`
- Confirm players, NPCs, and trees are all hittable.
- Enable hitbox debug overlay — verify capsules track the live skeleton (crouching, walking, attacking).

---

## Rules for Claude (Hard Constraints)

**These apply to every file touched in this refactor. No exceptions.**

1. **Delete, do not deprecate.** When a function is replaced, delete it. Do not add `@deprecated` comments, do not rename to `_old`, do not leave it "for now". If it was used somewhere, fix that call site before deleting.

2. **One hitbox derivation pipeline.** After this refactor, there is exactly one function that produces a `BodyPartVolume[]` from entity state: `applyHitboxTemplate`. The spawner and HitboxSystem both call it. If you find yourself adding a third call site that works differently, stop and reconsider.

3. **No ARM_BONE_IDS or equivalent.** Do not hard-code lists of bones that get special treatment. The new system treats all bones uniformly. If a part has a `boneId`, it gets the bone's transform. If it doesn't, it's root-relative. That's the only distinction.

4. **No Three.js in `@voxim/content`.** The content package is shared between server and client. It must not import Three.js. Pose functions return `BoneRotation = { x, y, z }`. The client wraps these in `THREE.Euler`. This boundary must not be blurred.

5. **No server-only fast-paths that skip bone evaluation.** It is not acceptable to short-circuit the skeleton evaluation for "simple" modes like idle or walk. Every animated entity gets a full skeleton evaluation every tick. If performance is a concern, profile first, then optimize the solver — do not add conditional skipping. The bone index cache (`getBoneIndex`) and hitbox template cache (`getHitboxTemplate`) are the approved optimizations; no others should be added preemptively.

5b. **`solveSkeleton` and `computeXxxPose` accept output maps (future pooling).** Both functions should accept an optional `out` parameter (`Map<string, BoneTransform>` / `Map<string, BoneRotation>`) that, if provided, is cleared and written into instead of allocating a new Map. This makes allocation pooling a caller-side concern and avoids changing the API later. For now callers pass nothing and get a fresh Map.

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
- `solveSkeleton` and `computeHumanPose`/`computeWolfPose` accept optional `out` map parameters.
- `ContentStore` exposes `getBoneIndex` (per skeleton type) and `getHitboxTemplate` (per model+seed+scale), both cached.
- `AnimationStateData` includes `weaponActionId` and its codec round-trips it correctly.
- `applyHitboxTemplate` is the only place in the codebase that converts solver-space → entity-local.
- `deno check` passes with zero errors.
- Hitbox debug overlay shows capsules that track the live skeleton (crouching, walking, attacking).
- Trees and resources remain hittable after the spawner change.
- No new `// TODO`, `// FIXME`, or `// deprecated` comments introduced.
