/**
 * Client-side forest decoration driven by the per-chunk KindGrid.
 *
 * Server publishes KindGrid alongside Heightmap + OpenMask + MaterialGrid for
 * every terrain chunk. Forest pixels are impassable on the server (OpenMask
 * blocks them) but carry no entity. This renderer turns those pixels into
 * actual trees on the client without any per-tree server entities.
 *
 * Per-chunk InstancedMesh strategy
 * --------------------------------
 * The naive approach — one big InstancedMesh per (model × material × scale)
 * spanning the whole tile — has a huge bounding sphere and either renders
 * the entire forest every frame or culls all of it. Frustum culling
 * effectively can't help.
 *
 * Instead we allocate one InstancedMesh per (chunk, sub-model, material).
 * Each chunk's mesh has a small, tight bounding sphere (32 × 32 cell area
 * plus tree height), so Three.js's normal frustum cull skips chunks behind
 * the camera, beyond the canopy, or off-screen. Geometry and materials are
 * shared across chunks — only the InstancedMesh wrappers are per-chunk —
 * so the GPU memory cost is one set of voxel geos, not 256.
 *
 * Trees are deterministic in shape and orientation: a 2D hash of the cell's
 * world coords seeds branch-pool resolution AND Y rotation, so the same
 * tile re-renders identically on any client.
 */
import * as THREE from "three";
import type { ContentCache } from "../state/content_cache.ts";
import type { ClientWorld } from "../state/client_world.ts";
import type { MaterialDef, ModelDefinition } from "@voxim/content";
import { resolveSubObjects } from "@voxim/content";
import { buildSubModelGeo } from "./prop_instance_pool.ts";
import { getVoxelTexture } from "./material_textures.ts";
import { canopyFade } from "./canopy_fade.ts";

const CHUNK_SIDE = 32;

/** Mirror of atlas's BOUNDARY_KIND_FOREST; literal keeps atlas out of the bundle. */
const BOUNDARY_KIND_FOREST = 2;

const FOREST_MODEL_ID = "tree_oak";
/**
 * Matches what spawner.ts builds for the regular `tree` prefab:
 *   defaultEntityScale (game_config.json: 0.35) × modelScale (tree.json: 2) = 0.7.
 */
const FOREST_TREE_SCALE = { x: 0.7, y: 0.7, z: 0.7 } as const;
/**
 * One tree per N×N cell block. Lower → denser forest, more InstancedMesh
 * count per chunk. Stride 7 ≈ what the old server-side spawner used.
 */
const FOREST_TREE_STRIDE = 7;

interface ChunkGroup {
  def: ModelDefinition;
  matId: number;
  matrices: THREE.Matrix4[];
}

export class ForestPropsRenderer {
  private readonly scene: THREE.Scene;
  private readonly content: ContentCache;
  private readonly world: ClientWorld;
  /** Coords already populated, keyed by "chunkX,chunkY". */
  private readonly decorated = new Set<string>();
  /** Geometry shared across chunks: keyed by "${modelId}|${matId}". */
  private readonly geoCache = new Map<string, THREE.BufferGeometry>();
  /** Material shared across chunks: keyed by matId. */
  private readonly matCache = new Map<number, THREE.Material>();
  /** Per-chunk meshes for cleanup on tile transition. */
  private readonly chunkMeshes = new Map<string, THREE.InstancedMesh[]>();
  /** Cached tree-model load promise — shared across every chunk listener. */
  private modelReady: Promise<void> | null = null;
  /** Chunks queued during loading (deferred so JS thread can drain QUIC). */
  private readonly queue: Array<{ coord: string; kinds: Uint16Array }> = [];
  /** Gates decoration: false during loading, true after start(). */
  private active = false;

