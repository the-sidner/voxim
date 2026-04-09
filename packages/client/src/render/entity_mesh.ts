/**
 * Per-entity visual representation.
 *
 * Three rendering modes:
 *   1. Placeholder    — colored capsule box, shown before model arrives.
 *   2. Static voxel   — ModelDefinition with no skeletonId; each VoxelNode is
 *                       a unit BoxGeometry in a flat list.
 *   3. Skeleton voxel — ModelDefinition with skeletonId; bones are Three.js
 *                       Groups in a hierarchy; sub-object part models hang off
 *                       their bone group, animated each frame via updateSkeletonPose.
 *
 * Coordinate mapping (model space → Three.js):
 *   model x (right)   → three x
 *   model y (forward) → three z
 *   model z (up)      → three y
 */
import * as THREE from "three";
import type { EntityState } from "../state/client_world.ts";
import type { ModelDefinition, MaterialDef, SkeletonDef, AnimationStateData, ResolvedSubObject } from "@voxim/content";
import { getVoxelTexture } from "./material_textures.ts";
import { vertexDisp } from "./displacement.ts";

// Shared placeholder geometries — never disposed individually
const GEO_BODY  = new THREE.BoxGeometry(0.8, 1.8, 0.8);
const GEO_DIR   = new THREE.BoxGeometry(0.2, 0.2, 0.5);
// Shared unit cube for blueprint scaffolds — scaled per instance, never disposed
const GEO_UNIT  = new THREE.BoxGeometry(1, 1, 1);
// Base voxel geometry — cloned and displaced per instance, never disposed directly
const GEO_VOXEL = new THREE.BoxGeometry(1, 1, 1);

/**
 * Clone GEO_VOXEL, scale its unit-box vertices to the actual voxel size
 * (scale.x × scale.z × scale.y in Three.js space), then displace each
 * vertex by vertexDisp() keyed on its Three.js world position.
 *
 * Scaling before displacement means adjacent voxels tile seamlessly
 * (spacing == voxel size) and displacement magnitude is 10 % of the
 * voxel face width as specified.
 */
