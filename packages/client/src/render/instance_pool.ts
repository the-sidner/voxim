/**
 * InstancePool — single owner of all procedurally-placed static instanced
 * rendering on the client (forest decorations, server props, future rocks
 * and litter).
 *
 * Architecture
 * ------------
 *   - **Archetype**: a (geometry, material, shadow flags) bundle keyed by
 *     a stable string id. Each archetype owns one THREE.InstancedMesh with
 *     a fixed maximum slot count.  Three.js frustum culling is disabled —
 *     visibility is owned by the pool, not Three.js.
 *
 *   - **Handle**: one logical thing in the world (a tree, a server-spawned
 *     prop). A handle has a chunk key (which spatial bucket it lives in)
 *     and a list of slots. Each slot is a (archetypeId, world matrix)
 *     pair — a thing that draws into N archetypes registers N slots.
 *
 *   - **Per-frame `update(visibleChunks)`** rewrites DIRTY archetypes'
 *     instance buffers from the slice of handles whose chunk is currently
 *     visible. An archetype is dirty when one of its handles was added or
 *     removed since the last update, or when the visible chunk set changed;
 *     a clean archetype's buffer, count, and GPU copy are left completely
 *     untouched (static scatter/props upload NOTHING while the player stays
 *     within one chunk; per-frame re-`add()`ers — particles, decaying
 *     decals — mark themselves dirty every frame and stay live). Rewritten
 *     buffers upload only `[0, writeIndex×16)` via `addUpdateRange`, never
 *     the full fixed-capacity backing array. Cost is
 *     O(visibleChunks × handlesPerChunk × slotsPerHandle) worst case,
 *     no allocation in the hot path.
 *
 * The pool fixes two pre-existing issues in one swing:
 *   1. The forest had 7 936 InstancedMeshes for 204 k instances (~25 each).
 *      Now there's one InstancedMesh per archetype, each batching every
 *      visible instance of its (sub-model × material) combination.
 *   2. The old PropInstancePool used `frustumCulled = false` and rendered
 *      all 4 096 slots every frame regardless of where the instances were
 *      in the world. Now we only upload matrices for instances that pass
 *      our chunk-level visibility check.
 *
 * See `INSTANCE_POOL_PLAN.md` (root) for the full design rationale.
 */

import * as THREE from "three";

/** Maximum instances per archetype. Exceeding this drops extras and warns. */
const MAX_INSTANCES_PER_ARCHETYPE = 4096;

export interface ArchetypeSpec {
  geometry:      THREE.BufferGeometry;
  material:      THREE.Material;
  castShadow:    boolean;
  receiveShadow: boolean;
}

export interface InstanceSlot {
  archetypeId: string;
  matrix:      THREE.Matrix4;
}

interface ArchetypeEntry {
  mesh:        THREE.InstancedMesh;
  /** Direct Float32Array view into the InstancedBufferAttribute's storage. */
  matrixData:  Float32Array;
  /** Write head for the current rewrite; reset to 0 when the archetype is dirty. */
  writeIndex:  number;
  /** A handle drawing into this archetype was added/removed since the last
   *  update — the visible instance list must be rewritten and re-uploaded. */
  dirty:       boolean;
}

interface HandleEntry {
  chunkKey: string;
  slots:    readonly InstanceSlot[];
}

export class InstancePool {
  private readonly scene:         THREE.Scene;
  private readonly archetypes     = new Map<string, ArchetypeEntry>();
  private readonly handles        = new Map<string, HandleEntry>();
  /** chunkKey → set of handleKeys living in that chunk. */
  private readonly chunkHandles   = new Map<string, Set<string>>();
  /** Last update()'s visible chunk keys, in iteration order — a change in
   *  the set (or its order) dirties every archetype. Reused across frames. */
  private readonly lastVisible: string[] = [];

  constructor(scene: THREE.Scene) {
    this.scene = scene;
  }

  /** Mark every archetype a handle's slots draw into as needing a rewrite. */
  private markDirty(slots: readonly InstanceSlot[]): void {
    for (const slot of slots) {
      const arch = this.archetypes.get(slot.archetypeId);
      if (arch) arch.dirty = true;
    }
  }

  // ── archetype lifecycle ──────────────────────────────────────────────

