/**
 * GPU-instanced rendering for static props (trees, ruins, resource nodes).
 *
 * One InstancedMesh per (subModelId × materialId × scale) tuple.
 * All instances of the same sub-model share a single BufferGeometry built once
 * from that model's voxels with LOCAL-SPACE vertex displacement — identical for
 * every placement, nobody notices.
 *
 * Draw call cost = num_unique_submaterial_combinations, not num_props.
 * A tile with 1 500 trees (8 branches each, 2 materials) → ~30 draw calls total.
 */

import * as THREE from "three";
import type { ModelDefinition, MaterialDef, ResolvedSubObject } from "@voxim/content";
import { vertexDisp } from "./displacement.ts";
import { getVoxelTexture } from "./material_textures.ts";

/** Maximum instances per (subModel × material × scale) slot. */
const MAX_SLOTS = 4096;

// Reusable scratch to avoid allocations in the hot path.
const _mat4  = new THREE.Matrix4();
const _pos   = new THREE.Vector3();
const _quat  = new THREE.Quaternion();
const _scale = new THREE.Vector3(1, 1, 1);
const _euler = new THREE.Euler();

// ---- geometry helpers -------------------------------------------------------

function makeKey(modelId: string, matId: number, sx: number, sy: number, sz: number): string {
  return `${modelId}|${matId}|${sx.toFixed(3)}|${sy.toFixed(3)}|${sz.toFixed(3)}`;
}

/**
 * Build a single merged BufferGeometry for all voxels of one materialId in a
 * model definition.  Vertex displacement is seeded from local (model-space)
 * position — identical for every instance placed in the world.
 */
function buildSubModelGeo(
  nodes: ModelDefinition["nodes"],
  materialId: number,
  scale: { x: number; y: number; z: number },
): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];

  for (const node of nodes) {
    if (node.materialId !== materialId) continue;
    // Three.js space: model(x, y, z) → three(x*sx, z*sz, y*sy)
    const px = node.x * scale.x;
    const py = node.z * scale.z;
    const pz = node.y * scale.y;
    parts.push(buildLocalDispGeo(px, py, pz, scale));
  }

  if (parts.length === 0) return new THREE.BufferGeometry();
  const merged = mergeGeos(parts);
  for (const g of parts) g.dispose();
  return merged;
}

