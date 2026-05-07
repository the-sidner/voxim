/**
 * Client-side forest decoration driven by the per-chunk KindGrid.
 *
 * Server publishes KindGrid alongside Heightmap + OpenMask + MaterialGrid for
 * every terrain chunk. Forest pixels are impassable on the server (OpenMask
 * blocks them) but carry no entity. This renderer turns those pixels into
 * actual trees on the client without any per-tree server entities.
 *
 * Data-source role
 * ----------------
 * As of T-165, ForestPropsRenderer no longer creates InstancedMesh,
 * Geometry, or Material objects of its own. It walks each newly-arrived
 * chunk's kinds grid, registers one InstancePool archetype per
 * (sub-model × material) pair the local trees use, and adds one
 * InstancePool handle per tree position. The pool owns visibility,
 * culling, and per-frame instance buffer rebuild.
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
import { buildSubModelGeo } from "./voxel_geo.ts";
import { getVoxelTexture } from "./material_textures.ts";
import { canopyFade } from "./canopy_fade.ts";
import type { InstancePool, InstanceSlot } from "./instance_pool.ts";

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
 * One tree per N×N cell block. Lower → denser forest, more handles per chunk.
 * Stride 7 ≈ what the old server-side spawner used.
 */
const FOREST_TREE_STRIDE = 7;

/** Prefix used for every handle this renderer registers. Lets `reset()`
 *  drop the whole forest in one InstancePool call. */
const HANDLE_PREFIX = "forest:";

function archetypeId(modelId: string, matId: number): string {
  return `forest:${modelId}|${matId}`;
}

export class ForestPropsRenderer {
  private readonly content:      ContentCache;
  private readonly world:        ClientWorld;
  private readonly instancePool: InstancePool;
  /** Coords already populated, keyed by "chunkX,chunkY". */
  private readonly decorated = new Set<string>();
  /** Cached tree-model load promise — shared across every chunk listener. */
  private modelReady: Promise<void> | null = null;
  /** Chunks queued during loading (deferred so JS thread can drain QUIC). */
  private readonly queue: Array<{ coord: string; kinds: Uint16Array }> = [];
  /** Gates decoration: false during loading, true after start(). */
  private active = false;

  constructor(instancePool: InstancePool, content: ContentCache, world: ClientWorld) {
    this.instancePool = instancePool;
    this.content      = content;
    this.world        = world;
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
    if (this.decorated.has(coord)) return;
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

        const slots: InstanceSlot[] = [];

        // Main model nodes — identity sub-transform.
        if (def.nodes.length > 0) this.appendSlots(slots, def, treeMat);

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
          this.appendSlots(slots, subDef, subWorld);
        }

        if (slots.length === 0) continue;
        const handleKey = `${HANDLE_PREFIX}${cx},${cy}:${lx},${ly}`;
        this.instancePool.add(handleKey, coord, slots);
      }
    }
  }

  /**
   * Build one InstanceSlot per (def, materialId) pair the model uses,
   * lazily registering archetypes on first sight. The slot's matrix is
   * the world transform passed in — same matrix shared across every
   * matId from the same model node group, since the model space is
   * identical and only the per-vertex material attribute differs.
   */
  private appendSlots(out: InstanceSlot[], def: ModelDefinition, matrix: THREE.Matrix4): void {
    const matIds = new Set(def.nodes.map((n) => n.materialId));
    for (const matId of matIds) {
      const id = archetypeId(def.id, matId);
      if (!this.instancePool.hasArchetype(id)) {
        const geometry = buildSubModelGeo(def.nodes, matId, FOREST_TREE_SCALE);
        const material = this.buildMaterial(matId);
        this.instancePool.registerArchetype(id, {
          geometry, material, castShadow: true, receiveShadow: true,
        });
      }
      out.push({ archetypeId: id, matrix: matrix.clone() });
    }
  }

  private buildMaterial(matId: number): THREE.Material {
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
    return mat;
  }

  /**
   * Drop every forest handle from the pool. Used on tile transition
   * before the next tile starts arriving. Archetypes (geometry +
   * material) stay registered — same models are reused on the next
   * tile, so the GPU resources are valid forever.
   */
  reset(): void {
    this.instancePool.removeByPrefix(HANDLE_PREFIX);
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