  /**
   * Idempotent. The first call wins; subsequent calls with the same id
   * are no-ops (subsequent specs are silently ignored). Callers must not
   * dispose `spec.geometry` or `spec.material` — the pool owns them now.
   */
  hasArchetype(id: string): boolean {
    return this.archetypes.has(id);
  }

  /** Diagnostic — count of registered archetypes (for HUD). */
  get archetypeCount(): number { return this.archetypes.size; }
  /** Diagnostic — count of all registered handles across every chunk. */
  get handleCount():    number { return this.handles.size; }

  registerArchetype(id: string, spec: ArchetypeSpec): void {
    if (this.archetypes.has(id)) return;
    const mesh = new THREE.InstancedMesh(spec.geometry, spec.material, MAX_INSTANCES_PER_ARCHETYPE);
    mesh.count          = 0;
    mesh.castShadow     = spec.castShadow;
    mesh.receiveShadow  = spec.receiveShadow;
    // Visibility is owned by the pool's per-frame `update()`. Three.js's
    // automatic frustum culling can't help — the InstancedMesh's bounding
    // sphere is in model space at the origin, which would cull the whole
    // batch as soon as the origin left the frustum.
    mesh.frustumCulled  = false;
    mesh.name           = id;
    this.scene.add(mesh);

    // Direct view into the matrix storage so we can write 16 floats per
    // matrix without per-call allocation.
    const matrixData = mesh.instanceMatrix.array as Float32Array;

    this.archetypes.set(id, { mesh, matrixData, writeIndex: 0, dirty: true });
  }

  // ── handle lifecycle ─────────────────────────────────────────────────

  /**
   * Register a logical thing in the world. If `handleKey` already exists
   * the prior registration is replaced (cheap, no GPU work).
   * Every archetypeId referenced in `slots` must already be registered.
   */
  add(handleKey: string, chunkKey: string, slots: readonly InstanceSlot[]): void {
    const existing = this.handles.get(handleKey);
    if (existing) {
      // Replacement: the outgoing slot list's archetypes must rewrite too
      // (the new list may draw into fewer / different archetypes).
      this.markDirty(existing.slots);
      if (existing.chunkKey !== chunkKey) {
        // Move between chunks: rip out of the old chunk's set first.
        this.chunkHandles.get(existing.chunkKey)?.delete(handleKey);
      }
    }
    this.handles.set(handleKey, { chunkKey, slots });
    this.markDirty(slots);

    let bucket = this.chunkHandles.get(chunkKey);
    if (!bucket) { bucket = new Set(); this.chunkHandles.set(chunkKey, bucket); }
    bucket.add(handleKey);
  }

  remove(handleKey: string): void {
    const entry = this.handles.get(handleKey);
    if (!entry) return;
    this.handles.delete(handleKey);
    this.markDirty(entry.slots);
    const bucket = this.chunkHandles.get(entry.chunkKey);
    if (bucket) {
      bucket.delete(handleKey);
      if (bucket.size === 0) this.chunkHandles.delete(entry.chunkKey);
    }
  }

  has(handleKey: string): boolean {
    return this.handles.has(handleKey);
  }

  /**
   * Drop every handle whose key starts with `prefix`. Used by callers
   * that namespace their handles (e.g. ScatterRenderer keys all its
   * handles with "scatter:" so it can clear them all on tile transition).
   */
  removeByPrefix(prefix: string): void {
    for (const handleKey of [...this.handles.keys()]) {
      if (handleKey.startsWith(prefix)) this.remove(handleKey);
    }
  }

  // ── per-frame ────────────────────────────────────────────────────────