/** One voxel: unit-box scaled to voxel extents, displaced from local position, translated. */
function buildLocalDispGeo(
  px: number, py: number, pz: number,
  scale: { x: number; y: number; z: number },
): THREE.BufferGeometry {
  const geo = new THREE.BoxGeometry(1, 1, 1);
  const pos = geo.getAttribute("position") as THREE.BufferAttribute;
  const mag = 0.10 * Math.min(scale.x, scale.y, scale.z);

  for (let i = 0; i < pos.count; i++) {
    // Scale unit-box (±0.5) to voxel extents — coord mapping identical to entity_mesh.ts
    const lx = pos.getX(i) * scale.x;
    const ly = pos.getY(i) * scale.z; // model z=up → three y
    const lz = pos.getZ(i) * scale.y;
    // Seed on LOCAL position — every instance of this sub-model gets the same shape
    const [dx, dy, dz] = vertexDisp(px + lx, py + ly, pz + lz, mag);
    pos.setXYZ(i, lx + dx, ly + dy, lz + dz);
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  geo.translate(px, py, pz); // move to voxel center in model space
  return geo;
}

function mergeGeos(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  let totalVerts = 0, totalIdx = 0;
  for (const g of geos) {
    totalVerts += g.getAttribute("position").count;
    if (g.index) totalIdx += g.index.count;
  }

  const positions = new Float32Array(totalVerts * 3);
  const normals   = new Float32Array(totalVerts * 3);
  const uvs       = new Float32Array(totalVerts * 2);
  const indices   = totalIdx > 0 ? new Uint32Array(totalIdx) : null;

  let vOff = 0, iOff = 0;
  for (const g of geos) {
    const pa = g.getAttribute("position") as THREE.BufferAttribute;
    const na = g.getAttribute("normal")   as THREE.BufferAttribute;
    const ua = g.getAttribute("uv")       as THREE.BufferAttribute | undefined;
    for (let i = 0; i < pa.count; i++) {
      positions[(vOff + i) * 3    ] = pa.getX(i);
      positions[(vOff + i) * 3 + 1] = pa.getY(i);
      positions[(vOff + i) * 3 + 2] = pa.getZ(i);
      normals  [(vOff + i) * 3    ] = na.getX(i);
      normals  [(vOff + i) * 3 + 1] = na.getY(i);
      normals  [(vOff + i) * 3 + 2] = na.getZ(i);
      uvs      [(vOff + i) * 2    ] = ua ? ua.getX(i) : 0;
      uvs      [(vOff + i) * 2 + 1] = ua ? ua.getY(i) : 0;
    }
    if (g.index && indices) {
      for (let i = 0; i < g.index.count; i++) {
        indices[iOff + i] = g.index.getX(i) + vOff;
      }
      iOff += g.index.count;
    }
    vOff += pa.count;
  }

  const out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  out.setAttribute("normal",   new THREE.BufferAttribute(normals,   3));
  out.setAttribute("uv",       new THREE.BufferAttribute(uvs,       2));
  if (indices) out.setIndex(new THREE.BufferAttribute(indices, 1));
  return out;
}

// ---- pool -------------------------------------------------------------------

interface PoolEntry {
  mesh: THREE.InstancedMesh;
  freeList: number[];
  nextSlot: number;
}

/**
 * Manages GPU-instanced InstancedMesh objects for static props.
 *
 * Usage:
 *   pool.addProp(entityId, worldPos, mainDef, resolvedSubs, subModelDefs, mats, scale)
 *   pool.removeProp(entityId)   // when entity leaves AoI or is destroyed
 */
export class PropInstancePool {
  private readonly scene: THREE.Scene;
  /** Geometry cache — one merged geo per (subModelId × matId × scale). */
  private readonly geoCache = new Map<string, THREE.BufferGeometry>();
  /** Pool entries — one InstancedMesh per (subModelId × matId × scale). */
  private readonly pools    = new Map<string, PoolEntry>();
  /** Entity → list of allocated slots (for removal). */
  private readonly propSlots = new Map<string, { key: string; slot: number }[]>();

  constructor(scene: THREE.Scene) {
    this.scene = scene;
  }

  /**
   * Register a static prop entity.
   *
   * @param worldPos  Entity world position in Three.js space (model→three already applied).
   * @param mainDef   Top-level ModelDefinition (may have own nodes with no sub-transform).
   * @param resolvedSubs  Resolved sub-object list (pool already collapsed to concrete modelIds).
   * @param subModelDefs  Map of modelId → ModelDefinition for every sub in resolvedSubs.
   * @param mats      Game material definitions (for color/shininess/emissive).
   * @param scale     Scale from ModelRef.
   */
  addProp(
    entityId: string,
    worldPos: THREE.Vector3,
    mainDef: ModelDefinition,
    resolvedSubs: ResolvedSubObject[],
    subModelDefs: Map<string, ModelDefinition>,
    mats: Map<number, MaterialDef>,
    scale: { x: number; y: number; z: number },
  ): void {
    if (this.propSlots.has(entityId)) return;

    const slots: { key: string; slot: number }[] = [];

    const registerModel = (def: ModelDefinition, subMatrix: THREE.Matrix4) => {
      const matIds = new Set(def.nodes.map((n) => n.materialId));
      for (const matId of matIds) {
        const key = makeKey(def.id, matId, scale.x, scale.y, scale.z);
        const entry = this.getOrCreatePool(key, def, matId, scale, mats);
        const slot  = this.allocSlot(entry);

        // World matrix = translate(worldPos) × subMatrix
        _pos.set(worldPos.x, worldPos.y, worldPos.z);
        _mat4.makeTranslation(_pos.x, _pos.y, _pos.z);
        _mat4.multiply(subMatrix);
        entry.mesh.setMatrixAt(slot, _mat4);
        entry.mesh.instanceMatrix.needsUpdate = true;

        slots.push({ key, slot });
      }
    };

    // Main model nodes — identity sub-transform (centered at entity origin)
    if (mainDef.nodes.length > 0) {
      registerModel(mainDef, new THREE.Matrix4());
    }

    // Sub-objects — each has a local offset + optional rotation
    for (const sub of resolvedSubs) {
      const subDef = subModelDefs.get(sub.modelId);
      if (!subDef) continue;

      const t = sub.transform;
      // Three.js coord mapping for sub-object position: model(x,y,z) → three(x*sx, z*sz, y*sy)
      _pos.set(t.x * scale.x, t.z * scale.z, t.y * scale.y);
      _euler.set(t.rotX, t.rotZ, t.rotY, "XYZ");
      _quat.setFromEuler(_euler);
      _scale.set(1, 1, 1);
      const subMatrix = new THREE.Matrix4().compose(_pos, _quat, _scale);

      registerModel(subDef, subMatrix);
    }

    this.propSlots.set(entityId, slots);
  }

  /** Remove a prop from all instance meshes (entity destroyed or left AoI). */
  removeProp(entityId: string): void {
    const slots = this.propSlots.get(entityId);
    if (!slots) return;

    const zeroMat = new THREE.Matrix4().makeScale(0, 0, 0);
    for (const { key, slot } of slots) {
      const entry = this.pools.get(key);
      if (!entry) continue;
      entry.mesh.setMatrixAt(slot, zeroMat);
      entry.mesh.instanceMatrix.needsUpdate = true;
      entry.freeList.push(slot);
    }
    this.propSlots.delete(entityId);
  }

  hasProp(entityId: string): boolean {
    return this.propSlots.has(entityId);
  }

  dispose(): void {
    for (const entry of this.pools.values()) {
      this.scene.remove(entry.mesh);
      entry.mesh.geometry.dispose();
      (entry.mesh.material as THREE.Material).dispose();
    }
    for (const geo of this.geoCache.values()) geo.dispose();
    this.pools.clear();
    this.geoCache.clear();
    this.propSlots.clear();
  }

  // ---- private ----------------------------------------------------------------

  private getOrCreatePool(
    key: string,
    def: ModelDefinition,
    matId: number,
    scale: { x: number; y: number; z: number },
    mats: Map<number, MaterialDef>,
  ): PoolEntry {
    const existing = this.pools.get(key);
    if (existing) return existing;

    // Build (or reuse) shared geometry
    let geo = this.geoCache.get(key);
    if (!geo) {
      geo = buildSubModelGeo(def.nodes, matId, scale);
      this.geoCache.set(key, geo);
    }

    // Build Three.js material
    const matDef   = mats.get(matId);
    const color     = matDef?.color ?? 0x888888;
    const shininess = matDef ? Math.round((1 - matDef.roughness) * 80) : 0;
    const emissive  = matDef && matDef.emissive > 0
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

    const mesh = new THREE.InstancedMesh(geo, mat, MAX_SLOTS);
    mesh.count = 0;
    mesh.castShadow    = true;
    mesh.receiveShadow = true;
    this.scene.add(mesh);

    const entry: PoolEntry = { mesh, freeList: [], nextSlot: 0 };
    this.pools.set(key, entry);
    return entry;
  }

  private allocSlot(entry: PoolEntry): number {
    if (entry.freeList.length > 0) return entry.freeList.pop()!;
    const slot = entry.nextSlot++;
    if (slot < MAX_SLOTS) entry.mesh.count = entry.nextSlot;
    return Math.min(slot, MAX_SLOTS - 1);
  }
}