function buildDisplacedVoxelGeo(
  px: number, py: number, pz: number,
  scale: { x: number; y: number; z: number },
): THREE.BufferGeometry {
  const geo = GEO_VOXEL.clone();
  const pos = geo.getAttribute("position") as THREE.BufferAttribute;
  const mag = 0.10 * Math.min(scale.x, scale.y, scale.z);
  for (let i = 0; i < pos.count; i++) {
    // Scale unit-box (±0.5) to actual voxel extents in Three.js space.
    // Coordinate mapping: model x → three x (scale.x),
    //                     model z=up → three y (scale.z),
    //                     model y=fwd → three z (scale.y).
    const lx = pos.getX(i) * scale.x;
    const ly = pos.getY(i) * scale.z;
    const lz = pos.getZ(i) * scale.y;
    const [dx, dy, dz] = vertexDisp(px + lx, py + ly, pz + lz, mag);
    pos.setXYZ(i, lx + dx, ly + dy, lz + dz);
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  return geo;
}

function pickPlaceholderColor(state: EntityState, isLocal: boolean): THREE.ColorRepresentation {
  if (isLocal) return 0x00ffff;
  const h = state.health;
  if (!h) return 0xffffff;
  const ratio = h.current / h.max;
  if (ratio < 0.3) return 0xff2222;
  if (ratio < 0.7) return 0xff8800;
  return 0x88cc44;
}

/** One timestamped position sample in Three.js world space. Used for interpolation. */
export interface PosRecord {
  t: number;   // performance.now() at receipt
  x: number; y: number; z: number;  // Three.js world-space (note: model z=up → three y)
  ry: number;  // group.rotation.y at this sample
}

/**
 * One item attachment slot.
 *
 * `anchor` is a THREE.Group whose parent is either the entity root group
 * (entity-root slots, positioned per-frame) or a bone group (bone-parented
 * slots, which inherit the bone's transform automatically through the scene
 * hierarchy — no per-frame positioning needed).
 *
 * slotId examples: "main_hand", "off_hand", "head", "chest", "legs_upper_l"
 */
export interface AttachmentSlot {
  anchor: THREE.Group;
  /** Model ID currently built into anchor's children, or null if empty / loading. */
  modelId: string | null;
  /**
   * When true the anchor is a child of a bone group, not the entity root.
   * The renderer skips per-frame positioning for these slots — Three.js
   * propagates the bone's world transform automatically.
   */
  boneParented: boolean;
}

export interface EntityMeshGroup {
  group: THREE.Group;
  /** Non-null when in placeholder mode. */
  placeholder: { body: THREE.Mesh; dir: THREE.Mesh } | null;
  /** Non-null when in static voxel mode (no skeleton). */
  voxelMeshes: THREE.Mesh[] | null;
  /** Non-null when in skeleton mode. boneId → bone Group. */
  boneGroups: Map<string, THREE.Group> | null;
  /**
   * Item attachment slots — slotId → AttachmentSlot.
   * Entity-root slots are positioned per-frame by the renderer.
   * Bone-parented slots inherit their bone's world transform automatically.
   * Model voxels are children of the anchor.
   */
  attachments: Map<string, AttachmentSlot>;
  /**
   * Sub-object transform info per boneId, recorded when the skeleton is built.
   * Used by syncEquipment to place armor anchors at the same position and scale
   * as the body-part sub-object on that bone, ensuring correct alignment.
   * Key: boneId. Value: sub-object transform (model-space offset + uniform scale).
   */
  boneSlotTransforms: Map<string, { x: number; y: number; z: number; scale: number }>;
  /** Cached animation state — used by the renderer for per-frame pose evaluation. */
  animationState: AnimationStateData | null;
  /** Wall-clock ms when animationState was last updated — used to extrapolate ticksIntoAction between server ticks. */
  lastAnimUpdateMs: number;
  /**
   * World-space velocity (model coords) — used to derive movement direction
   * relative to facing for directional walk animations.
   */
  velocityX: number;
  velocityY: number;
  /** Facing angle in radians (same convention as Facing component). */
  facingAngle: number;
  modelId: string | null;
  skeletonId: string | null;
  /**
   * Ring buffer of recent authoritative positions (max 16 entries, oldest first).
   * The render loop uses this to interpolate remote entities ~100 ms behind the
   * latest received state, smoothing out the 20 Hz tick rate.
   */
  posBuffer: PosRecord[];
}

// ---- create ----

export function createEntityMesh(state: EntityState, isLocal: boolean): EntityMeshGroup {
  const group = new THREE.Group();
  const placeholder = createPlaceholder(state, isLocal);
  group.add(placeholder.body, placeholder.dir);
  const mesh: EntityMeshGroup = {
    group,
    placeholder,
    voxelMeshes: null,
    boneGroups: null,
    attachments: new Map(),
    boneSlotTransforms: new Map(),
    animationState: state.animationState ?? null,
    lastAnimUpdateMs: performance.now(),
    velocityX: state.velocity?.x ?? 0,
    velocityY: state.velocity?.y ?? 0,
    facingAngle: state.facing?.angle ?? 0,
    modelId: null,
    skeletonId: null,
    posBuffer: [],
  };
  updateEntityMesh(mesh, state);
  return mesh;
}

function createPlaceholder(
  state: EntityState,
  isLocal: boolean,
): { body: THREE.Mesh; dir: THREE.Mesh } {
  if (state.blueprint) {
    // Render blueprint as a semi-transparent scaffold box sized by structure dimensions.
    // heightDelta=0 means a floor tile — show as a thin slab.
    const h = state.blueprint.heightDelta > 0 ? state.blueprint.heightDelta : 0.25;
    const geo = GEO_UNIT; // 1×1×1 unit cube, scaled to actual size below
    const body = new THREE.Mesh(geo, new THREE.MeshPhongMaterial({
      color: 0x4488ff,
      transparent: true,
      opacity: 0.45,
      flatShading: true,
      shininess: 0,
      depthWrite: false,
    }));
    body.scale.set(1.0, h, 1.0);
    body.position.y = h / 2;
    // Wireframe overlay for scaffold edge lines
    const edges = new THREE.EdgesGeometry(geo);
    const wf = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: 0x88bbff, transparent: true, opacity: 0.9 }));
    wf.scale.set(1.0, h, 1.0);
    wf.position.y = h / 2;
    body.add(wf);
    // dir mesh hidden — not meaningful for blueprints
    const dir = new THREE.Mesh(GEO_DIR, new THREE.MeshPhongMaterial({ color: 0x4488ff, transparent: true, opacity: 0 }));
    dir.visible = false;
    return { body, dir };
  }
  const color = pickPlaceholderColor(state, isLocal);
  const body = new THREE.Mesh(GEO_BODY, new THREE.MeshPhongMaterial({ color, flatShading: true, shininess: 0 }));
  body.position.y = 0.9;
  body.castShadow = true;
  body.receiveShadow = true;
  const dir = new THREE.Mesh(
    GEO_DIR,
    new THREE.MeshPhongMaterial({ color: isLocal ? 0xffffff : 0xffff00, flatShading: true, shininess: 0 }),
  );
  dir.position.set(0, 0.9, -0.55);
  dir.castShadow = true;
  return { body, dir };
}

