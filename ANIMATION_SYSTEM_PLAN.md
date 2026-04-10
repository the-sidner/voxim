# Animation System Plan — Data-Driven Clips + Layer Blending

## Problem Statement

The current system hard-codes animation behaviour per skeleton type:
- `computeHumanPose` and `computeWolfPose` are TypeScript functions with numeric constants baked in
- Adding a new skeleton type requires new code; adding a new animation (hit reaction, carry pose) requires new code
- Only one animation mode is active at a time — no composition (can't walk while carrying, can't crouch while attacking)
- Hitbox component is networked and re-encoded every tick — a bandwidth sink that provides no gameplay value
- Two short-lived `Map` allocations per entity per tick cause GC pressure at scale

## Target Architecture

### Data model — clips and bone masks live in the skeleton

Each `SkeletonDef` gains two new fields:

```typescript
export interface AnimationKeyframe {
  t: number;  // normalised 0..1 within the clip
  x: number;  // Euler X, solver space (x=right, y=up, z=-fwd)
  y: number;  // Euler Y
  z: number;  // Euler Z
}

export interface AnimationClip {
  id: string;           // e.g. "idle", "walk", "hit_front", "carry_two_handed"
  loop: boolean;
  durationTicks: number;  // reference duration at 1× speed
  /**
   * When "velocity": playback rate = entitySpeed / speedReference.
   * Absent or "fixed": playback rate is always 1×.
   */
  speedScale?: "velocity";
  speedReference?: number;
  /** bone id → ordered keyframes (t ascending, must include t=0 and t=1 for loops) */
  tracks: Record<string, AnimationKeyframe[]>;
}

export interface SkeletonDef {
  id: string;
  bones: BoneDef[];
  /**
   * Named subsets of bones used as layer masks.
   * Absent key means full-body (all bones).
   */
  boneMasks?: Record<string, string[]>;
  /**
   * All animation clips owned by this skeleton.
   * Indexed by clip.id for O(1) lookup after ContentStore builds a cache map.
   */
  clips?: AnimationClip[];
}
```

### Runtime state — layer stack replaces mode enum

`AnimationStateData` gains an ordered layer list. The `mode` field is kept as a lightweight game-logic tag so other systems (health, physics, AI) can still ask "is this entity dead / crouching?" without inspecting the layer stack.

```typescript
export interface AnimationLayer {
  clipId:   string;   // must exist in skeleton.clips
  maskId:   string;   // "" = full body; else key from skeleton.boneMasks
  time:     number;   // normalised 0..1; server advances this each tick
  weight:   number;   // 0..1 blend weight (used for fade-in / fade-out)
  additive: boolean;  // false = override blend; true = additive on top of accumulated pose
}

export interface AnimationStateData {
  mode: AnimationMode;          // game-logic tag (kept for non-animation systems)
  layers: AnimationLayer[];     // evaluated bottom→top; drives hitbox + rendering
  // IK fields — unchanged; drive weapon arm IK post-process
  weaponActionId:  string;
  windupTicks:     number;
  activeTicks:     number;
  winddownTicks:   number;
  ticksIntoAction: number;
}
```

**Looping clips** — server advances `layer.time` each tick by `Δt = (1 / durationTicks) × speedMult`.
Both server and client advance it the same way from the same starting point; no extra sync needed.

**One-shot clips** (hit reaction, death) — server advances `time`, writes it to `AnimationState` each tick.
When `time` reaches 1.0 the server pops the layer.

### Generic evaluator — no per-skeleton branches

```typescript
/**
 * Evaluate the layer stack for one entity, producing a bone rotation map
 * ready to feed into solveSkeleton.
 *
 * Steps:
 *   1. Start with identity pose (all bones at {0,0,0}).
 *   2. For each layer (index 0 = lowest priority → last = highest):
 *        a. Look up the clip by layer.clipId in the skeleton's clip map.
 *        b. Resolve playback time:
 *             looping  → wrap layer.time to [0,1]
 *             one-shot → clamp layer.time to [0,1]
 *        c. For each bone track in the clip:
 *             if bone is in the layer's mask (or mask is full-body):
 *               sample keyframes at t (binary search + linear LERP)
 *               if additive: pose[bone] += sampled × weight
 *               if override: pose[bone] = lerp(pose[bone], sampled, weight)
 *   3. If weaponActionId is set: applyWeaponIK(pose, weaponData, skeleton)
 *      (modifies arm bone rotations in-place; same IK math as today)
 *   4. Return final pose map.
 *
 * @param out  Optional pre-allocated Map to write into (avoids allocation).
 */
export function evaluateAnimationLayers(
  skeleton:   SkeletonDef,
  clipIndex:  ReadonlyMap<string, AnimationClip>,  // cached by ContentStore
  maskIndex:  ReadonlyMap<string, ReadonlySet<string>>,
  layers:     AnimationLayer[],
  out?:       Map<string, BoneRotation>,
): Map<string, BoneRotation>
```

