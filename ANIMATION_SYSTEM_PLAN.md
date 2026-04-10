# Animation System Plan — Data-Driven Clips + Layer Blending

## Problem Statement

The current animation system has two fundamental flaws:

**Architectural:** `computeHumanPose` and `computeWolfPose` are TypeScript functions with numeric
constants baked in. Adding a skeleton type, animation clip, or behaviour requires code changes.
Only one mode is active at a time — no composition. The `AnimationMode` enum leaks into the wire
format and into systems that have nothing to do with animation.

**Performance:** The `Hitbox` component is networked and re-encoded every tick. At 100 animated
entities, that is ~800 KB/s of hitbox data that no client uses for gameplay. Two short-lived
`Map` allocations per entity per tick drive GC pressure at scale.

## What This Plan Replaces — Completely

| Old | New |
|-----|-----|
| `computeHumanPose` / `computeWolfPose` | Deleted. `evaluateAnimationLayers` (generic). |
| `skeleton_pose.ts` | Deleted entirely. |
| `AnimationMode` type | Deleted. AnimationSystem uses local logic; no exported enum. |
| `AnimationStateData.mode` | Deleted from wire format. |
| `AnimationStateData.attackStyle` | Deleted from wire format. |
| `AnimationStateData.windupTicks/activeTicks/winddownTicks` | Deleted from wire format. |
| `evaluatePose(skeletonId, mode, attackStyle, windupTicks, ...)` | Replaced by `evaluateAnimationLayers`. |
| Networked `Hitbox` | Non-networked. Client reconstructs locally. |
| PhysicsSystem reading `animationState.mode` for crouch | Reads `InputState` directly. |

Every call site of every deleted symbol is updated in the same step that deletes the symbol.
Nothing is left reading a deleted field. No fallbacks. No `mode ?? layers` shims.

---

## Target Architecture

### Data model — clips and bone masks belong to the skeleton

```typescript
// packages/content/src/types.ts additions

export interface AnimationKeyframe {
  /** Normalised position within the clip [0, 1]. Must be sorted ascending. */
  t: number;
  /** Euler XYZ rotation in radians, solver space (x=right, y=up, z=-fwd). */
  x: number;
  y: number;
  z: number;
}

export interface AnimationClip {
  id: string;             // e.g. "idle", "walk", "hit_front", "carry_two_handed"
  loop: boolean;
  durationTicks: number;  // reference duration at 1× speed (20 Hz ticks)
  /**
   * "velocity" — playback rate scales with entity speed: rate = speed / speedReference.
   * Absent / "fixed" — always plays at 1×.
   */
  speedScale?: "velocity";
  speedReference?: number;
  /** bone id → keyframes (t ascending, must start at 0 and end at 1 for loops). */
  tracks: Record<string, AnimationKeyframe[]>;
}

// Extended SkeletonDef (no breaking change — new fields are optional)
export interface SkeletonDef {
  id: string;
  bones: BoneDef[];
  /**
   * Named bone subsets used as layer masks.
   * Key "" (full body) is implicit and never needs to be defined.
   * e.g. "upper_body", "lower_body", "arms", "torso_only"
   */
  boneMasks?: Record<string, string[]>;
  /** All animation clips owned by this skeleton, keyed by clip.id. */
  clips?: AnimationClip[];
}
```

### Runtime state — `AnimationStateData` becomes a minimal layer list

`mode`, `attackStyle`, `windupTicks`, `activeTicks`, `winddownTicks` are **removed from the wire**.
They were derived state that leaked into a networked component. Systems that need game-logic
answers go to their source of truth directly: `Health` for death, `InputState` for crouch,
`SkillInProgress` for attacking.

The two fields that cannot be derived locally — the weapon action identity and the exact IK
progress tick — are kept because they drive arm-chain geometry, not just rendering style.