// ---- internal helpers ----

function clearMeshContent(mesh: EntityMeshGroup): void {
  // 1. Detach and dispose all attachment anchors first — before bone groups, to
  //    avoid the bone-hierarchy traverse visiting already-detached anchors.
  //    Bone-parented anchors use removeFromParent() since their parent is a bone
  //    group, not the entity root.
  for (const [, slot] of mesh.attachments) {
    slot.anchor.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        (obj.material as THREE.Material).dispose();
        obj.geometry.dispose();
      }
    });
    slot.anchor.removeFromParent();
  }
  mesh.attachments.clear();
  mesh.boneSlotTransforms.clear();

  // 2. Bone hierarchy — traverse disposes body-part voxels inside bone groups.
  if (mesh.boneGroups) {
    for (const [, bg] of mesh.boneGroups) {
      if (bg.parent === mesh.group) mesh.group.remove(bg);
    }
    mesh.group.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        (obj.material as THREE.Material).dispose();
        obj.geometry.dispose();
      }
    });
    mesh.boneGroups = null;
    mesh.skeletonId = null;
    // voxelMeshes are children of bones — already disposed above.
    mesh.voxelMeshes = null;
  }

  // 3. Static voxel mode (no skeleton).
  if (mesh.voxelMeshes) {
    for (const m of mesh.voxelMeshes) {
      m.parent?.remove(m);
      (m.material as THREE.Material).dispose();
      m.geometry.dispose();
    }
    mesh.voxelMeshes = null;
  }

  // 4. Placeholder.
  if (mesh.placeholder) {
    mesh.group.remove(mesh.placeholder.body, mesh.placeholder.dir);
    (mesh.placeholder.body.material as THREE.Material).dispose();
    (mesh.placeholder.dir.material as THREE.Material).dispose();
    mesh.placeholder = null;
  }
}

function buildVoxelMesh(
  node: { x: number; y: number; z: number; materialId: number },
  materials: Map<number, MaterialDef>,
  scale: { x: number; y: number; z: number },
  onTop = false,
): THREE.Mesh {
  const matDef = materials.get(node.materialId);
  const color = matDef ? matDef.color : 0x888888;
  // roughness (0–1) → shininess: rough surfaces have no specular highlight
  const shininess = matDef ? Math.round((1 - matDef.roughness) * 80) : 0;
  // emissive: glow in the material's own color, scaled by emissive factor
  const emissive = matDef && matDef.emissive > 0
    ? new THREE.Color(color).multiplyScalar(matDef.emissive * 0.7)
    : new THREE.Color(0x000000);
  // model(x, y, z) → three(x * sx, z * sz, y * sy)
  const px = node.x * scale.x, py = node.z * scale.z, pz = node.y * scale.y;
  const geo = buildDisplacedVoxelGeo(px, py, pz, scale);
  const tex = getVoxelTexture(node.materialId, color);
  const vox = new THREE.Mesh(geo, new THREE.MeshPhongMaterial({
    color: tex ? 0xffffff : color,
    map: tex ?? undefined,
    flatShading: true,
    shininess,
    emissive,
    // Armor voxels that overlay body-part voxels at the same position use
    // polygonOffset so they render cleanly on top without z-fighting.
    polygonOffset: onTop,
    polygonOffsetFactor: onTop ? -1 : 0,
    polygonOffsetUnits:  onTop ? -4 : 0,
  }));
  vox.position.set(px, py, pz);
  vox.castShadow = true;
  vox.receiveShadow = true;
  // Outline uses the displaced geo so it matches the actual voxel shape exactly.
  // Each instance gets its own outline geo (no shared cache hit); WeakMap holds
  // a weak ref so it is GC-eligible once geo is disposed.
  return vox;
}

