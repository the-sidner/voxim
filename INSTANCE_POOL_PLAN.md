# InstancePool refactor — procedural-first GPU instancing

> **This is a working document.** It will be deleted in the same commit
> that closes the last phase (T-167). Per `CLAUDE.md`, plans don't survive
> the refactor that produced them.

## Why this exists

Frame-time investigation on 2026-05-07 showed the client running at ~35 FPS
on the user's machine. The HUD breakdown isolated the cost to GL (~23 ms of
a 29 ms frame) and the scene census surfaced the structural cause:

| Bucket      | Nodes  | Instances | Tris    |
|-------------|--------|-----------|---------|
| `forest`    | 7 936  | 203 751   | 15.6 M  |
| `terrain`   | 81     | —         | 0.5 M   |
| `prop_pool` | 6      | 6         | 684     |
| everything else | < 200 | —     | < 100 k |

Forest owns 99 % of the scene. With 7 936 InstancedMesh nodes covering
204 k instances, the average batch is 25 instances per draw call — well
below the ~100-instance break-even where instancing actually pays for the
state-setup overhead. The current `forest_props.ts` strategy of one
InstancedMesh per `(chunk × sub-model × material)` is fragmenting work
finer than the GPU wants to chew it.

`prop_instance_pool.ts` is the second offender. Each of its
InstancedMeshes has `frustumCulled = false`, so all 4 096 slots upload
and render every frame regardless of where the instances physically are
in the world. The comment in the file acknowledges this — it's a
workaround for InstancedMesh's default model-space bounding sphere — but
the workaround scales linearly with prop count and fights against any
chunk-level culling we want to do.

The user's instinct ("we have chunk divisions in place — why are we
operating on so many objects?") is correct. The fix is architectural,
not a tuning knob.

## Goal

A single primitive — `InstancePool` — that:

1. Owns **all** procedurally-placed static instanced rendering on the
   client (forest decorations, server props, future rocks/litter/etc).
2. Separates **what exists in the world** (a CPU-side spatial index keyed
   by chunk) from **what is currently rendered** (per-archetype
   InstancedMeshes whose `count` and `instanceMatrix` are rewritten each
   frame from the visible chunk slice).
3. Keeps Three.js's frustum culling out of the picture — the InstancedMesh
   bounding spheres span the whole world; we cull ourselves at chunk
   granularity.

Target: ≤ 100 draw calls per render pass, 60 FPS sustained with shadows
on, no per-frame rebuild allocation.

## Architecture

### Archetype concept

An **archetype** is a stable, fully-baked GPU resource:

```ts
type ArchetypeSpec = {
  geometry:      THREE.BufferGeometry;  // already merged, voxelCenter attribute baked
  material:      THREE.Material;        // canopyFade-registered if voxel-style
  castShadow:    boolean;
  receiveShadow: boolean;
};
```

Archetype IDs are arbitrary strings. The pool builds a single
`THREE.InstancedMesh(geo, mat, MAX_SLOTS)` per archetype, lazily on first
registration. Two callers asking for `"tree_oak|matId_3"` get the same
archetype — the pool is the single source of truth for instanced GPU
resources.

Archetypes are **never recomputed per frame**. They are registered once
and reused.

### Handles and the spatial index

A **handle** is one logical world thing — a tree, a server-spawned prop,
a future rock. Each handle has:

```ts
type InstanceSlot = {
  archetypeId: string;
  matrix:      THREE.Matrix4;   // world-space transform
};

// InstancePool stores per-handle:
//   { chunkKey: string, slots: readonly InstanceSlot[] }
```

The pool maintains:
- `handles:        Map<handleKey, HandleEntry>`
- `chunkHandles:   Map<chunkKey,  Set<handleKey>>`
- `archetypes:     Map<archetypeId, ArchetypeEntry>`

`handleKey` and `chunkKey` are caller-chosen strings. Convention:
- Forest tree: handleKey `"forest:cx,cy,lx,ly"`, chunkKey `"cx,cy"`.
- Server prop: handleKey is the entityId, chunkKey is derived from world
  position (`floor(x / 32),floor(y / 32)`).

### Per-frame update