  constructor(scene: THREE.Scene, content: ContentCache, world: ClientWorld) {
    this.scene = scene;
    this.content = content;
    this.world = world;
    world.onChunkKinds((coord, kinds) => {
      if (!this.active) {
        if (!this.decorated.has(coord)) this.queue.push({ coord, kinds });
        return;
      }
      void this.decorateChunk(coord, kinds);
    });
  }

  /**
   * Begin decorating. Call once the loading screen is gone. Drains the
   * queue across animation frames so the first paint isn't a single
   * multi-hundred-tree blocking call.
   */
  start(): void {
    if (this.active) return;
    this.active = true;
    const drainBatch = () => {
      if (!this.active) return;
      const deadline = performance.now() + 8;
      while (this.queue.length > 0 && performance.now() < deadline) {
        const item = this.queue.shift()!;
        void this.decorateChunk(item.coord, item.kinds);
      }
      if (this.queue.length > 0) requestAnimationFrame(drainBatch);
    };
    requestAnimationFrame(drainBatch);
  }

  private async decorateChunk(coord: string, kinds: Uint16Array): Promise<void> {
    if (this.chunkMeshes.has(coord)) return;
    this.decorated.add(coord);

    if (!this.modelReady) {
      this.modelReady = this.content.prefetchModel(FOREST_MODEL_ID);
    }
    await this.modelReady;
    const def = this.content.getModelSync(FOREST_MODEL_ID);
    if (!def) return;

    const sep = coord.indexOf(",");
    const cx = Number(coord.slice(0, sep));
    const cy = Number(coord.slice(sep + 1));

    // Bucket every tree's (sub-model × material) contribution as an instance
    // matrix grouped by `${modelId}|${matId}`. One InstancedMesh per group.
    const groups = new Map<string, ChunkGroup>();

    const half = (FOREST_TREE_STRIDE / 2) | 0;
    for (let ly = half; ly < CHUNK_SIDE; ly += FOREST_TREE_STRIDE) {
      for (let lx = half; lx < CHUNK_SIDE; lx += FOREST_TREE_STRIDE) {
        if (kinds[lx + ly * CHUNK_SIDE] !== BOUNDARY_KIND_FOREST) continue;

        const wx = cx * CHUNK_SIDE + lx + 0.5;
        const wy = cy * CHUNK_SIDE + ly + 0.5;
        const wz = this.world.getTerrainHeight(wx, wy);
        const h = hash2u(wx | 0, wy | 0);
        const seed = h >>> 16;
        const rotationY = ((h & 0xFFFF) / 0xFFFF) * Math.PI * 2;

        const resolved = resolveSubObjects(def.subObjects, seed);

        // Tree's world transform = translate(world) × rotateY.
        // Three.js coord mapping: model(x,y,z=up) → three(x, z, y).
        const treeMat = new THREE.Matrix4()
          .makeTranslation(wx, wz, wy)
          .multiply(new THREE.Matrix4().makeRotationY(rotationY));

        // Main model nodes — identity sub-transform.
        if (def.nodes.length > 0) this.bucket(groups, def, treeMat);

        // Sub-objects — each has a local offset + rotation in model space.
        for (const sub of resolved) {
          const subDef = this.content.getModelSync(sub.modelId);
          if (!subDef) continue;
          const t = sub.transform;
          // Same coord mapping (model→three) we use for the prop pool.
          const subPos = new THREE.Vector3(
            t.x * FOREST_TREE_SCALE.x,
            t.z * FOREST_TREE_SCALE.z,
            t.y * FOREST_TREE_SCALE.y,
          );
          const subQuat = new THREE.Quaternion()
            .setFromEuler(new THREE.Euler(t.rotX, t.rotZ, t.rotY, "XYZ"));
          const subMat = new THREE.Matrix4()
            .compose(subPos, subQuat, new THREE.Vector3(1, 1, 1));
          const subWorld = new THREE.Matrix4().multiplyMatrices(treeMat, subMat);
          this.bucket(groups, subDef, subWorld);
        }
      }
    }

    if (groups.size === 0) return;

    // Realise each (model × material) group into one InstancedMesh, sized to
    // the actual instance count and given a tight bounding sphere so Three.js
    // can frustum-cull this chunk independently.
    const meshes: THREE.InstancedMesh[] = [];
    for (const g of groups.values()) {
      const geo = this.getOrBuildGeo(g.def, g.matId);
      const mat = this.getOrBuildMaterial(g.matId);
      const mesh = new THREE.InstancedMesh(geo, mat, g.matrices.length);
      for (let i = 0; i < g.matrices.length; i++) {
        mesh.setMatrixAt(i, g.matrices[i]);
      }
      mesh.instanceMatrix.needsUpdate = true;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      // computeBoundingSphere walks instance matrices and produces a sphere
      // covering all of them. Combined with frustumCulled = true this is the
      // whole point of going per-chunk: chunks not in view skip the entire
      // geometry pipeline (including the shadow pass).
      mesh.computeBoundingSphere();
      mesh.frustumCulled = true;
      this.scene.add(mesh);
      meshes.push(mesh);
    }
    this.chunkMeshes.set(coord, meshes);
  }

