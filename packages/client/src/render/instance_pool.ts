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
 *   - **Per-frame `update(visibleChunks)`** rewrites every archetype's
 *     instance buffer from the slice of handles whose chunk is currently
 *     visible. Cost is O(visibleChunks × handlesPerChunk × slotsPerHandle),
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
  /** Per-frame write head; reset to 0 at the start of every update(). */
  writeIndex:  number;
  /** Whether this archetype received any writes this frame (for `needsUpdate`). */
  touched:     boolean;
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

  constructor(scene: THREE.Scene) {
    this.scene = scene;
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

    this.archetypes.set(id, { mesh, matrixData, writeIndex: 0, touched: false });
  }

  // ── handle lifecycle ─────────────────────────────────────────────────

  /**
   * Register a logical thing in the world. If `handleKey` already exists
   * the prior registration is replaced (cheap, no GPU work).
   * Every archetypeId referenced in `slots` must already be registered.
   */
  add(handleKey: string, chunkKey: string, slots: readonly InstanceSlot[]): void {
    const existing = this.handles.get(handleKey);
    if (existing && existing.chunkKey !== chunkKey) {
      // Move between chunks: rip out of the old chunk's set first.
      this.chunkHandles.get(existing.chunkKey)?.delete(handleKey);
    }
    this.handles.set(handleKey, { chunkKey, slots });

    let bucket = this.chunkHandles.get(chunkKey);
    if (!bucket) { bucket = new Set(); this.chunkHandles.set(chunkKey, bucket); }
    bucket.add(handleKey);
  }

  remove(handleKey: string): void {
    const entry = this.handles.get(handleKey);
    if (!entry) return;
    this.handles.delete(handleKey);
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
   * Rewrite per-archetype instance buffers from the slice of handles
   * whose chunk is in `visibleChunks`. Call once per frame from
   * GameRenderer.render() before any renderer.render() call.
   *
   * Iteration order over `visibleChunks` and over each chunk's handles
   * determines the per-frame instance order in the GPU buffer. Both are
   * insertion-stable (`Map`/`Set` iteration order is insertion order in
   * JS), so as long as the caller passes `visibleChunks` deterministically
   * the rendered batches don't shuffle frame-to-frame.
   */
  update(visibleChunks: Iterable<string>): void {
    // Reset every archetype's write head.
    for (const arch of this.archetypes.values()) {
      arch.writeIndex = 0;
      arch.touched    = false;
    }

    // Walk visible chunks → handles → slots, dispatching to each
    // archetype's matrix buffer.
    for (const chunkKey of visibleChunks) {
      const bucket = this.chunkHandles.get(chunkKey);
      if (!bucket) continue;
      for (const handleKey of bucket) {
        const entry = this.handles.get(handleKey);
        if (!entry) continue;
        for (const slot of entry.slots) {
          const arch = this.archetypes.get(slot.archetypeId);
          if (!arch) continue;
          if (arch.writeIndex >= MAX_INSTANCES_PER_ARCHETYPE) {
            // Hit the cap — silently drop. If this fires in practice, raise
            // MAX_INSTANCES_PER_ARCHETYPE rather than letting the pool clip.
            continue;
          }
          slot.matrix.toArray(arch.matrixData, arch.writeIndex * 16);
          arch.writeIndex++;
          arch.touched = true;
        }
      }
    }

    // Commit: every archetype gets a fresh `count` and a needsUpdate flag
    // so Three.js re-uploads the mutated portion of the buffer.
    for (const arch of this.archetypes.values()) {
      arch.mesh.count = arch.writeIndex;
      // The buffer was rewritten this frame either with fresh data or to
      // count=0; in both cases mark dirty so the previous frame's tail
      // can't ghost into this frame's draw.
      if (arch.touched || arch.mesh.count === 0) {
        arch.mesh.instanceMatrix.needsUpdate = true;
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