IK is a post-process applied by the caller (HitboxSystem / skeleton_evaluator) after `evaluateAnimationLayers` returns, exactly as today. It is not a layer — it overrides specific bones unconditionally.

### Performance optimisations (built into this plan)

**1. Make `Hitbox` non-networked**

Clients do not use server-sent hitboxes for gameplay — hit detection is server-authoritative. The client runs the same evaluator locally for debug visualisation when needed. Removing the `networked` flag eliminates the largest per-tick bandwidth cost.

```typescript
export const Hitbox = defineComponent({
  name: "hitbox" as const,
  codec: hitboxCodec,
  networked: false,    // ← new
  default: (): HitboxData => ({ parts: [] }),
});
```

**2. Pre-allocated Map pooling in HitboxSystem**

HitboxSystem allocates one pose Map and one bone-transform Map per entity at startup (keyed by entityId), then passes them as `out` parameters every tick. Zero hot-path allocation for the two most expensive Maps.

```typescript
class HitboxSystem {
  private posePool       = new Map<string, Map<string, BoneRotation>>();
  private transformPool  = new Map<string, Map<string, BoneTransform>>();

  private getPool<V>(pool: Map<string, Map<string, V>>, entityId: string) {
    let m = pool.get(entityId);
    if (!m) { m = new Map(); pool.set(entityId, m); }
    return m;
  }
}
```

When an entity is destroyed, its pool entries must be removed (subscribe to destroy events).

**3. Dirty check before `world.set(Hitbox)`**