```typescript
export interface AnimationLayer {
  clipId:   string;   // references skeleton.clips[id]
  maskId:   string;   // "" = full body; else key from skeleton.boneMasks
  time:     number;   // normalised [0, 1]; server advances this each tick
  weight:   number;   // blend weight [0, 1]
  additive: boolean;  // false = override blend; true = additive on top
}

export interface AnimationStateData {
  layers: AnimationLayer[];          // evaluated bottom→top; the complete visual truth
  weaponActionId: string;            // "" when not attacking; drives arm-chain IK
  ticksIntoAction: number;           // 0 when not attacking; IK t = ticksIntoAction / totalTicks
}
```

`AnimationMode` is **deleted from `types.ts`**. AnimationSystem's internal logic (which derives
which clips to push) uses local variables only.

### Layer semantics

| Priority | Role | Clip examples | Mask | Blend |
|---|---|---|---|---|
| 0 (base) | Locomotion | `idle`, `walk`, `crouch`, `crouch_walk` | full body | override |
| 1 | Upper activity | `carry_two_handed`, `guard_stance` | `upper_body` | override |
| 2+ | Reactions | `hit_front`, `stagger` | full body | override |
| N (top) | Breathing / additive | `breathe` | `torso_only` | additive |

Higher-index layers override lower ones for their masked bones. Additive layers add on top.

The IK post-process (weapon arm chains) is **not a layer** — it runs after all layers are
evaluated, overriding the relevant arm bones unconditionally when `weaponActionId` is set.

### Generic evaluator

```typescript
/**
 * Evaluate the layer stack for one entity.
 *
 * 1. Initialise all bones to identity rotation {0,0,0}.
 * 2. For each layer (index 0 = lowest priority → last = highest):
 *      a. Look up clip from clipIndex.
 *      b. Compute effective time:
 *           loop=true  → wrap layer.time to [0,1]
 *           loop=false → clamp layer.time to [0,1]
 *      c. For each bone track in the clip whose bone is in the layer mask:
 *           sample keyframes (binary search + linear LERP)
 *           override: pose[bone] = lerp(pose[bone], sample, weight)
 *           additive: pose[bone] += sample × weight
 * 3. Return pose map.
 *
 * Weapon IK is NOT applied here. The caller applies it as a post-process.
 *
 * @param out  Pre-allocated map to write into (avoids allocation on hot path).
 */
export function evaluateAnimationLayers(
  skeleton:  SkeletonDef,
  clipIndex: ReadonlyMap<string, AnimationClip>,
  maskIndex: ReadonlyMap<string, ReadonlySet<string>>,
  layers:    AnimationLayer[],
  out?:      Map<string, BoneRotation>,
): Map<string, BoneRotation>
```

### Performance: three built-in optimisations

**1. `Hitbox` non-networked.** Clients reconstruct hitboxes locally from the same animation data.
Eliminates ~800 KB/s per 100 entities of encoding and transmission.

**2. Pre-allocated Map pooling in HitboxSystem.** One pose Map and one bone-transform Map per
entity, allocated at first use, reused every tick via the `out` parameter. Zero hot-path
allocation for the two most expensive data structures per entity per tick.

**3. Dirty check before `world.set(Hitbox)`.** Compare new `BodyPartVolume[]` to existing
component before writing. Stationary idle entities skip the ECS write entirely.

---

## Migration Steps (ordered, no skipping, `deno check` after each)

### Step 1 — Make `Hitbox` non-networked

- Add `networked: false` to the `Hitbox` component definition in `hitbox.ts`.
- Remove `hitboxCodec` from the client-side component decoder registration — the client will
  never receive a Hitbox delta and must not try to decode one.
- Remove `hitboxCodec` export from `@voxim/codecs` only if nothing else imports it; otherwise
  keep it for the local server-side serialiser but remove from the networked export list.
- Add a `computeHitboxDebug(entityId, world, content): BodyPartVolume[]` stub in the client
  (returns `[]` for now) so the debug overlay has an insertion point.
- `deno check` must pass. Hit detection still works; client renders without error.