```
update(visibleChunks: ReadonlySet<string>):
  for each archetype: writeIndex = 0
  for chunkKey in visibleChunks:
    for handleKey in chunkHandles[chunkKey]:
      for slot in handles[handleKey].slots:
        archetype = archetypes[slot.archetypeId]
        archetype.instanceMatrix.set(slot.matrix.elements, archetype.writeIndex * 16)
        archetype.writeIndex++
  for each archetype:
    mesh.count = writeIndex
    instanceMatrix.needsUpdate = true   // see "Risks" — may dirty-track later
```

Worst-case CPU cost (~30 visible chunks × ~16 handles × ~2 slots = ~960
matrix copies × 16 floats = 15 k float writes per frame) is comfortably
under 1 ms. No allocation in the hot path; matrix data flows
`source matrix → typed array` via `Matrix4.toArray(target, offset)`.

### Why InstancedMesh frustumCulled stays false

We cull at chunk granularity ourselves. Three.js's per-mesh culling can't
help — the global InstancedMesh's bounding sphere spans the world by
design. Setting `frustumCulled = false` is the explicit declaration that
"the pool owns visibility, not Three.js".

## Public API

```ts
class InstancePool {
  constructor(scene: THREE.Scene);

  // ── archetype lifecycle ────────────────────────────────────────────
  /**
   * Idempotent. The first call wins; subsequent calls with the same id
   * are no-ops even if spec differs.
   */
  registerArchetype(id: string, spec: ArchetypeSpec): void;

  // ── handle lifecycle ───────────────────────────────────────────────
  /**
   * Add a logical thing in the world. `slots` may reference any number
   * of archetypes; each archetype contributes one InstancedMesh slot
   * to the rendered output for this handle.
   *
   * If `handleKey` already exists, the prior registration is replaced
   * (cheap, no GPU work — this is the "moved/updated" path though we
   * don't expect to use it for static props).
   */
  add(handleKey: string, chunkKey: string, slots: readonly InstanceSlot[]): void;

  remove(handleKey: string): void;
  has(handleKey: string): boolean;

  /**
   * Drop every handle whose key starts with `prefix`.
   * Used by ForestPropsRenderer.reset on tile transition (all its
   * handles begin with "forest:").
   */
  removeByPrefix(prefix: string): void;

  // ── frame loop ─────────────────────────────────────────────────────
  /**
   * Rewrite per-archetype instance buffers from the slice of handles
   * whose chunkKey is in `visibleChunks`. Called once per frame from
   * GameRenderer.render() before any renderer.render() call.
   */
  update(visibleChunks: ReadonlySet<string>): void;

  // ── auxiliary ──────────────────────────────────────────────────────
  /**
   * Used by HoverOutlineRenderer to build proxy meshes that match a
   * handle's slot transforms. Returns a *copy* of the slot list so the
   * caller can hold it without aliasing pool state.
   */
  buildHoverShells(handleKey: string): THREE.Mesh[];

  dispose(): void;
}
```

## Culling strategy

Initial implementation: reuse the existing 9×9 chunk window already in
use for terrain in `renderer.ts:1180-1185`:

```ts
const visible = new Set<string>();
for (const [key] of terrainMeshes) {
  const [cx, cy] = key.split(",").map(Number);
  if (Math.abs(cx - pChunkX) <= 4 && Math.abs(cy - pChunkY) <= 4) visible.add(key);
}
```

This 4-chunk-radius (128 world units) window encompasses both the main
camera's typical view and the 60-unit shadow frustum. Conservative —
some chunks in the corners of the 9×9 might be off-screen — but cheap
and known-correct. Refining to a real frustum check is a follow-up
optimisation, not part of this refactor.

## Phases

Each phase is a single commit. Each commit fully replaces — no parallel
implementations, no shims, no flags. Per `CLAUDE.md` refactor philosophy.

### Phase 1 — primitive + helper extraction (T-164)

Land the InstancePool class with no callers yet, and extract the voxel
geometry helpers from `prop_instance_pool.ts` into their own module so
both pools (the about-to-be-rewritten forest one and the still-alive
prop one) import from a shared location.

Files:
- **New** `packages/client/src/render/voxel_geo.ts` — moves
  `buildSubModelGeo`, `buildLocalDispGeo`, `mergeGeos` out of
  `prop_instance_pool.ts`. Pure functions, no class.