Compare the newly computed `BodyPartVolume[]` to the existing component before writing. Since Hitbox is now non-networked, this only matters for ActionSystem reads (which see the previous tick's value anyway), but it avoids polluting the ECS changeset with no-op writes for stationary idle entities.

Comparison is cheap: `parts.length` check then element-wise float comparison (7 floats × ~10 parts = 70 comparisons).

**4. Clip and mask index cache in ContentStore**

```typescript
// New ContentStore methods (additive, Step 6):
getClipIndex(skeletonId: string): ReadonlyMap<string, AnimationClip>
getMaskIndex(skeletonId: string): ReadonlyMap<string, ReadonlySet<string>>
```

Both cached per skeleton on first access. ContentStore already has `getBoneIndex` and `getHitboxTemplate`; these follow the same pattern.

---

## Migration Steps (ordered, no skipping)

### Step 1 — Make `Hitbox` non-networked

- Add `networked: false` to the `Hitbox` component definition.
- Remove `hitboxCodec` from the client's component decoder (it will never receive Hitbox deltas).
- Add a client-side `computeHitboxDebug(entityId)` helper that runs the evaluator locally on demand (for the debug overlay). This can be a stub for now.
- `deno check` must pass.
- Smoke-test: hit detection still works (server-only Hitbox), client renders without error.

### Step 2 — Add animation types to `@voxim/content`

- Add `AnimationKeyframe`, `AnimationClip` to `types.ts`.
- Extend `SkeletonDef` with optional `boneMasks` and `clips`.
- Export new types from `mod.ts`.
- No logic yet. `deno check` must pass.

### Step 3 — Write the generic clip evaluator in `@voxim/content`

New file: `packages/content/src/animation_eval.ts`

```typescript
export function evaluateAnimationLayers(
  skeleton:  SkeletonDef,
  clipIndex: ReadonlyMap<string, AnimationClip>,
  maskIndex: ReadonlyMap<string, ReadonlySet<string>>,
  layers:    AnimationLayer[],
  out?:      Map<string, BoneRotation>,
): Map<string, BoneRotation>
```

- Binary search helper for keyframe lookup.
- Linear LERP between keyframes (smooth/Catmull-Rom deferred to tooling phase).
- Override blend: `lerp(accumulated, sampled, weight)`.
- Additive blend: `accumulated + sampled × weight`.
- Export from `mod.ts`.
- No `computeHumanPose` / `computeWolfPose` calls anywhere in this file.
- Unit test: single-bone clip evaluates correctly at t=0, t=0.5, t=1.

### Step 4 — Add `getClipIndex` / `getMaskIndex` to `ContentStore`

- Cached per skeleton on first access.
- `getMaskIndex` converts `boneMasks` record to `Map<string, Set<string>>`.
- `deno check` must pass.

### Step 5 — Update `AnimationStateData` + codec

- Add `layers: AnimationLayer[]` to `AnimationStateData`.
- Keep `mode: AnimationMode` (game-logic tag, not removed).
- Update `animationStateCodec` in `@voxim/codecs` to encode/decode the layer list using `WireWriter`/`WireReader`.
- Update all sites that construct `AnimationStateData` literals (spawner, AnimationSystem tests) to include `layers: []`.
- `deno check` must pass.

### Step 6 — Refactor `AnimationSystem` to manage layer stack

AnimationSystem's new job: derive `mode` (game-logic tag) AND manage the `layers` array.

Rules for layer management:
- **Locomotion layer** (index 0, maskId `""`, override): clip = `"idle"` or `"walk"` or `"crouch"` or `"crouch_walk"` based on velocity + InputState. Time advances each tick by speed-scaled `Δt`.
- **Attack layer** (maskId `"upper_body"`, override): pushed when `SkillInProgress` is present; time = `ticksIntoAction / totalTicks`; popped when SIP removed.
- **Reaction layers**: pushed by deferred events (hit received); one-shot; popped when time reaches 1.0.
- Weight is 1.0 for all active layers (fade-in/out deferred to tooling phase).

AnimationSystem does **not** evaluate poses — it only writes `AnimationState`.

### Step 7 — Refactor `HitboxSystem` to use new evaluator + pooling + dirty check

- Replace `computeHumanPose`/`computeWolfPose` dispatch with `evaluateAnimationLayers`.
- Add `posePool` and `transformPool` Maps; pass as `out` to evaluator and `solveSkeleton`.
- Add pool cleanup on entity destroy (subscribe to destroy event via `DeferredEventQueue`).
- Add dirty check: compare new parts to `world.get(entityId, Hitbox)` before calling `world.set`.
- `deno check` must pass.

### Step 8 — Refactor client `skeleton_evaluator.ts`

- Replace `computeHumanPose`/`computeWolfPose` dispatch with `evaluateAnimationLayers`.
- The client reads `animationState.layers` (already received via delta) and evaluates them.
- Weapon IK post-process stays (same code, just called after `evaluateAnimationLayers`).
- `deno check` must pass. Verify rendering is visually identical.

### Step 9 — Add clip data to `skeletons.json`

Bake the current procedural constants into keyframes. Each skeleton gets clips for:
`idle`, `walk`, `crouch`, `crouch_walk`, `death`

These are approximations of the current sin-wave behaviour using 4–8 keyframes per bone. They are explicitly placeholders — the point is correctness of the pipeline, not visual quality. The tooling will refine them later.

Wolf gets: `idle`, `walk`, `death`, `attack_lunge` (the procedural lunge curve becomes keyframes).

### Step 10 — Delete `skeleton_pose.ts`

- Delete `packages/content/src/skeleton_pose.ts`.
- Remove its exports from `mod.ts`.
- Confirm `grep -r "computeHumanPose\|computeWolfPose"` returns zero results.
- `deno check` must pass.

---

## Hard Rules

1. **No per-skeleton branches in evaluator code.** `evaluateAnimationLayers` receives a skeleton and its data — it has no knowledge of `"human"` or `"wolf"`. The only valid branch on skeleton identity is inside `ContentStore` caching logic.

2. **Clips own their bone names.** A clip that references a bone not present in the skeleton's `bones` array is silently skipped (unknown bones produce no rotation). This allows sharing clips across skeleton variants.

3. **`mode` is a game-logic tag only.** No rendering or hitbox code reads `mode`. All visual/hitbox behaviour is driven by the `layers` array. The only legitimate readers of `mode` are: health checks, AI systems, physics (crouching speed), UI.

4. **IK is always a post-process.** `applyWeaponIK` (or its successor) runs after `evaluateAnimationLayers` returns. It is not a layer type. Do not add IK handling inside the evaluator.

5. **`Hitbox` is never networked.** Do not add `networked: true` back. The client computes hitboxes locally for debug only.

6. **Pool cleanup is mandatory.** Every `Map` entry added to `posePool` or `transformPool` must be removed when the entity is destroyed. Leaking entity pools grows memory unboundedly.

7. **Keyframes must be sorted by `t` ascending.** The binary search assumes this. ContentStore validates on load and throws if violated.

8. **`deno check` passes at the end of every step.** Do not batch steps.

---

## Acceptance Criteria

- `grep -r "computeHumanPose\|computeWolfPose\|skeleton\.id.*wolf\|skeletonId.*human"` returns zero results in evaluator code.
- `grep -r 'networked.*true' packages/tile-server/src/components/hitbox.ts` returns zero results.
- `ContentStore` exposes `getClipIndex` and `getMaskIndex`, both cached per skeleton.
- `AnimationStateData` has a `layers` array; codec round-trips it correctly.
- `HitboxSystem` uses pre-allocated pool Maps (zero Map allocations on hot path per tick).
- Dirty check: `world.set(Hitbox)` is not called when the computed parts equal the current parts.
- Adding a new skeleton type requires only JSON data changes — zero TypeScript code changes.
- `deno check` passes with zero errors.
- Hit detection works for players, NPCs, and trees after all steps complete.
- Client renders identically to before (visual check after Step 8).