### Step 2 — Add animation types to `@voxim/content`

- Add `AnimationKeyframe`, `AnimationClip` to `types.ts`.
- Extend `SkeletonDef` with optional `boneMasks` and `clips` fields.
- Add `AnimationLayer` to `types.ts`.
- Export all new types from `mod.ts`.
- No implementation yet. `deno check` must pass.

### Step 3 — Write the generic evaluator in `@voxim/content`

New file: `packages/content/src/animation_eval.ts`

- Implement `evaluateAnimationLayers` per the signature above.
- Binary search helper (`bisect`) for keyframe lookup — O(log k) per bone per layer.
- Linear LERP between adjacent keyframes (smooth/spline deferred to tooling phase).
- Override blend: `lerp(accumulated, sampled, weight)`.
- Additive blend: element-wise addition scaled by weight.
- Bones absent from the clip's tracks are left at their accumulated value (not zeroed).
- Bones referenced in tracks but absent from the skeleton are silently skipped.
- Export `evaluateAnimationLayers` from `mod.ts`.
- Write a unit test: two-keyframe single-bone clip evaluates correctly at t=0, t=0.5, t=1.
  Include a two-layer test (lower body walk + upper body carry blend).

### Step 4 — Add clip/mask caches to `ContentStore`

New methods on `ContentStore` interface and `StaticContentStore`:

```typescript
/** Map<clipId, AnimationClip> for the named skeleton. Built once, cached. */
getClipIndex(skeletonId: string): ReadonlyMap<string, AnimationClip>

/** Map<maskId, Set<boneId>> for the named skeleton. Built once, cached. */
getMaskIndex(skeletonId: string): ReadonlyMap<string, ReadonlySet<string>>
```

- Validate on build: keyframes sorted by `t` ascending; throw if violated.
- `deno check` must pass. Purely additive — no existing calls change.

### Step 5 — Replace `AnimationStateData` + codec + all call sites

This step is the largest and must be done atomically (single commit).

**In `@voxim/content/src/types.ts`:**
- Delete `AnimationMode` type entirely.
- Delete `AnimationStateData` fields: `mode`, `attackStyle`, `windupTicks`, `activeTicks`,
  `winddownTicks`.
- Add `layers: AnimationLayer[]` to `AnimationStateData`.
- Keep `weaponActionId: string` and `ticksIntoAction: number`.

**In `@voxim/codecs/src/components.ts`:**
- Rewrite `animationStateCodec` entirely. Old fields gone; encode/decode the layer list via
  `WireWriter`/`WireReader` plus the two IK fields.

**In `packages/tile-server/src/components/game.ts`:**
- Update `AnimationState` default to `{ layers: [], weaponActionId: "", ticksIntoAction: 0 }`.

**In `spawner.ts`:**
- Update both `AnimationState` write sites to the new shape.

**In `packages/tile-server/src/systems/physics.ts`:**
- Remove any reference to `animationState.mode` for crouch detection.
- Read `InputState` and check `hasAction(inputState.actions, ACTION_CROUCH)` directly.

**In any other server system that reads `animationState.mode`:**
- Identify via grep; update each one to read its source of truth (`Health`, `InputState`,
  `SkillInProgress`) instead.

`deno check` must pass with zero errors before committing this step.

### Step 6 — Refactor `AnimationSystem` to manage the layer stack

AnimationSystem now has one job: map game state → `layers` array + IK fields.

Rules for layer management:
- **Layer 0 (locomotion):** Always present. `clipId` = `"walk"` / `"idle"` / `"crouch"` /
  `"crouch_walk"` based on velocity + `ACTION_CROUCH`. `maskId = ""`. `time` advances each
  tick by speed-scaled `Δt = speed / speedReference / durationTicks` (or `1 / durationTicks`
  for fixed-rate clips). Wraps at 1.0 for loops.