  /**
   * Rewrite dirty archetypes' instance buffers from the slice of handles
   * whose chunk is in `visibleChunks`. Call once per frame from
   * GameRenderer.render() before any renderer.render() call.
   *
   * A clean archetype (no handle add/remove since last frame, visible set
   * unchanged) keeps its buffer, count, and GPU copy from the previous
   * frame — zero CPU writes, zero upload. Slot matrices are treated as
   * immutable once registered: to change one, re-`add()` its handle (every
   * live caller already does — particles/decals rebuild their slot lists
   * each frame; scatter/props register fresh matrices once).
   *
   * Iteration order over `visibleChunks` and over each chunk's handles
   * determines the per-frame instance order in the GPU buffer. Both are
   * insertion-stable (`Map`/`Set` iteration order is insertion order in
   * JS), so as long as the caller passes `visibleChunks` deterministically
   * the rendered batches don't shuffle frame-to-frame.
   */
  update(visibleChunks: Iterable<string>): void {
    // Visibility diff — a changed key set (or order) invalidates every
    // archetype's cached instance list. Compared in place against the
    // previous frame's keys; no allocation on the unchanged path.
    let n = 0;
    let visibilityChanged = false;
    for (const chunkKey of visibleChunks) {
      if (n >= this.lastVisible.length || this.lastVisible[n] !== chunkKey) {
        visibilityChanged = true;
        this.lastVisible[n] = chunkKey;
      }
      n++;
    }
    if (n !== this.lastVisible.length) {
      visibilityChanged = true;
      this.lastVisible.length = n;
    }

    let anyDirty = false;
    for (const arch of this.archetypes.values()) {
      if (visibilityChanged) arch.dirty = true;
      if (arch.dirty) {
        arch.writeIndex = 0;
        anyDirty = true;
      }
    }
    if (!anyDirty) return; // fully static frame — nothing to write or upload

    // Walk visible chunks → handles → slots, dispatching to each DIRTY
    // archetype's matrix buffer (clean ones keep last frame's contents).
    for (const chunkKey of this.lastVisible) {
      const bucket = this.chunkHandles.get(chunkKey);
      if (!bucket) continue;
      for (const handleKey of bucket) {
        const entry = this.handles.get(handleKey);
        if (!entry) continue;
        for (const slot of entry.slots) {
          const arch = this.archetypes.get(slot.archetypeId);
          if (!arch || !arch.dirty) continue;
          if (arch.writeIndex >= MAX_INSTANCES_PER_ARCHETYPE) {
            // Hit the cap — silently drop. If this fires in practice, raise
            // MAX_INSTANCES_PER_ARCHETYPE rather than letting the pool clip.
            continue;
          }
          slot.matrix.toArray(arch.matrixData, arch.writeIndex * 16);
          arch.writeIndex++;
        }
      }
    }

    // Commit each rewritten archetype: fresh count, and an update range
    // covering exactly the live matrices — Three.js then uploads
    // writeIndex×16 floats instead of the full 4096-slot backing array.
    // (Anything past writeIndex is stale but `count` keeps it undrawn.)
    for (const arch of this.archetypes.values()) {
      if (!arch.dirty) continue;
      arch.dirty = false;
      arch.mesh.count = arch.writeIndex;
      if (arch.writeIndex > 0) {
        const attr = arch.mesh.instanceMatrix;
        attr.clearUpdateRanges();
        attr.addUpdateRange(0, arch.writeIndex * 16);
        attr.needsUpdate = true;
      }
    }
  }

  // ── auxiliary ────────────────────────────────────────────────────────

  /**
   * Build per-slot proxy meshes for one handle, sharing the pool's
   * geometry/material with the slot's matrix baked in. Used by the hover
   * outline renderer: shells go on a hover-only Three.js layer so the
   * silhouette mask pass picks them up. The caller owns layer assignment
   * and disposal of the wrapper Meshes — geometry/material are pool-owned
   * and must NOT be disposed.
   */
  buildHoverShells(handleKey: string): THREE.Mesh[] {
    const entry = this.handles.get(handleKey);
    if (!entry) return [];
    const out: THREE.Mesh[] = [];
    for (const slot of entry.slots) {
      const arch = this.archetypes.get(slot.archetypeId);
      if (!arch) continue;
      const shell = new THREE.Mesh(arch.mesh.geometry, arch.mesh.material);
      shell.matrixAutoUpdate = false;
      shell.matrix.copy(slot.matrix);
      shell.frustumCulled    = false;
      out.push(shell);
    }
    return out;
  }

  dispose(): void {
    for (const arch of this.archetypes.values()) {
      this.scene.remove(arch.mesh);
      arch.mesh.geometry.dispose();
      (arch.mesh.material as THREE.Material).dispose();
    }
    this.archetypes.clear();
    this.handles.clear();
    this.chunkHandles.clear();
  }
}