// ---- upgrade to static voxel model ----

/**
 * Replace the placeholder/previous model with flat voxel geometry from a
 * ModelDefinition that has no skeleton.
 * resolvedSubs: output of resolveSubObjects() — sub-objects positioned by their
 * static transforms (no bone animation).
 */
export function upgradeToVoxelModel(
  mesh: EntityMeshGroup,
  def: ModelDefinition,
  resolvedSubs: ResolvedSubObject[],
  subModelDefs: Map<string, ModelDefinition>,
  materials: Map<number, MaterialDef>,
  scale: { x: number; y: number; z: number },
): void {
  clearMeshContent(mesh);

  const voxelMeshes: THREE.Mesh[] = [];
  for (const node of def.nodes) {
    const vox = buildVoxelMesh(node, materials, scale);
    mesh.group.add(vox);
    voxelMeshes.push(vox);
  }

  // Sub-objects: positioned by static transform, no skeleton
  for (const sub of resolvedSubs) {
    const subDef = subModelDefs.get(sub.modelId);
    if (!subDef) continue;
    const subGroup = new THREE.Group();
    subGroup.name = `sub:${sub.modelId}`;
    subGroup.position.set(
      sub.transform.x * scale.x,
      sub.transform.z * scale.z,
      sub.transform.y * scale.y,
    );
    subGroup.rotation.set(sub.transform.rotX, sub.transform.rotZ, sub.transform.rotY);
    mesh.group.add(subGroup);
    const subScale = {
      x: scale.x * sub.transform.scaleX,
      y: scale.y * sub.transform.scaleY,
      z: scale.z * sub.transform.scaleZ,
    };
    for (const node of subDef.nodes) {
      const vox = buildVoxelMesh(node, materials, subScale);
      subGroup.add(vox);
      voxelMeshes.push(vox);
    }
  }

  mesh.voxelMeshes = voxelMeshes;
  mesh.modelId = def.id;
}

// ---- upgrade to skeleton model ----

/**
 * Build a bone Group hierarchy and attach sub-object part models.
 * Each bone becomes a Three.js Group positioned at its rest offset from its parent.
 * Sub-objects with a boneId are children of that bone's Group.
 *
 * Bones in `skeleton.bones` must be ordered parent-first (root appears before
 * any of its children) — this is enforced by the content authoring convention.
 */
export function upgradeToSkeletonModel(
  mesh: EntityMeshGroup,
  def: ModelDefinition,
  skeleton: SkeletonDef,
  resolvedSubs: ResolvedSubObject[],
  subModelDefs: Map<string, ModelDefinition>,
  materials: Map<number, MaterialDef>,
  scale: { x: number; y: number; z: number },
): void {
  clearMeshContent(mesh);

  // Build bone Groups parent-first
  const boneGroups = new Map<string, THREE.Group>();
  for (const bone of skeleton.bones) {
    const bg = new THREE.Group();
    bg.name = `bone:${bone.id}`;
    bg.position.set(
      bone.restX * scale.x,
      bone.restZ * scale.z,  // model z = up → Three.js y
      bone.restY * scale.y,
    );
    const parentGroup = bone.parent !== null
      ? (boneGroups.get(bone.parent) ?? mesh.group)
      : mesh.group;
    parentGroup.add(bg);
    boneGroups.set(bone.id, bg);
  }

  // Attach resolved sub-object voxels to their bone groups (or entity root)
  const voxelMeshes: THREE.Mesh[] = [];
  for (const sub of resolvedSubs) {
    const subDef = subModelDefs.get(sub.modelId);
    if (!subDef) continue;

    const parent = sub.boneId
      ? (boneGroups.get(sub.boneId) ?? mesh.group)
      : mesh.group;

    const subGroup = new THREE.Group();
    subGroup.name = `sub:${sub.modelId}`;
    subGroup.position.set(
      sub.transform.x * scale.x,
      sub.transform.z * scale.z,
      sub.transform.y * scale.y,
    );
    parent.add(subGroup);

    const subScale = {
      x: scale.x * sub.transform.scaleX,
      y: scale.y * sub.transform.scaleY,
      z: scale.z * sub.transform.scaleZ,
    };
    for (const node of subDef.nodes) {
      const vox = buildVoxelMesh(node, materials, subScale);
      subGroup.add(vox);
      voxelMeshes.push(vox);
    }
  }

  mesh.boneGroups = boneGroups;
  mesh.voxelMeshes = voxelMeshes;
  mesh.modelId = def.id;
  mesh.skeletonId = skeleton.id;
}