- **Attack layer:** Pushed when `SkillInProgress` is present. `clipId` = e.g.
  `"attack_swing"` (or whatever the skeleton defines for that animation style — looked up from
  the weapon action). `maskId = "upper_body"`. `time = ticksIntoAction / totalTicks`. Popped
  when SIP is removed. Also writes `weaponActionId` and `ticksIntoAction` on `AnimationStateData`.
- **Death layer:** When `Health.current <= 0`, replace all layers with a single full-body
  `"death"` layer at weight 1.0. `loop = false`, time advances to 1.0 then freezes.
- **Reaction layers:** Pushed by deferred events (damage received). One-shot, full-body
  override. Time advances each tick. Popped when time reaches 1.0.

AnimationSystem does **not** evaluate poses. It does **not** import `evaluateAnimationLayers`.
It writes `AnimationState` only.

`deno check` must pass.

### Step 7 — Refactor `HitboxSystem`

- Replace `computeHumanPose`/`computeWolfPose` dispatch with `evaluateAnimationLayers`.
- Add `posePool` and `transformPool` (`Map<entityId, Map<boneId, …>>`); pass as `out` to
  evaluator and `solveSkeleton`. Zero Map allocation on hot path.
- Subscribe to entity destroy events; remove pool entries for destroyed entities.
- Apply weapon IK post-process when `animState.weaponActionId !== ""`:
  look up `WeaponActionDef` by `weaponActionId`, compute `t = ticksIntoAction / totalTicks`,
  evaluate `swingPath` at `t`, solve arm-chain IK, override relevant bones in the pose map.
  This is the same IK math as today, just called explicitly after `evaluateAnimationLayers`.
- Dirty check before `world.set`: compare new `BodyPartVolume[]` to existing `Hitbox.parts`;
  skip write if equal.
- `deno check` must pass.

### Step 8 — Refactor client `skeleton_evaluator.ts` and `renderer.ts`

**`skeleton_evaluator.ts`:**
- Delete the current `evaluatePose(skeletonId, mode, attackStyle, windupTicks, …)` signature.
- New signature:
  ```typescript
  export function evaluatePose(
    skeleton:  SkeletonDef,
    clipIndex: ReadonlyMap<string, AnimationClip>,
    maskIndex: ReadonlyMap<string, ReadonlySet<string>>,
    animState: AnimationStateData,
    tick:      number,
    speed:     number,
  ): Map<string, THREE.Euler>
  ```
- Calls `evaluateAnimationLayers` from `@voxim/content`.
- Applies weapon IK post-process if `animState.weaponActionId !== ""` (same logic as HitboxSystem Step 7).
- Converts `BoneRotation → THREE.Euler`.
- `evaluateWeaponTip` and `evaluateWeaponSlice` are unchanged.

**`renderer.ts`:**
- Update every call site of `evaluatePose` to pass the new arguments.
- Extract `skeleton`, `clipIndex`, `maskIndex` from `ContentStore` (or a client-side content
  cache — adapt as needed).
- Remove all references to `animState.mode`, `animState.attackStyle`, `animState.windupTicks`,
  etc. — these fields no longer exist.
- `deno check` must pass. Run the demo and verify rendering is visually correct before
  continuing.

### Step 9 — Add clip data to `skeletons.json`

Each skeleton gets a full set of clips for all game modes:

**Human skeleton clips:** `idle`, `walk`, `crouch`, `crouch_walk`, `death`, `attack_swing`
(body clip — torso twist and head lean; arms are IK-driven, not clip-driven).

**Wolf skeleton clips:** `idle`, `walk`, `death`, `attack_lunge`.

Bone masks per skeleton:
- Human: `upper_body`, `lower_body`, `arms`, `torso_only`
- Wolf: (wolf has fewer composition needs; add masks as clips require)

**These clips are honest approximations of the current procedural behaviour expressed as
keyframes.** 4–8 keyframes per bone is sufficient for the gait cycles. Visual quality is
not the goal of this step — correctness of the pipeline is. Tooling will refine them.

