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
import { type BakedVoxel, bakeDisplacedVoxel, unitBoxIndex, unitBoxUV } from "./voxel_bake.ts";
import type { VoxelBakeSpec } from "./bake_protocol.ts";
import { makeNameSprite, setNameSpriteText, disposeNameSprite } from "./name_label.ts";

// Shared placeholder geometries — never disposed individually
const GEO_BODY  = new THREE.BoxGeometry(0.8, 1.8, 0.8);
const GEO_DIR   = new THREE.BoxGeometry(0.2, 0.2, 0.5);
// Shared unit cube for blueprint scaffolds — scaled per instance, never disposed
const GEO_UNIT  = new THREE.BoxGeometry(1, 1, 1);

/**
 * Build the displaced unit-box geometry for one voxel.  The displacement +
 * normal math runs in the three-free `voxel_bake.bakeDisplacedVoxel` (T-067 —
 * the same code the bake worker runs); this wraps the resulting position/normal
 * arrays in a THREE.BufferGeometry.  Index + uv are constant across voxels but
 * copied per geometry — each per-voxel mesh owns its attributes and disposes
 * them individually (clearMeshContent / detachModelFromSlot), so a shared
 * BufferAttribute would have its GPU buffer freed out from under siblings.
 *
 * Scaling before displacement means adjacent voxels tile seamlessly
 * (spacing == voxel size) and displacement magnitude is 10 % of the
 * voxel face width as specified.
 */
function buildDisplacedVoxelGeo(
  px: number, py: number, pz: number,
  scale: { x: number; y: number; z: number },
): THREE.BufferGeometry {
  return geometryFromBakedVoxel(bakeDisplacedVoxel(px, py, pz, scale));
}

/**
 * Wrap a single voxel's baked position/normal arrays (synchronous or from the
 * bake worker) into a THREE.BufferGeometry.  Index + uv are constant across
 * voxels but copied per geometry — each per-voxel mesh owns its attributes and
 * disposes them individually (clearMeshContent / detachModelFromSlot), so a
 * shared BufferAttribute would have its GPU buffer freed out from under siblings.
 */