  private bucket(
    groups: Map<string, ChunkGroup>,
    def: ModelDefinition,
    matrix: THREE.Matrix4,
  ): void {
    // Each unique materialId in the model gets its own InstancedMesh.
    const matIds = new Set(def.nodes.map((n) => n.materialId));
    for (const matId of matIds) {
      const key = `${def.id}|${matId}`;
      let g = groups.get(key);
      if (!g) {
        g = { def, matId, matrices: [] };
        groups.set(key, g);
      }
      g.matrices.push(matrix.clone());
    }
  }

  private getOrBuildGeo(def: ModelDefinition, matId: number): THREE.BufferGeometry {
    const key = `${def.id}|${matId}`;
    const existing = this.geoCache.get(key);
    if (existing) return existing;
    const geo = buildSubModelGeo(def.nodes, matId, FOREST_TREE_SCALE);
    this.geoCache.set(key, geo);
    return geo;
  }

  private getOrBuildMaterial(matId: number): THREE.Material {
    const existing = this.matCache.get(matId);
    if (existing) return existing;
    const matDef: MaterialDef | undefined = this.content.getMaterialSync(matId);
    const color = matDef?.color ?? 0x888888;
    const shininess = matDef ? Math.round((1 - matDef.roughness) * 80) : 0;
    const emissive = matDef && matDef.emissive > 0
      ? new THREE.Color(color).multiplyScalar(matDef.emissive * 0.7)
      : new THREE.Color(0);
    const tex = getVoxelTexture(matId, color);
    const mat = new THREE.MeshPhongMaterial({
      color: tex ? 0xffffff : color,
      map: tex ?? undefined,
      flatShading: true,
      shininess,
      emissive,
    });
    canopyFade.register(mat, { voxelMode: true });
    this.matCache.set(matId, mat);
    return mat;
  }

  /** Drop every chunk's meshes. Used on tile transition before the next
   *  tile starts arriving. Geometry / material caches stay — same models
   *  are reused on the next tile. */
  reset(): void {
    for (const meshes of this.chunkMeshes.values()) {
      for (const m of meshes) this.scene.remove(m);
    }
    this.chunkMeshes.clear();
    this.decorated.clear();
    this.queue.length = 0;
    this.active = false;
  }
}

/** Cheap 2D integer hash. Top bits go to the procedural seed, bottom bits
 *  to rotation, so the two derivations are uncorrelated visually. */
function hash2u(x: number, y: number): number {
  let n = ((x * 1619) ^ (y * 31337) ^ 0x9E3779B1) | 0;
  n = ((n << 13) ^ n) | 0;
  n = (n * ((n * n * 15731 + 789221) | 0) + 1376312589) | 0;
  return n >>> 0;
}