// ---- per-frame pose update ----

/**
 * Apply bone rotations from the pose evaluator to each bone's Group.
 * Called every render frame for entities in skeleton mode.
 */
export function updateSkeletonPose(
  mesh: EntityMeshGroup,
  pose: Map<string, THREE.Euler>,
): void {
  if (!mesh.boneGroups) return;
  for (const [boneId, rotation] of pose) {
    const bg = mesh.boneGroups.get(boneId);
    if (bg) bg.rotation.copy(rotation);
  }
}

// ---- update transform ----

/** Sync mesh world position and facing from entity state. */
export function updateEntityMesh(mesh: EntityMeshGroup, state: EntityState): void {
  const pos = state.position;
  if (pos) {
    // world(x, y, z) → three(x, height, y)
    mesh.group.position.set(pos.x, pos.z, pos.y);
  }

  const facing = state.facing;
  if (facing !== undefined) {
    mesh.group.rotation.y = -facing.angle - Math.PI / 2;
  }

  // Record position snapshot for interpolation (only when position actually changed)
  if (pos) {
    mesh.posBuffer.push({
      t: performance.now(),
      x: pos.x, y: pos.z, z: pos.y,
      ry: mesh.group.rotation.y,
    });
    if (mesh.posBuffer.length > 16) mesh.posBuffer.shift();
  }

  if (state.animationState !== undefined) {
    mesh.animationState = state.animationState;
    mesh.lastAnimUpdateMs = performance.now();
  }
  if (state.velocity !== undefined) {
    mesh.velocityX = state.velocity.x;
    mesh.velocityY = state.velocity.y;
  }
  if (state.facing !== undefined) {
    mesh.facingAngle = state.facing.angle;
  }

  // Update placeholder color from health (only in non-blueprint placeholder mode)
  if (mesh.placeholder && !state.blueprint) {
    const color = pickPlaceholderColor(state, false);
    (mesh.placeholder.body.material as THREE.MeshLambertMaterial).color.set(color);
  }
}

// ---- item attachment slots ----

/**
 * Return the anchor Group for an entity-root slot, creating it if needed.
 * Entity-root anchors are direct children of mesh.group and are repositioned
 * every frame by the renderer (swing path or bone world-position follow).
 */
export function ensureAttachment(mesh: EntityMeshGroup, slotId: string): AttachmentSlot {
  let slot = mesh.attachments.get(slotId);
  if (!slot) {
    const anchor = new THREE.Group();
    anchor.name = `attachment:${slotId}`;
    mesh.group.add(anchor);
    slot = { anchor, modelId: null, boneParented: false };
    mesh.attachments.set(slotId, slot);
  }
  return slot;
}

/**
 * Return the anchor Group for a bone-parented slot, creating it if needed.
 * Bone-parented anchors are children of the given bone group — Three.js
 * propagates the bone's world transform automatically so no per-frame
 * positioning is required.  The anchor is positioned/scaled to match the
 * body-part sub-object on that bone (offset and sub-scale applied here).
 *
 * @param boneGroup  The bone THREE.Group to parent the anchor to.
 * @param posX/Y/Z   Model-space offset of the sub-object on this bone
 *                   (converted to Three.js space via the entity scale).
 * @param entityScale  Entity scale (from ModelRef).
 * @param subScale   Uniform sub-object scale multiplier (e.g. 0.5 for arms/legs).
 */