- **New** `packages/client/src/render/instance_pool.ts` — the
  InstancePool class. Tested manually via the next phase; no isolated
  unit test (the project doesn't have a render-test harness).
- **Edit** `packages/client/src/render/prop_instance_pool.ts` — the
  helpers are now imported from `./voxel_geo.ts`. Drop the in-file
  copies. The PropInstancePool class itself is unchanged in this phase.
- **Edit** `packages/client/src/render/forest_props.ts` — import from
  `./voxel_geo.ts` instead of `./prop_instance_pool.ts`. No behaviour
  change.
- **Edit** `packages/client/src/render/renderer.ts` — construct
  `this.instancePool = new InstancePool(this.scene)` next to the
  existing `propPool`. Wire `instancePool.update(visibleChunks)` into
  the render loop just before the existing terrain visibility loop is
  reused to compute the visible-chunks set.

Done when:
- `deno check packages/client/src/game.ts` passes.
- Game runs identically — InstancePool exists, has zero handles, its
  per-frame `update()` is a no-op for empty handle maps.
- HUD draws/tris numbers are unchanged from before this phase.

### Phase 2 — forest migration (T-165)

Rewrite `forest_props.ts`. ForestPropsRenderer becomes a **data source**
that registers archetypes and handles into `InstancePool`. It no longer
creates `THREE.InstancedMesh`, `THREE.BufferGeometry`, or `THREE.Material`
directly.

Per-tree work in `decorateChunk`:
1. For each (def × matId) pair the tree contributes — main model and
   each resolved sub-object — call
   `instancePool.registerArchetype("forest:" + def.id + "|" + matId, ...)`.
   Idempotent — only the first call per archetype id does work.
2. Build the per-tree slot list (one slot per (def × matId) the tree
   uses, with the world matrix for that part).
3. Call `instancePool.add("forest:" + cx + "," + cy + ":" + lx + "," + ly, "" + cx + "," + cy, slots)`.

The class fields `geoCache`, `matCache`, `chunkMeshes` are deleted —
their concerns belong to InstancePool now. `decorated`, `queue`,
`active`, `modelReady`, the constructor's `world.onChunkKinds`
subscription, `start()`, the `drainBatch` requestAnimationFrame loop —
all preserved.

`reset()` becomes:
```ts
reset(): void {
  this.instancePool.removeByPrefix("forest:");
  this.decorated.clear();
  this.queue.length = 0;
  this.active = false;
}
```

Done when:
- Forest renders pixel-identically to before (same tree positions,
  rotations, geometry; same shadows; same canopyFade behaviour).
- HUD draws drop materially — expected ~10× reduction (660 → ~60).
- HUD tris number is roughly unchanged (same content, just batched).
- Tile transition cleans up the previous tile's forest correctly.
- `deno check` clean; running the game shows the FPS jump that
  motivated this refactor.

### Phase 3 — prop_instance_pool deletion (T-166)

Delete `prop_instance_pool.ts` entirely. The renderer uses InstancePool
directly for server props.

Files:
- **Delete** `packages/client/src/render/prop_instance_pool.ts`.
- **Edit** `packages/client/src/render/renderer.ts`:
  - `propPool` field, its construction, and `getPropPool()` are gone.
  - The `else` branch in `updateEntity()` that calls
    `this.propPool.addProp(...)` is rewritten to:
    1. Compute or reuse the merged voxel geometry per (def×matId) via
       `voxel_geo.buildSubModelGeo`.
    2. Register one archetype per (def×matId) used.
    3. Build slots for the entity (one per archetype).
    4. Call `this.instancePool.add(entityId, chunkKey, slots)` where
       `chunkKey = floor(worldPos.x / 32) + "," + floor(worldPos.z / 32)`.
  - Remove path: `this.instancePool.remove(entityId)` on entity destroy
    or AoI exit.
  - `propPool.dispose()` becomes `instancePool.dispose()` (the latter
    handles its own contents).
  - `getPropPool()` becomes `getInstancePool()` if anything still calls
    it; otherwise dropped.
- **Edit** `packages/client/src/render/hover_outline.ts` — calls
  `instancePool.buildHoverShells(entityId)` instead of
  `propPool.buildHoverShells(entityId)`. Behaviour identical: returns
  `THREE.Mesh[]` with the entity's slot transforms baked in, sharing
  the pool's geometry/material.
- **Edit** `packages/client/src/interaction/interaction_system.ts` if
  any reference exists — none expected, but worth a grep before commit.

The VELOCITY_EPSILON_SQ defer-until-settled gate in `updateEntity()`
is preserved verbatim. It's a server-prop concern, not a pool concern.

Done when:
- Ground-item, ruin, and resource-node entities still render with the
  same geometry, position, and rotation as before.
- Hover outline still highlights static props on hover.
- AoI exit / entity destroy correctly removes the prop.
- No references to `PropInstancePool`, `propPool`, or
  `prop_instance_pool.ts` remain in the source tree.
- HUD shows further draw-call reduction (the 6 prop_pool draws fold
  into the existing forest archetypes where they overlap).

### Phase 4 — perf validation + plan deletion (T-167)

Lightweight validation pass and final cleanup.

- Run the game, capture the HUD numbers (FPS, draws, tris, all the ms
  buckets) in a representative scene with shadows on. Record before
  (35 FPS, 1300 draws, 2 M tris) and after.
- Confirm 60 FPS sustained on the user's machine.
- **Delete** `INSTANCE_POOL_PLAN.md` (this file).
- Mark T-164 through T-167 done in `TICKETS.md` with the commit hashes
  for each phase.

Done when:
- Plan file is gone.
- All four tickets show `Status: done` with a commit hash.
- The user can play in a forested area at 60 FPS with shadows on.

## Risks & mitigations

1. **Per-frame matrix re-upload.** First impl rewrites every archetype's
   instance buffer every frame. If `instanceMatrix.needsUpdate = true`
   becomes a bottleneck (uploading ~30 KB to GPU every frame),
   dirty-track the visible-chunks set: only mark archetypes dirty when
   the visible chunk list changes or a handle is added/removed inside a
   visible chunk. Defer this optimisation until Phase 4 metrics show it
   matters.

2. **Shadow frustum vs main frustum mismatch.** Trees inside the shadow
   camera's frustum but outside the main camera's frustum still need to
   render so their shadows fall into the visible scene. The 9×9 chunk
   window (128 world-unit radius) comfortably covers the 60-unit shadow
   frustum and a typical 35-unit main-camera reach. If the camera is
   ever changed to a longer-throw view, revisit this.

3. **Per-frame instance ordering.** If the visible-chunks iteration
   order is unstable (e.g. depends on `Map` iteration order which
   *is* insertion order in JS but could be surprised by handle
   churn), instances could shuffle between frames and produce
   z-fighting flicker on co-planar geometry. Mitigation: chunk keys
   are inserted in a stable order (chunk arrival order on the wire)
   and never reordered. Within a chunk, handle keys are inserted in
   tree-grid scan order. Stable.

4. **canopyFade material registration.** `canopyFade.register(mat,
   { voxelMode: true })` runs once per material currently. After the
   refactor it still runs once per archetype's material at archetype
   registration. Same lifecycle, different owner. The shared material
   between forest archetypes and server prop archetypes is fine —
   canopyFade.register is idempotent on already-registered materials.

5. **Hover outline lifecycle.** `buildHoverShells` returns wrapper
   `THREE.Mesh` objects that share pool-owned geometry/material. The
   caller (HoverOutlineRenderer) must continue to dispose only the Mesh
   wrapper, never the geometry/material. Already documented in
   `prop_instance_pool.ts`'s `buildHoverShells`; carry the comment over.

6. **interaction_system.ts pick boxes.** Static-prop pick boxes are
   registered separately via `addStaticEntity` and tracked in
   `propPositions`. This pathway is unchanged — it predates and is
   parallel to the pool. The Phase 3 commit must not accidentally drop
   `propPositions.set(entityId, worldPos)` after the prop is registered.

## Backwards compatibility

None. Per `CLAUDE.md`:

> No backwards compatibility with on-disk state or wire formats. Saves,
> heritage files, save files, and the binary protocol may all break
> between refactors.

This refactor is client-only and changes nothing on the wire or on
disk. No save migration needed.