function geometryFromBakedVoxel(baked: BakedVoxel): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(baked.positions, 3));
  geo.setAttribute("normal",   new THREE.BufferAttribute(baked.normals,   3));
  geo.setAttribute("uv",       new THREE.BufferAttribute(unitBoxUV().slice(), 2));
  geo.setIndex(new THREE.BufferAttribute(unitBoxIndex().slice(), 1));
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
  /**
   * Hand-bone-local attachment data when this slot holds a blade-bearing
   * item (a weapon with a swingable component). Null for shields,
   * lanterns, or any other held thing without a blade. When present, the
   * per-frame anchor positioning runs the base/tip points through the
   * named bone's matrixWorld — same math the swing path uses — so the
   * weapon sits in the fist consistently across rest, swing, and
   * maneuver. Set per-slot so each hand can hold a different blade.
   */
  bladeAttach: { base: [number, number, number]; tip: [number, number, number]; holdBone: string } | null;
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
  /**
   * World-unit visual lift applied on top of the physics position when placing
   * the entity group.  Derived from skeleton.groundOffset * modelScale.z at
   * model build time.  Keeps the lowest voxels flush with the terrain surface
   * without touching server physics (which always snaps position.z to groundZ).
   * Zero for non-skeleton entities.
   */
  groundOffsetWorld: number;
  /**
   * Blade dimensions derived from the main-hand weapon model AABB.
   * Set by the renderer when the weapon attachment slot is populated.
   * Null when unarmed. Used by the trail system and weapon anchor positioning.
   */
  bladeDimensions: { length: number; halfCross: number } | null;
  /**
   * Top-of-head Y in entity-local (mesh.group) coords — used to anchor
   * the floating name label above the head regardless of character
   * size or morph proportions. Set when the skeleton model is built;
   * 0 for non-skeletal entities (the label falls back to LABEL_HEIGHT).
   */
  headHeightWorld: number;
  /**
   * Procedural seed from ModelRef — set when the skeleton model is built.
   * Used by the hitbox debug overlay to derive bone-local capsule templates
   * with the same PRNG sequence as the server.
   */
  modelSeed: number;
  /**
   * Uniform entity scale from ModelRef.scaleX — set when the skeleton model is built.
   * Used by the hitbox debug overlay to convert voxel units to world units.
   */
  modelScale: number;
  /**
   * Per-instance morph param overrides from ModelRef.morphValues (T-180).
   * Drives `resolveMorphParams` so the same morphs apply on client + server.
   * Undefined when the prefab declares no overrides — random fill applies.
   */
  modelMorphs?: Record<string, number>;
  /**
   * Floating name label sprite parented to the group. Null when the entity
   * has no Name component / an empty name. Maintained by syncNameLabel each
   * tick the entity state advances.
   */
  nameLabel: THREE.Sprite | null;
  /** Cached label text — lets syncNameLabel skip canvas regen when unchanged. */
  nameLabelText: string;
  /**
   * Synthetic Y offset added to group.position.y this frame.  Animation tracks
   * carry rotations only (no translation), so the dodge roll's full forward
   * somersault would dip the head below ground; the renderer injects a parabolic
   * lift while the "roll" clip is active to keep the body visible.
   */
  rollLiftY: number;
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
    groundOffsetWorld: 0,
    bladeDimensions: null,
    headHeightWorld: 0,
    modelSeed: 0,
    modelScale: 0,
    nameLabel: null,
    nameLabelText: "",
    rollLiftY: 0,
  };
  updateEntityMesh(mesh, state);
  syncNameLabel(mesh, state);
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
    slot.anchor.traverse((obj: THREE.Object3D) => {
      if (!(obj instanceof THREE.Mesh) || obj.userData.isOutline) return;
      (obj.material as THREE.Material).dispose();
      obj.geometry.dispose();
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
    mesh.group.traverse((obj: THREE.Object3D) => {
      if (!(obj instanceof THREE.Mesh) || obj.userData.isOutline) return;
      (obj.material as THREE.Material).dispose();
      obj.geometry.dispose();
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

/**
 * A consumable source of pre-baked per-voxel geometry, supplied by the bake
 * pool (T-067).  `buildVoxelMesh` pulls one entry per node in the SAME order
 * the matching `collect*BakeSpecs` produced them, so the worker's results line
 * up with the traversal.  Undefined → bake synchronously (the fallback).
 */
export type BakedVoxelCursor = () => BakedVoxel | undefined;

function buildVoxelMesh(
  node: { x: number; y: number; z: number; materialId: number },
  materials: Map<number, MaterialDef>,
  scale: { x: number; y: number; z: number },
  onTop = false,
  baked?: BakedVoxelCursor,
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
  // Use the off-thread bake when the cursor yields one for this voxel;
  // otherwise fall back to baking inline (synchronous path / cursor exhausted).
  const pre = baked?.();
  const geo = pre ? geometryFromBakedVoxel(pre) : buildDisplacedVoxelGeo(px, py, pz, scale);
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
  return vox;
}

/** The bake spec (Three.js-space center + scale) for one model node. */
function nodeBakeSpec(
  node: { x: number; y: number; z: number },
  scale: { x: number; y: number; z: number },
): VoxelBakeSpec {
  // model(x, y, z) → three(x*sx, z*sz, y*sy) — identical to buildVoxelMesh.
  return { px: node.x * scale.x, py: node.z * scale.z, pz: node.y * scale.y, scale };
}

/** Turn a baked-voxel array into a cursor that yields one entry per call. */
export function bakedCursor(baked: BakedVoxel[] | undefined): BakedVoxelCursor {
  let i = 0;
  return () => baked?.[i++];
}

// ---- upgrade to static voxel model ----

/**
 * Bake specs for `upgradeToVoxelModel`, in the EXACT order that function builds
 * voxel meshes (main nodes, then each resolved sub-object's nodes).  The
 * renderer feeds these to the bake pool and passes the results back as a cursor.
 */
export function collectVoxelModelBakeSpecs(
  def: ModelDefinition,
  resolvedSubs: ResolvedSubObject[],
  subModelDefs: Map<string, ModelDefinition>,
  scale: { x: number; y: number; z: number },
): VoxelBakeSpec[] {
  const specs: VoxelBakeSpec[] = [];
  for (const node of def.nodes) specs.push(nodeBakeSpec(node, scale));
  for (const sub of resolvedSubs) {
    const subDef = subModelDefs.get(sub.modelId);
    if (!subDef) continue;
    const subScale = {
      x: scale.x * sub.transform.scaleX,
      y: scale.y * sub.transform.scaleY,
      z: scale.z * sub.transform.scaleZ,
    };
    for (const node of subDef.nodes) specs.push(nodeBakeSpec(node, subScale));
  }
  return specs;
}

/**
 * Replace the placeholder/previous model with flat voxel geometry from a
 * ModelDefinition that has no skeleton.
 * resolvedSubs: output of resolveSubObjects() — sub-objects positioned by their
 * static transforms (no bone animation).
 * baked: optional pre-baked voxels from the pool (collectVoxelModelBakeSpecs
 * order); when absent each voxel bakes synchronously.
 */
export function upgradeToVoxelModel(
  mesh: EntityMeshGroup,
  def: ModelDefinition,
  resolvedSubs: ResolvedSubObject[],
  subModelDefs: Map<string, ModelDefinition>,
  materials: Map<number, MaterialDef>,
  scale: { x: number; y: number; z: number },
  baked?: BakedVoxel[],
): void {
  clearMeshContent(mesh);
  const cursor = bakedCursor(baked);

  const voxelMeshes: THREE.Mesh[] = [];
  for (const node of def.nodes) {
    const vox = buildVoxelMesh(node, materials, scale, false, cursor);
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
      const vox = buildVoxelMesh(node, materials, subScale, false, cursor);
      subGroup.add(vox);
      voxelMeshes.push(vox);
    }
  }

  mesh.voxelMeshes = voxelMeshes;
  mesh.modelId = def.id;
}

// ---- upgrade to skeleton model ----

/** Per-bone rest-axis morph multipliers (x/y/z), derived from morph params. */
interface BoneMorphScales {
  x: Map<string, number>;
  y: Map<string, number>;
  z: Map<string, number>;
}

/**
 * Pre-build per-bone rest-axis multipliers from morph param declarations.
 * Shared by the skeleton upgrade and its bake-spec collector so the per-sub
 * subScale matches exactly between the two passes.
 */
function computeBoneMorphScales(
  skeleton: SkeletonDef,
  morphParams?: Record<string, number>,
): BoneMorphScales {
  const x = new Map<string, number>();
  const y = new Map<string, number>();
  const z = new Map<string, number>();
  if (morphParams && skeleton.morphParams) {
    for (const param of skeleton.morphParams) {
      const factor = morphParams[param.id] ?? 1.0;
      if (factor === 1.0) continue;
      for (const boneId of param.bones) {
        if (param.restAxis === "x") {
          x.set(boneId, (x.get(boneId) ?? 1.0) * factor);
        } else if (param.restAxis === "y") {
          y.set(boneId, (y.get(boneId) ?? 1.0) * factor);
        } else {
          z.set(boneId, (z.get(boneId) ?? 1.0) * factor);
        }
      }
    }
  }
  return { x, y, z };
}

/** The per-sub-object voxel scale for the skeleton path (with bone morph). */
function skeletonSubScale(
  sub: ResolvedSubObject,
  scale: { x: number; y: number; z: number },
  morph: BoneMorphScales,
): { x: number; y: number; z: number } {
  const subBoneId = sub.boneId ?? "";
  return {
    x: scale.x * sub.transform.scaleX * (morph.x.get(subBoneId) ?? 1.0),
    y: scale.y * sub.transform.scaleY * (morph.y.get(subBoneId) ?? 1.0),
    z: scale.z * sub.transform.scaleZ * (morph.z.get(subBoneId) ?? 1.0),
  };
}

/**
 * Bake specs for `upgradeToSkeletonModel`, in the EXACT order it builds voxel
 * meshes (each resolved sub-object's nodes, sub-scale incl. bone morph).
 */
export function collectSkeletonModelBakeSpecs(
  skeleton: SkeletonDef,
  resolvedSubs: ResolvedSubObject[],
  subModelDefs: Map<string, ModelDefinition>,
  scale: { x: number; y: number; z: number },
  morphParams?: Record<string, number>,
): VoxelBakeSpec[] {
  const morph = computeBoneMorphScales(skeleton, morphParams);
  const specs: VoxelBakeSpec[] = [];
  for (const sub of resolvedSubs) {
    const subDef = subModelDefs.get(sub.modelId);
    if (!subDef) continue;
    const subScale = skeletonSubScale(sub, scale, morph);
    for (const node of subDef.nodes) specs.push(nodeBakeSpec(node, subScale));
  }
  return specs;
}

/**
 * Build a bone Group hierarchy and attach sub-object part models.
 * Each bone becomes a Three.js Group positioned at its rest offset from its parent.
 * Sub-objects with a boneId are children of that bone's Group.
 *
 * Bones in `skeleton.bones` must be ordered parent-first (root appears before
 * any of its children) — this is enforced by the content authoring convention.
 *
 * baked: optional pre-baked voxels from the pool (collectSkeletonModelBakeSpecs
 * order); when absent each voxel bakes synchronously.
 */
export function upgradeToSkeletonModel(
  mesh: EntityMeshGroup,
  def: ModelDefinition,
  skeleton: SkeletonDef,
  resolvedSubs: ResolvedSubObject[],
  subModelDefs: Map<string, ModelDefinition>,
  materials: Map<number, MaterialDef>,
  scale: { x: number; y: number; z: number },
  morphParams?: Record<string, number>,
  baked?: BakedVoxel[],
): void {
  clearMeshContent(mesh);
  const cursor = bakedCursor(baked);

  // Pre-build per-bone rest-axis multipliers from morph param declarations.
  const morph = computeBoneMorphScales(skeleton, morphParams);
  const boneScaleX = morph.x;
  const boneScaleY = morph.y;
  const boneScaleZ = morph.z;

  // Build bone Groups parent-first
  const boneGroups = new Map<string, THREE.Group>();
  for (const bone of skeleton.bones) {
    const bg = new THREE.Group();
    bg.name = `bone:${bone.id}`;
    const rx = bone.restX * (boneScaleX.get(bone.id) ?? 1.0);
    const ry = bone.restY * (boneScaleY.get(bone.id) ?? 1.0);
    const rz = bone.restZ * (boneScaleZ.get(bone.id) ?? 1.0);
    bg.position.set(
      rx * scale.x,
      rz * scale.z,  // model z = up → Three.js y
      ry * scale.y,
    );
    // Bind rotation from the skeleton def — same convention as clip
    // rotations (Euler XYZ in solver/three.js axes: x=right, y=up, z=back).
    // Without this, every bone sits at identity rotation and the whole
    // rig collapses into a stacked-blocks pose; clips that don't animate
    // a particular bone leave it at this rest until they do.
    bg.rotation.set(
      bone.restRotX ?? 0,
      bone.restRotY ?? 0,
      bone.restRotZ ?? 0,
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
    // Apply per-sub-object rotation with the same entity→three.js axis swap
    // used for position. Previously this path (bone-attached sub-objects)
    // skipped rotation entirely, so any sub-object meant to be reoriented
    // relative to its bone silently rendered at identity.
    subGroup.rotation.set(
      sub.transform.rotX,
      sub.transform.rotZ,
      sub.transform.rotY,
    );
    parent.add(subGroup);

    // T-186 Layer 1: scale the sub-object's voxels along the same axes as
    // the parent bone's morph scale. Without this, stretching a bone (say
    // armLength 1.2× on lower_arm_r) just moves the wrist joint further
    // out and leaves the visible forearm chunk floating at the original
    // length. subScale multiplies by the bone's morph factor per axis so the
    // body chunk stretches in lockstep with the segment between joints.
    // Sub-objects parented to mesh.group (sub.boneId is null) get factor
    // 1.0 — they aren't part of the morphed skeleton.
    const subScale = skeletonSubScale(sub, scale, morph);
    for (const node of subDef.nodes) {
      const vox = buildVoxelMesh(node, materials, subScale, false, cursor);
      subGroup.add(vox);
      voxelMeshes.push(vox);
    }
  }

  mesh.boneGroups = boneGroups;
  mesh.voxelMeshes = voxelMeshes;
  mesh.modelId = def.id;
  mesh.skeletonId = skeleton.id;

  // Derive how far to lift the entity group so the lowest voxel face rests on the
  // terrain surface rather than clipping through it.
  //
  // Physics always places position.z at terrain surface height (groundZ), and the
  // entity group origin = that height.  Voxels on bones below the entity origin
  // (entity-local z < 0) would clip through the terrain without this offset.
  //
  // This is computed from the current morphed rest pose so it remains correct even
  // when morph params lengthen or shorten limbs — a static data field would break.
  //
  // Algorithm: accumulate Three.js y for each bone from the (morphed) rest offsets,
  // then find the lowest voxel BOTTOM FACE across all sub-objects.
  // groundOffsetWorld = max(0, -lowestFaceY).
  {
    // Bone accumulated Three.js y (= entity-local z after coord convert) in rest pose.
    // Rest pose uses identity rotation, so positions are purely additive from parent.
    const boneWorldY = new Map<string, number>();
    for (const bone of skeleton.bones) {
      const parentY = bone.parent !== null ? (boneWorldY.get(bone.parent) ?? 0) : 0;
      const rz = bone.restZ * (boneScaleZ.get(bone.id) ?? 1.0);
      boneWorldY.set(bone.id, parentY + rz * scale.z);
    }

    let minVoxelY = 0;
    for (const sub of resolvedSubs) {
      if (!sub.boneId) continue;
      const boneY = boneWorldY.get(sub.boneId) ?? 0;
      const subOffsetY = sub.transform.z * scale.z;
      // Match the sub-object voxel stretch used in the build pass above so
      // the ground-clearance calculation accounts for morph-stretched body
      // chunks — without this, a leg-lengthened character's foot voxel
      // sits lower than groundOffsetWorld accounts for, and feet clip terrain.
      const subScaleZ = scale.z * sub.transform.scaleZ * (boneScaleZ.get(sub.boneId) ?? 1.0);
      const subDef = subModelDefs.get(sub.modelId);
      if (!subDef) continue;
      for (const node of subDef.nodes) {
        // Bottom face = node center - half voxel height
        const voxelBottomY = boneY + subOffsetY + (node.z - 0.5) * subScaleZ;
        if (voxelBottomY < minVoxelY) minVoxelY = voxelBottomY;
      }
    }
    mesh.groundOffsetWorld = Math.max(0, -minVoxelY);

    // Head-top in entity-local coords, used to anchor the floating name
    // label above any character regardless of overall size or per-instance
    // morph (taller characters → higher label). Walks the bone chain to
    // find the topmost bone (typically "head") then adds an estimated
    // head-voxel half-height. boneWorldY values are already morphed.
    let maxBoneY = 0;
    for (const y of boneWorldY.values()) if (y > maxBoneY) maxBoneY = y;
    // 0.5 world units of clearance for the head voxels themselves + a
    // small gap before the label sprite sits.
    mesh.headHeightWorld = maxBoneY + 0.5 * scale.z + mesh.groundOffsetWorld;
  }
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

/**
 * Reconcile the entity's floating name label with the latest networked
 * `Name` component. Creates the sprite on first sight, replaces its texture
 * when the text changes, and tears it down when the name is cleared.
 *
 * Called from `updateEntityMesh` so the label tracks the same lifecycle
 * as the rest of the mesh (parent group, position, disposal).
 */
export function syncNameLabel(mesh: EntityMeshGroup, state: EntityState): void {
  const next = state.name?.value ?? "";
  if (next === mesh.nameLabelText) return;
  mesh.nameLabelText = next;

  if (next === "") {
    if (mesh.nameLabel) {
      disposeNameSprite(mesh.nameLabel);
      mesh.nameLabel = null;
    }
    return;
  }

  if (mesh.nameLabel) {
    setNameSpriteText(mesh.nameLabel, next);
  } else {
    mesh.nameLabel = makeNameSprite(next);
    mesh.group.add(mesh.nameLabel);
  }
  // Anchor the label above the head. For skeletal characters this uses
  // the morph-aware head-top computed at model build time; for the
  // placeholder fallback (and any non-skeletal entity) the sprite's
  // built-in default position is left in place.
  if (mesh.headHeightWorld > 0) {
    mesh.nameLabel.position.y = mesh.headHeightWorld + 0.3;
  }
}

/** Sync mesh world position and facing from entity state. */
export function updateEntityMesh(mesh: EntityMeshGroup, state: EntityState): void {
  const pos = state.position;
  if (pos) {
    // world(x, y, z) → three(x, height, y)
    // groundOffsetWorld lifts the visual mesh so the lowest voxels rest on terrain
    // without affecting server physics (position.z is always the terrain contact point).
    mesh.group.position.set(pos.x, pos.z + mesh.groundOffsetWorld, pos.y);
  }

  const facing = state.facing;
  if (facing !== undefined) {
    mesh.group.rotation.y = -facing.angle - Math.PI / 2;
  }

  // Record position snapshot for interpolation (only when position actually changed).
  // Store the offset-adjusted y so interpolation also renders at the correct height.
  if (pos) {
    mesh.posBuffer.push({
      t: performance.now(),
      x: pos.x, y: pos.z + mesh.groundOffsetWorld, z: pos.y,
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

  syncNameLabel(mesh, state);
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
    slot = { anchor, modelId: null, boneParented: false, bladeAttach: null };
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
    slot = { anchor, modelId: null, boneParented: true, bladeAttach: null };
    mesh.attachments.set(slotId, slot);
  }
  return slot;
}

/** Bake specs for `attachModelToSlot` — the model's nodes at `scale`, in order. */
export function collectSlotBakeSpecs(
  modelDef: ModelDefinition,
  scale: { x: number; y: number; z: number },
): VoxelBakeSpec[] {
  return modelDef.nodes.map((node) => nodeBakeSpec(node, scale));
}

/**
 * Build model voxels for a slot and add them as children of its anchor.
 * Replaces any previously loaded model for this slot cleanly.
 * Creates the slot anchor if it does not yet exist (entity-root only;
 * for bone-parented slots, call ensureBoneAttachment first).
 *
 * @param onTop  When true, enables polygonOffset so voxels render on top of
 *               any co-located body-part voxels without z-fighting.
 * @param baked  Optional pre-baked voxels (collectSlotBakeSpecs order); when
 *               absent each voxel bakes synchronously.
 */
export function attachModelToSlot(
  mesh: EntityMeshGroup,
  slotId: string,
  modelDef: ModelDefinition,
  materials: Map<number, MaterialDef>,
  scale: { x: number; y: number; z: number },
  onTop = false,
  /**
   * Optional translation applied to the inner modelGroup after voxel
   * placement. Used by hand slots to put the weapon's pommel (model AABB
   * bottom) AT the hand bone instead of the model's authored origin —
   * authored origins commonly sit mid-grip, which makes the weapon look
   * "attached in the middle" with half hanging off the back of the wrist.
   */
  anchorOffset?: { x: number; y: number; z: number },
  baked?: BakedVoxel[],
): void {
  const slot = ensureAttachment(mesh, slotId);
  detachModelFromSlot(mesh, slotId);   // clear previous model first
  const cursor = bakedCursor(baked);

  const modelGroup = new THREE.Group();
  modelGroup.name = `model:${modelDef.id}`;
  for (const node of modelDef.nodes) {
    modelGroup.add(buildVoxelMesh(node, materials, scale, onTop, cursor));
  }
  if (anchorOffset) modelGroup.position.set(anchorOffset.x, anchorOffset.y, anchorOffset.z);
  slot.anchor.add(modelGroup);
  slot.modelId = modelDef.id;
}

/**
 * The armor voxel scale for a bone-parented slot: entityScale × the slot's
 * stored armorSubScale.  Used by both `attachArmorToSlot` and its bake-spec
 * collector so the two agree.  Returns null when the slot doesn't exist yet.
 */
export function armorSlotScale(
  mesh: EntityMeshGroup,
  slotId: string,
  entityScale: { x: number; y: number; z: number },
): { x: number; y: number; z: number } | null {
  const slot = mesh.attachments.get(slotId);
  if (!slot) return null;
  const subScale: number = slot.anchor.userData.armorSubScale ?? 1;
  return { x: entityScale.x * subScale, y: entityScale.y * subScale, z: entityScale.z * subScale };
}

/**
 * Like attachModelToSlot but for bone-parented slots whose anchor was created
 * by ensureBoneAttachment.  Reads armorSubScale from anchor.userData to build
 * voxels at the correct sub-object scale.  Always enables onTop polygonOffset.
 *
 * @param baked  Optional pre-baked voxels (modelDef.nodes order at armorScale);
 *               when absent each voxel bakes synchronously.
 */
export function attachArmorToSlot(
  mesh: EntityMeshGroup,
  slotId: string,
  modelDef: ModelDefinition,
  materials: Map<number, MaterialDef>,
  entityScale: { x: number; y: number; z: number },
  baked?: BakedVoxel[],
): void {
  const slot = mesh.attachments.get(slotId);
  if (!slot) return; // ensureBoneAttachment must be called first
  detachModelFromSlot(mesh, slotId);
  const cursor = bakedCursor(baked);

  const armorScale = armorSlotScale(mesh, slotId, entityScale)!;

  const modelGroup = new THREE.Group();
  modelGroup.name = `model:${modelDef.id}`;
  for (const node of modelDef.nodes) {
    modelGroup.add(buildVoxelMesh(node, materials, armorScale, true, cursor));
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
    child.traverse((obj: THREE.Object3D) => {
      if (!(obj instanceof THREE.Mesh)) return;
      (obj.material as THREE.Material).dispose();
      obj.geometry.dispose();
    });
  }
  slot.modelId = null;
}

// ---- dispose ----

export function disposeEntityMesh(mesh: EntityMeshGroup): void {
  clearMeshContent(mesh);
  if (mesh.nameLabel) {
    disposeNameSprite(mesh.nameLabel);
    mesh.nameLabel = null;
  }
  // GEO_BODY, GEO_DIR, GEO_UNIT are shared — do NOT dispose them here
}