export function ensureBoneAttachment(
  mesh: EntityMeshGroup,
  slotId: string,
  boneGroup: THREE.Group,
  posX: number, posY: number, posZ: number,
  entityScale: { x: number; y: number; z: number },
  subScale: number,
): AttachmentSlot {
  let slot = mesh.attachments.get(slotId);
  if (!slot) {
    const anchor = new THREE.Group();
    anchor.name = `attachment:${slotId}`;
    // Apply sub-object offset in Three.js coordinate space (model z=up → Three y).
    anchor.position.set(
      posX * entityScale.x,
      posZ * entityScale.z,
      posY * entityScale.y,
    );
    // Store subScale on the anchor's userData so syncEquipment can read it
    // when building the armor model voxels at the correct scale.
    anchor.userData.armorSubScale = subScale;
    boneGroup.add(anchor);
    slot = { anchor, modelId: null, boneParented: true };
    mesh.attachments.set(slotId, slot);
  }
  return slot;
}

/**
 * Build model voxels for a slot and add them as children of its anchor.
 * Replaces any previously loaded model for this slot cleanly.
 * Creates the slot anchor if it does not yet exist (entity-root only;
 * for bone-parented slots, call ensureBoneAttachment first).
 *
 * @param onTop  When true, enables polygonOffset so voxels render on top of
 *               any co-located body-part voxels without z-fighting.
 */
export function attachModelToSlot(
  mesh: EntityMeshGroup,
  slotId: string,
  modelDef: ModelDefinition,
  materials: Map<number, MaterialDef>,
  scale: { x: number; y: number; z: number },
  onTop = false,
): void {
  const slot = ensureAttachment(mesh, slotId);
  detachModelFromSlot(mesh, slotId);   // clear previous model first

  const modelGroup = new THREE.Group();
  modelGroup.name = `model:${modelDef.id}`;
  for (const node of modelDef.nodes) {
    modelGroup.add(buildVoxelMesh(node, materials, scale, onTop));
  }
  slot.anchor.add(modelGroup);
  slot.modelId = modelDef.id;
}

/**
 * Like attachModelToSlot but for bone-parented slots whose anchor was created
 * by ensureBoneAttachment.  Reads armorSubScale from anchor.userData to build
 * voxels at the correct sub-object scale.  Always enables onTop polygonOffset.
 */
export function attachArmorToSlot(
  mesh: EntityMeshGroup,
  slotId: string,
  modelDef: ModelDefinition,
  materials: Map<number, MaterialDef>,
  entityScale: { x: number; y: number; z: number },
): void {
  const slot = mesh.attachments.get(slotId);
  if (!slot) return; // ensureBoneAttachment must be called first
  detachModelFromSlot(mesh, slotId);

  const subScale: number = slot.anchor.userData.armorSubScale ?? 1;
  const armorScale = {
    x: entityScale.x * subScale,
    y: entityScale.y * subScale,
    z: entityScale.z * subScale,
  };

  const modelGroup = new THREE.Group();
  modelGroup.name = `model:${modelDef.id}`;
  for (const node of modelDef.nodes) {
    modelGroup.add(buildVoxelMesh(node, materials, armorScale, true));
  }
  slot.anchor.add(modelGroup);
  slot.modelId = modelDef.id;
}

/**
 * Remove and dispose the model voxels from a slot's anchor.
 * The anchor itself is kept — it will be repositioned next frame as usual.
 * Sets slot.modelId to null so the renderer knows the slot is empty.
 */
export function detachModelFromSlot(mesh: EntityMeshGroup, slotId: string): void {
  const slot = mesh.attachments.get(slotId);
  if (!slot || slot.modelId === null) return;
  for (const child of [...slot.anchor.children]) {
    slot.anchor.remove(child);
    child.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        (obj.material as THREE.Material).dispose();
        obj.geometry.dispose();
      }
    });
  }
  slot.modelId = null;
}

// ---- dispose ----

export function disposeEntityMesh(mesh: EntityMeshGroup): void {
  clearMeshContent(mesh);
  // GEO_BODY, GEO_DIR, GEO_VOXEL are shared — do NOT dispose them here
}