Validation: content loads without errors; `deno check` passes; game runs with hit detection
working and rendering visually close to before.

### Step 10 — Delete `skeleton_pose.ts` and `AnimationMode`

- Delete `packages/content/src/skeleton_pose.ts`.
- Remove its exports (`computeHumanPose`, `computeWolfPose`, `HumanWeaponData`,
  `WolfWeaponData`) from `mod.ts`.
- Delete `AnimationMode` from `packages/content/src/types.ts`.
- Run grep to confirm zero remaining references:
  ```
  grep -r "computeHumanPose\|computeWolfPose\|AnimationMode\|HumanWeaponData\|WolfWeaponData\|skeleton\.id.*wolf\|skeletonId.*human"
  ```
  Expected: zero results in all packages.
- `deno check` must pass with zero errors.

---

## Hard Rules

1. **Complete replacement, no coexistence.** When a symbol is replaced, it is deleted in the
   same step. There is no period where both the old and new implementation exist. If a call
   site cannot be updated in the same step, restructure the steps.

2. **No `AnimationMode` in the wire format.** `AnimationStateData` carries `layers` and IK
   fields only. No mode string, no attack style string, no windup/active/winddown tick counts.
   Any system that needs game-logic answers reads its source of truth directly.

3. **No per-skeleton branches in evaluator code.** `evaluateAnimationLayers` has no knowledge
   of `"human"` or `"wolf"`. Skeleton identity appears only in `ContentStore` caching. Adding
   a new skeleton type requires zero TypeScript changes.

4. **All call sites change in the same step as the type they depend on.** Step 5 changes
   `AnimationStateData` AND updates every consumer in the same commit. No consumer is left
   reading a field that has been deleted.

5. **IK is always a post-process.** Weapon arm IK runs after `evaluateAnimationLayers` returns,
   overriding the relevant bone rotations. It is not a layer type and is not handled inside
   the evaluator. Both HitboxSystem and `skeleton_evaluator.ts` apply it the same way.

6. **`Hitbox` is never networked again.** The client computes hitboxes locally from
   `AnimationStateData` + skeleton + content when the debug overlay is enabled. Server hitboxes
   are server-internal state only.

7. **Pool cleanup is mandatory.** Every entry added to HitboxSystem's `posePool` /
   `transformPool` is removed when the entity is destroyed. Unbounded pool growth is a bug.

8. **Keyframes must be sorted ascending by `t`.** ContentStore validates on load and throws.
   The binary search makes no guarantee of correctness on unsorted input.

9. **`deno check` passes after every step.** Steps are not batched. A step is not done until
   the type checker agrees.

10. **The client renderer must be visually verified after Step 8.** Run `deno task demo` and
    confirm players, NPCs, and trees render correctly before proceeding to Step 9.

---

## Acceptance Criteria

- `grep -r "computeHumanPose\|computeWolfPose\|AnimationMode\|HumanWeaponData\|WolfWeaponData"` — zero results.
- `grep -r "skeleton\.id.*wolf\|skeletonId.*human"` in evaluator code — zero results.
- `grep -r 'animationState\.mode\|animState\.mode\|\.attackStyle\|\.windupTicks\|\.activeTicks\|\.winddownTicks'` — zero results.
- `AnimationStateData` wire format: `layers[]` + `weaponActionId` + `ticksIntoAction` only.
- `Hitbox` component has `networked: false`. Client does not register a Hitbox decoder.
- `HitboxSystem` pre-allocates per-entity Maps; zero Map allocations per tick on hot path.
- Dirty check: `world.set(Hitbox)` not called when computed parts match existing parts.
- Adding a new skeleton type (bones + clips + masks in JSON) requires zero TypeScript changes.
- `deno check` passes with zero errors across all packages.
- Hit detection works for players, NPCs, and trees.
- Client renders players and NPCs visually correctly (confirmed by running `deno task demo`).
