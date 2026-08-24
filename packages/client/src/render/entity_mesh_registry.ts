/// <reference lib="dom" />
/**
 * EntityMeshRegistry — the entity-mesh lifecycle, extracted from VoximRenderer
 * (T-282, Phase 2). Owns the live animated-entity meshes (`meshes`) and the
 * static-prop world positions (`propPositions`), and runs the async
 * spawn→build state machine that upgrades a placeholder into either a skeletal
 * model or a pooled static prop.
 *
 * The renderer keeps scene/camera/post-FX/lighting and drives the per-frame
 * pose + interpolation loop, reaching the meshes through `all` / `get(id)`. The
 * one accepted cross-call is `updateAttachmentPositions`, invoked from the
 * render loop because the per-mesh attachment math is entity-domain
 * (boneGroups + weaponActions + each slot's resolved `restBoneId`).
 *
 * The three async stale guards in `updateEntity` (and the per-slot re-checks in
 * the sync* helpers) are preserved verbatim — they defend against the entity
 * being removed, replaced, or pooled while a model prefetch is in flight.
 */
import * as THREE from "three";
import type { ClientWorld, EntityState } from "../state/client_world.ts";
import type { ContentCache } from "../state/content_cache.ts";
import type {
  MaterialDef,
  ModelDefinition,
  ResolvedSubObject,
  WeaponActionDef,
  Prefab,
  AnimationStateData,
  SkeletonDef,
  BladeGrammarParams,
  ArmorGrammarParams,
  BowGrammarParams,
} from "@voxim/content";
import { resolveSubObjects, resolveMorphParams, bladeGrammarAtoms, bowGrammarAtoms } from "@voxim/content";
import { humanoidGrammarByBone } from "./procmodel/generators/humanoid_grammar.ts";
import { armorGrammarByBone } from "./procmodel/generators/armor_grammar.ts";
import type { HoverOutlineSink } from "./renderer.ts";
import { modelToThree } from "./coords.ts";
import {
  createEntityMesh,
  updateEntityMesh,
  upgradeToSkeletonModel,
  ensureAttachment,
  ensureBoneAttachment,
  attachModelToSlot,
  attachArmorToSlot,
  attachAtomsToSlot,
  armorSlotScale,
  detachModelFromSlot,
  disposeEntityMesh,
  type EntityMeshGroup,
} from "./entity_mesh.ts";
import type { InstancePool, InstanceSlot } from "./instance_pool.ts";
import { buildSubModelGeo } from "./voxel_geo.ts";
import { buildVoxelMaterial } from "./voxel_material.ts";
import { canopyFade } from "./canopy_fade.ts";
import { evaluateBladeWorld } from "./skeleton_evaluator.ts";
import type { SkeletonOverlay } from "./skeleton_overlay.ts";
import type { DebugOverlayManager } from "./debug_overlay_manager.ts";
import type { LightManager } from "./light_manager.ts";
import { CHUNK_SIZE } from "@voxim/world";

/**
 * Squared speed below which a static prop is allowed to settle into the pool.
 * applySnapshot writes velocity = {0,0,0} for every entity regardless of
 * whether the server treats it as a real Velocity component, so the transition
 * tests magnitude (not presence) to avoid deferring all props forever.
 */
const VELOCITY_EPSILON_SQ = 0.01;

/**
 * Deterministic string hash (FNV-1a) → a procedural seed from an EntityId
 * (T-306). Byte-identical to the tile-server's `spawner.ts` / combat.ts
 * `hash32` (used for `ModelRef.seed` / the weapon_trace blade override) so
 * an equipped item's generated blade / armor plate is seed-unique with the
 * SAME seed both sides — derived independently from the already-networked
 * EquipmentSlot.entityId, zero wire cost. (Kept as a local copy to match the
 * existing convention — the same hash is duplicated at several call sites
 * across tile-server/client rather than centralised.)
 */
function hash32(s: string): number {
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

// Reusable scratch vectors for per-frame attachment placement (no per-call alloc).
const _attachTmp   = new THREE.Vector3();
const _bladeTip    = new THREE.Vector3();
const _bladeUp     = new THREE.Vector3(0, 1, 0);  // world-up used as orientation hint
const _attachQuat  = new THREE.Quaternion();

/**
 * T-223 — resolve which bone (if any) an equipped item's entity should
 * render against, by walking the REPLICATED SCENE GRAPH instead of a
 * hand-maintained slotId→boneId table. The item's own `Parent` names its
 * attach point; `boneIdByEntity` (built once per skeleton from the
 * character's bone-entity children, see `updateEntity`) turns that entity
 * id into a content boneId when the parent IS a bone.
 *
 * Three-way result, not `string | null` — a transient "haven't resolved
 * yet" must never be confused with "this item structurally has no single
 * bone" (T-220 deliberately parents legs/feet items to the HOLDER ROOT,
 * not a bone, because a `Parent` edge is 1:1 and those slots cover multiple
 * bones): `holderRoot` is the unambiguous, content-independent signal for
 * that case (parentId === characterId), never inferred from an absent bone
 * mapping.
 */
export type ItemAttachResolution =
  | { kind: "bone"; boneId: string }
  | { kind: "holderRoot" }
  | { kind: "unresolved" };

export function resolveItemAttachment(
  world: ClientWorld,
  mesh: Pick<EntityMeshGroup, "boneIdByEntity">,
  characterId: string,
  itemEntityId: string,
): ItemAttachResolution {
  const parentId = world.get(itemEntityId)?.parent?.entityId ?? null;
  if (parentId === null) return { kind: "unresolved" };
  const boneId = mesh.boneIdByEntity.get(parentId);
  if (boneId) return { kind: "bone", boneId };
  if (parentId === characterId) return { kind: "holderRoot" };
  return { kind: "unresolved" };
}

/**
 * Body anchors for slung (non-active) hotbar items (T-309). Bone-parented,
 * like armor, but built at the item's own ABSOLUTE scale (prefab.modelScale)
 * the way held weapons are — generalizing syncHandSlot's absolute-scale
 * build onto a bone anchor instead of an entity-root one — since a sheathed
 * sword shouldn't inherit the body's scale the way a form-fitting armor
 * plate does.
 *
 * `pos`/`rot` are model-space offsets from the bone origin (x=right,
 * y=forward, z=up; rot is Euler radians in the same axes) — AESTHETIC
 * defaults picked by code review, not measured against a live character.
 * Tunable; see T-309 lane report for the exact live-verification procedure.
 *
 * A LIMITED set for now (3 anchors) — the ticket's full vision extends this
 * count via carry-equipment (backpack/belt), gating which hotbar slots even
 * have a body anchor to sling from. Not built here (deferred, see TICKETS.md).
 */
const HOTBAR_BODY_ANCHORS: Record<string, {
  boneId: string;
  pos: readonly [number, number, number];
  rot: readonly [number, number, number];
}> = {
  // Slung high across the back, blade roughly vertical along the spine.
  sheath_back: { boneId: "torso_upper", pos: [0, -0.15, 0.15], rot: [-0.3, 0, 0] },
  // Belted at the left hip, angled slightly head-down (axe/tool silhouette).
  hip_l: { boneId: "torso_lower", pos: [0.4, 0.05, -0.05], rot: [1.4, 0, 0] },
  // Belted at the right hip, mirrored.
  hip_r: { boneId: "torso_lower", pos: [-0.4, 0.05, -0.05], rot: [1.4, 0, 0] },
};

/**
 * Hotbar slot index → body anchor id. Only the first 3 slots have an anchor
 * today (see HOTBAR_BODY_ANCHORS doc); slots 3-7 hold items but render
 * nothing on the body until a carry-equipment slot extends the anchor set.
 */
const HOTBAR_SLOT_ANCHOR: ReadonlyArray<keyof typeof HOTBAR_BODY_ANCHORS | null> =
  ["sheath_back", "hip_l", "hip_r", null, null, null, null, null];

export class EntityMeshRegistry {
  private readonly meshes        = new Map<string, EntityMeshGroup>();
  private readonly propPositions = new Map<string, THREE.Vector3>();

  // Mutable deps set after construction by the renderer's setter delegations.
  private content: ContentCache | null = null;
  private localPlayerId: string | null = null;
  private hover: HoverOutlineSink | null = null;
  /** T-223 — read-only access to the replicated scene graph (childrenOf/
   *  descendants/get), for resolving attachment bones and building each
   *  skeleton's boneId↔bone-entityId identity map. */
  private clientWorld: ClientWorld | null = null;

  /**
   * Local player's hotbar occupancy (T-309) — one prefabId per hotbar slot
   * (null = empty), cached here because it isn't part of EntityState (the
   * hotbar is a client-local UI concept, not a networked component; see
   * TICKETS.md T-309). Re-applied to the local player's mesh on every
   * setHotbar() call and after skeleton (re)builds.
   */
  private hotbarPrefabIds: (string | null)[] = [];
  private hotbarActiveIndex = -1;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly instancePool: InstancePool,           // renderer-owned, injected by ref
    private readonly weaponActions: Map<string, WeaponActionDef>, // renderer-owned, read-only
    private readonly itemPrefabs:   Map<string, Prefab>,         // renderer-owned, read-only
    private readonly skeletonOverlay: SkeletonOverlay,     // trackEntity on skeleton upgrade
    private readonly lightManager:  LightManager,          // sync/remove per-entity point lights
    private readonly debug:         DebugOverlayManager,   // removeEntity on teardown
  ) {}

  setContent(c: ContentCache): void { this.content = c; }
  setClientWorld(w: ClientWorld): void { this.clientWorld = w; }
  setLocalPlayer(id: string | null): void { this.localPlayerId = id; }
  setHover(s: HoverOutlineSink | null): void { this.hover = s; }

  /**
   * Set the local player's hotbar occupancy for body-anchor rendering
   * (T-309). `prefabIds` is one entry per hotbar slot (null = empty);
   * `activeIndex` is the slot considered "in hand" and is skipped when
   * placing body anchors — purely cosmetic, does not equip anything (the
   * real Equipment system is the only thing that changes main_hand).
   */
  setHotbar(prefabIds: (string | null)[], activeIndex: number): void {
    this.hotbarPrefabIds = prefabIds;
    this.hotbarActiveIndex = activeIndex;
    const mesh = this.localPlayerId ? this.meshes.get(this.localPlayerId) : undefined;
    if (mesh) this.syncHotbar(mesh);
  }

  // ---- render-loop accessors ----
  /** Live entity meshes — the renderer iterates this for pose + interpolation. */
  get all(): ReadonlyMap<string, EntityMeshGroup> { return this.meshes; }
  get(id: string): EntityMeshGroup | undefined { return this.meshes.get(id); }
  get count(): number { return this.meshes.size; }

  /**
   * Test/automation (T-272 harness): world-space translation of a bone, or null
   * if the entity has no built skeleton or no such bone. Reads the SAME
   * `boneGroups` the per-frame pose drives (matrixWorld is current after the
   * render() that just ran), so sampling it twice across frames proves a clip
   * is actually advancing — not merely selected. `boneGroups == null` here also
   * tells the harness the skeleton was never built (the bake-pool wedge case).
   */
  sampleBoneWorld(entityId: string, boneId: string): [number, number, number] | null {
    const bone = this.meshes.get(entityId)?.boneGroups?.get(boneId);
    if (!bone) return null;
    const e = bone.matrixWorld.elements;
    return [e[12], e[13], e[14]];
  }

  /** Test/automation: true once the entity's animated skeleton rig is built
   * (boneGroups present). Lets the harness distinguish "no rig / bake wedged"
   * from "rig built but motionless". */
  hasSkeleton(entityId: string): boolean {
    return !!this.meshes.get(entityId)?.boneGroups;
  }

  updateEntity(entityId: string, state: EntityState): void {
    // Static props are fully managed by instancePool after their first model load.
    if (this.instancePool.has(entityId)) return;

    const isLocal = entityId === this.localPlayerId;
    let mesh = this.meshes.get(entityId);
    if (!mesh) {
      mesh = createEntityMesh(state, isLocal);
      mesh.group.name = "entity";
      this.scene.add(mesh.group);
      this.meshes.set(entityId, mesh);
    } else {
      updateEntityMesh(mesh, state);
    }

    // Upgrade to skeleton model (animated entity) or prop pool (static entity)
    // when modelRef arrives or changes.
    const modelRef = state.modelRef;
    if (modelRef && this.content && mesh.modelId !== modelRef.modelId) {
      const capture = mesh;
      const scale = { x: modelRef.scaleX, y: modelRef.scaleY, z: modelRef.scaleZ };
      this.content.prefetchModel(modelRef.modelId).then(async () => {
        // Stale .then guard — when an entity's prop transition is deferred
        // (Velocity present), prefetchModel is kicked again next tick.
        // The earlier promise may resolve after a later one already finished
        // the transition; bail before re-entering addProp / disposeMesh.
        if (this.instancePool.has(entityId)) return;
        const def = this.content!.getModelSync(modelRef.modelId);
        if (!def) return;

        const resolvedSubs = resolveSubObjects(def.subObjects, modelRef.seed ?? 0);

        const allMatIds = new Set<number>(def.materials);
        for (const sub of resolvedSubs) {
          const subDef = this.content!.getModelSync(sub.modelId);
          if (subDef) for (const id of subDef.materials) allMatIds.add(id);
        }
        const mats = new Map<number, MaterialDef>();
        for (const id of allMatIds) {
          const m = this.content!.getMaterialSync(id);
          if (m) mats.set(id, m);
        }

        const skeleton = def.skeletonId
          ? this.content!.getSkeletonSync(def.skeletonId)
          : undefined;

        const subModelDefs = new Map<string, ModelDefinition>();
        for (const sub of resolvedSubs) {
          const subDef = this.content!.getModelSync(sub.modelId);
          if (subDef) subModelDefs.set(sub.modelId, subDef);
        }

        if (skeleton) {
          // Stale guard: the entity may have transitioned to a prop or been
          // disposed during the async model prefetch above.
          if (this.instancePool.has(entityId) || this.meshes.get(entityId) !== capture) return;
          // modelRef.morphValues carries per-instance overrides (T-180, e.g.
          // drowner's longer arms, rotten_knight's giant right arm) — passing
          // them through is what makes the recipe body (and the skeleton
          // itself) actually vary per archetype instead of always resolving
          // the seed-randomized default. Previously omitted here (a latent
          // bug: the pose/hitbox-debug paths already passed overrides via
          // mesh.modelMorphs, only this mesh-BUILD call didn't).
          const morphParams = resolveMorphParams(skeleton, modelRef.seed ?? 0, modelRef.morphValues);
          // Death-dissolve (T-311 P5c): see ContentCache.getSoleDissolveProfileSync's
          // doc comment for the known v1 limitation (no per-entity archetype id
          // on the wire yet) — undefined here means "bake byte-identically",
          // which is also what happens for every non-corrupted entity today.
          const dissolveProfile = this.content!.getSoleDissolveProfileSync() ?? undefined;
          // T-186 Layer 2 / T-302: recipe-driven body volumes replace authored
          // bone_segment sub-objects — voxelize once per morph resolution,
          // keyed by boneId, merged into upgradeToSkeletonModel's per-bone
          // Groups alongside (not instead of) any remaining authored subs.
          // humanoidGrammarByBone is the humanoid_grammar generator's
          // per-bone entry point (bone-LOCAL atoms, for live pose) — it
          // wraps the same evaluateBodyRecipe() core the registered flat
          // generator also builds on, so there is exactly one body-volume
          // evaluator behind both call sites.
          const recipeAtoms = skeleton.bodyRecipe
            ? humanoidGrammarByBone(skeleton, morphParams, (name) => {
                const m = this.content!.getMaterialByName(name);
                if (!m) throw new Error(`[entity_mesh] bodyRecipe on skeleton "${skeleton.id}" uses unknown material "${name}"`);
                return m.id;
              })
            : undefined;
          // Build the skeleton's per-sub-object meshes — one merged mesh per
          // material through the bakeVoxels kitchen (T-281). A character is tens
          // of voxels, so the bake is sub-millisecond on the main thread; the
          // off-thread pool + collector/cursor coupling it replaced is gone.
          upgradeToSkeletonModel(capture, def, skeleton, resolvedSubs, subModelDefs, mats, scale, morphParams, dissolveProfile, recipeAtoms);
          // Re-attach the hover outline to the freshly built meshes — it
          // attaches via the entity's group, which now holds real geometry
          // instead of the placeholder.
          this.hover?.notifyEntityRebuilt(entityId);
          capture.modelSeed   = modelRef.seed  ?? 0;
          capture.modelScale  = modelRef.scaleX ?? 0;
          capture.modelMorphs = modelRef.morphValues;
          this.skeletonOverlay.trackEntity(entityId, capture, skeleton);

          // Record each sub-object's transform so armor anchors can be placed
          // at the same position and scale as the body-part they overlay.
          capture.boneSlotTransforms.clear();
          for (const sub of resolvedSubs) {
            if (sub.boneId && sub.transform.scaleX === sub.transform.scaleY &&
                sub.transform.scaleX === sub.transform.scaleZ) {
              capture.boneSlotTransforms.set(sub.boneId, {
                x: sub.transform.x, y: sub.transform.y, z: sub.transform.z,
                scale: sub.transform.scaleX,
              });
            }
          }

          // T-223: boneId ↔ bone-ENTITY-id identity map, built from the
          // character entity's replicated bone children. A full-subtree walk
          // (not direct children) is required — only the skeleton ROOT bone
          // is a direct child of the character entity; every other bone
          // parents to its own parent BONE entity, mirroring the content
          // SkeletonDef hierarchy (spawner.ts's installSkeletonBones). Maps
          // were already cleared by clearMeshContent (inside
          // upgradeToSkeletonModel above), so this is a pure rebuild.
          if (this.clientWorld) {
            for (const descId of this.clientWorld.descendants(entityId)) {
              const boneId = this.clientWorld.get(descId)?.bone?.boneId;
              if (!boneId) continue; // an equipped item or other non-bone descendant
              capture.boneEntityByBoneId.set(boneId, descId);
              capture.boneIdByEntity.set(descId, boneId);
            }
          }

          // Sync all equipment slots now that boneGroups exist.
          this.syncEquipment(capture, entityId, state);
          // Re-apply any cached hotbar occupancy (T-309) — setHotbar() may
          // have been called before this async skeleton build finished.
          if (entityId === this.localPlayerId) this.syncHotbar(capture);
        } else {
          // Static prop — hand off to instanced pool, discard the placeholder Group.
          // InstancePool bakes the entity's position into an instance matrix
          // once and never updates it.  So we MUST defer the transition until
          // the entity has actually settled — ejected ground items have
          // non-zero velocity while flying, and freezing them mid-arc strands
          // the visual at a random air position.
          //
          // Test on velocity MAGNITUDE rather than presence: applySnapshot
          // writes velocity = {0,0,0} for every entity in every snapshot
          // regardless of whether the server treats it as a "real" Velocity
          // component, so a presence check defers all static props forever.
          const v = state.velocity;
          if (v && (v.x * v.x + v.y * v.y + v.z * v.z) > VELOCITY_EPSILON_SQ) {
            // Try again next tick. The placeholder mesh keeps tracking the
            // entity's Position each tick via updateEntityMesh, so motion stays
            // smooth until the item lands and velocity falls to zero.
            return;
          }
          const worldPos = capture.group.position.clone();
          this.scene.remove(capture.group);
          disposeEntityMesh(capture);
          this.meshes.delete(entityId);
          // Per-prop Y rotation: tile-server writes Facing with a
          // deterministic per-tree angle so a forest doesn't read as a
          // grid. Archetypes batch by (modelId, matId, scale); rotation
          // rides in the per-instance matrix the InstancePool uploads.
          const rotationY = state.facing?.angle ?? 0;
          this._addStaticProp(entityId, worldPos, def, resolvedSubs, subModelDefs, mats, scale, rotationY);
          this.propPositions.set(entityId, worldPos);
        }
      }).catch(() => {});
    }

    // React to equipment changes on already-upgraded skeleton entities.
    // syncEquipment exits early per-slot when the model ID hasn't changed.
    if (mesh.boneGroups && state.equipment !== undefined) {
      this.syncEquipment(mesh, entityId, state);
    }

    // Sync point light (torch, lantern, etc.).
    this.lightManager.sync(entityId, state.lightEmitter, mesh.group);
  }

  /**
   * Register a server-spawned static prop (ground item, ruin, resource
   * node) into the InstancePool. Builds one slot per (sub-model ×
   * material) the model uses; archetypes are registered lazily on first
   * sight of a (modelId, matId, scale) triple. Chunk key is derived
   * from world position so the pool's per-frame culling can skip props
   * whose chunk is outside the visible window.
   */
  private _addStaticProp(
    entityId:     string,
    worldPos:     THREE.Vector3,
    mainDef:      ModelDefinition,
    resolvedSubs: readonly ResolvedSubObject[],
    subModelDefs: Map<string, ModelDefinition>,
    mats:         Map<number, MaterialDef>,
    scale:        { x: number; y: number; z: number },
    rotationY:    number,
  ): void {
    const slots: InstanceSlot[] = [];

    // Per-prop world transform = translate(worldPos) × rotateY(rotationY).
    const propMat = new THREE.Matrix4()
      .makeTranslation(worldPos.x, worldPos.y, worldPos.z)
      .multiply(new THREE.Matrix4().makeRotationY(rotationY));

    const registerModel = (def: ModelDefinition, subMatrix: THREE.Matrix4) => {
      const matIds = new Set(def.nodes.map((n) => n.materialId));
      for (const matId of matIds) {
        const archId = `prop:${def.id}|${matId}|${scale.x.toFixed(3)}|${scale.y.toFixed(3)}|${scale.z.toFixed(3)}`;
        if (!this.instancePool.hasArchetype(archId)) {
          // T-326: static props (ruins, resource nodes, built structures) read
          // the same render.relief.dispMag knob terrain/scatter/characters do —
          // the one warp-amplitude home, one shared bake application point.
          const geometry = buildSubModelGeo(def.nodes, matId, scale, mats.get(matId)?.render?.relief?.dispMag);
          const material = this._buildPropMaterial(matId, mats);
          this.instancePool.registerArchetype(archId, {
            geometry, material, castShadow: true, receiveShadow: true,
          });
        }
        const slotMat = new THREE.Matrix4().multiplyMatrices(propMat, subMatrix);
        slots.push({ archetypeId: archId, matrix: slotMat });
      }
    };

    if (mainDef.nodes.length > 0) {
      registerModel(mainDef, new THREE.Matrix4());
    }

    for (const sub of resolvedSubs) {
      const subDef = subModelDefs.get(sub.modelId);
      if (!subDef) continue;
      const t = sub.transform;
      const sp = modelToThree(t.x, t.y, t.z, scale);
      const subPos = new THREE.Vector3(sp.x, sp.y, sp.z);
      const subQuat = new THREE.Quaternion()
        .setFromEuler(new THREE.Euler(t.rotX, t.rotZ, t.rotY, "XYZ"));
      const subMatrix = new THREE.Matrix4().compose(subPos, subQuat, new THREE.Vector3(1, 1, 1));
      registerModel(subDef, subMatrix);
    }

    if (slots.length === 0) return;
    const chunkKey = `${Math.floor(worldPos.x / CHUNK_SIZE)},${Math.floor(worldPos.z / CHUNK_SIZE)}`;
    this.instancePool.add(entityId, chunkKey, slots);
  }

  /** Build a Three.js material for a prop voxel.  Mirrors what
   *  ScatterRenderer does for scatter archetypes — same Phong + flat
   *  shading + canopyFade registration, but materials are not shared
   *  across the two systems because they may diverge over time and the
   *  shared-cache complexity isn't worth it for a few extra materials. */
  private _buildPropMaterial(matId: number, mats: Map<number, MaterialDef>): THREE.Material {
    const mat = buildVoxelMaterial(mats.get(matId), matId);
    canopyFade.register(mat);
    return mat;
  }

  removeEntity(entityId: string): void {
    if (this.instancePool.has(entityId)) {
      this.instancePool.remove(entityId);
      this.propPositions.delete(entityId);
      this.debug.removeEntity(entityId);
      return;
    }
    const mesh = this.meshes.get(entityId);
    if (mesh) {
      this.lightManager.remove(entityId, mesh.group);
      this.debug.removeEntity(entityId);
      this.scene.remove(mesh.group);
      disposeEntityMesh(mesh);
      this.meshes.delete(entityId);
    }
  }

  /** Public read access to an entity's mesh group — used by InteractionSystem and HoverOutlineRenderer. */
  getEntityMesh(entityId: string): EntityMeshGroup | null {
    return this.meshes.get(entityId) ?? null;
  }

  /** World position of a static prop entity, or null if it isn't in the prop pool. */
  getPropPosition(entityId: string): THREE.Vector3 | null {
    return this.propPositions.get(entityId) ?? null;
  }

  /**
   * Tear down every live entity and pooled prop (tile transition / world clear).
   * Two loops because a pooled entity lives only in propPositions and a live one
   * only in meshes — removeEntity routes each to the right teardown.
   */
  clear(): void {
    for (const id of [...this.meshes.keys()]) this.removeEntity(id);
    for (const id of [...this.propPositions.keys()]) this.removeEntity(id);
  }

  /** Dispose every entity mesh (renderer teardown). */
  disposeAll(): void {
    for (const [, mesh] of this.meshes) disposeEntityMesh(mesh);
  }

  /**
   * Sync all equipment slots for an entity whose skeleton is already built.
   * Called after skeleton upgrade and on every equipment delta.
   * Each slot exits early when its model ID hasn't changed.
   */
  /**
   * T-223 — every equipped item's attach bone is resolved from the
   * REPLICATED SCENE GRAPH (`resolveItemAttachment`), not a hand-maintained
   * slotId/equipSlot→boneId table: an item renders where it does because
   * its ENTITY is a child of a bone entity (or, for legs/feet, the holder
   * root itself — see `syncArmorEquipSlot`). `entityId` is the holder
   * (character) entity, needed to tell "holder root" apart from "not
   * resolved yet".
   */
  private syncEquipment(mesh: EntityMeshGroup, entityId: string, state: EntityState): void {
    if (!mesh.boneGroups || !this.content || !this.clientWorld) return;
    const world = this.clientWorld;

    const eq = state.equipment;
    const entityScale = state.modelRef
      ? { x: state.modelRef.scaleX, y: state.modelRef.scaleY, z: state.modelRef.scaleZ }
      : { x: 0.35, y: 0.35, z: 0.35 };

    // ── Weapon (main_hand): entity-root anchor, repositioned per-frame ──────
    const weaponRes = eq?.weapon ? resolveItemAttachment(world, mesh, entityId, eq.weapon.entityId) : null;
    this.syncHandSlot(mesh, "main_hand", eq?.weapon ?? null, entityScale, weaponRes?.kind === "bone" ? weaponRes.boneId : null);

    // ── Off-hand: entity-root anchor, follows its resolved bone per-frame ───
    const offRes = eq?.offHand ? resolveItemAttachment(world, mesh, entityId, eq.offHand.entityId) : null;
    this.syncHandSlot(mesh, "off_hand", eq?.offHand ?? null, entityScale, offRes?.kind === "bone" ? offRes.boneId : null);

    // ── Armor: bone-parented anchors, resolved per slot (single bone, or a
    //    content-driven multi-bone fan-out for legs/feet) ────────────────────
    for (const equipSlot of ["head", "chest", "back", "legs", "feet"] as const) {
      const slot = (eq as Record<string, { entityId: string; prefabId: string } | null> | undefined)?.[equipSlot] ?? null;
      this.syncArmorEquipSlot(mesh, entityId, equipSlot, slot, entityScale);
    }
  }

  /**
   * Sync one armor equip slot. Single-bone slots (head/chest/back) resolve
   * straight from the graph and use the equip slot NAME as the render-slot
   * key (matching the pre-T-223 shape, so two different equip slots that
   * happen to share a bone — chest + back both attach to torso_upper — keep
   * independent anchors). Legs/feet resolve to the HOLDER ROOT (T-220: no
   * single bone) and fan out over the item's own `armor.coversBones`
   * (content data, T-223) — NOT a static equip-slot→bone-list table, and
   * NOT every bone the item's `armorGrammar` happens to author (a grammar
   * like `plate_armor_iron` is shared across three different items covering
   * different bones each). Render-slot keys for the fan-out case are
   * `${equipSlot}:${boneId}`, reaped against `coversBones` each call so an
   * item swap that authors a different bone subset can't leave a stale
   * anchor behind.
   */
  private syncArmorEquipSlot(
    mesh: EntityMeshGroup,
    characterId: string,
    equipSlot: "head" | "chest" | "back" | "legs" | "feet",
    slot: { entityId: string; prefabId: string } | null,
    entityScale: { x: number; y: number; z: number },
  ): void {
    const isOwnKey = (key: string) => key === equipSlot || key.startsWith(`${equipSlot}:`);
    const reapExcept = (active: Set<string>) => {
      for (const key of [...mesh.attachments.keys()]) {
        if (isOwnKey(key) && !active.has(key)) detachModelFromSlot(mesh, key);
      }
    };

    if (!slot) { reapExcept(new Set()); return; }

    const prefab  = this.itemPrefabs.get(slot.prefabId) ?? null;
    const modelId = prefab?.modelId ?? null;
    const res = resolveItemAttachment(this.clientWorld!, mesh, characterId, slot.entityId);

    // Transient — the item's Parent hasn't arrived/resolved yet. Self-heals:
    // updateEntity re-runs syncEquipment every tick the equipment field is
    // present, so this is never a permanently stuck state. Leave whatever
    // was already rendered (if anything) alone rather than tearing it down.
    if (res.kind === "unresolved") return;

    if (res.kind === "bone") {
      this.syncArmorSlot(mesh, equipSlot, res.boneId, modelId, slot.entityId, prefab, entityScale);
      reapExcept(new Set([equipSlot]));
      return;
    }

    // holderRoot — a multi-bone slot (legs/feet, T-220). Fan out over the
    // bones THIS item declares, not every bone its (possibly-shared)
    // armorGrammar authors.
    const armorData = prefab?.components?.["armor"] as { armorGrammar?: string; coversBones?: string[] } | undefined;
    const coversBones = armorData?.coversBones ?? [];
    if (!armorData?.armorGrammar || coversBones.length === 0) {
      // Unreachable by real content today (the loader's validateArmorCoversBones
      // requires coversBones for any legs/feet armor prefab) — defensive only.
      console.warn(`[entity_mesh_registry] "${slot.prefabId}" equips into "${equipSlot}" (a multi-bone slot) with no armor.coversBones — nothing to render`);
      reapExcept(new Set());
      return;
    }
    const active = new Set<string>();
    for (const boneId of coversBones) {
      const renderSlotId = `${equipSlot}:${boneId}`;
      active.add(renderSlotId);
      this.syncArmorSlot(mesh, renderSlotId, boneId, modelId, slot.entityId, prefab, entityScale);
    }
    reapExcept(active);
  }

  /**
   * Sync the local player's slung hotbar items (T-309) — bone-parented body
   * anchors (HOTBAR_BODY_ANCHORS), one per mapped hotbar slot, holding each
   * occupied NON-active slot's item at its own absolute weapon scale (same
   * build as syncHandSlot, just anchored to a bone instead of the entity
   * root). The active slot is skipped — its item is presumed already in
   * hand via the separate, real Equipment system; this method never equips
   * anything, it only renders. Reads this.hotbarPrefabIds/hotbarActiveIndex,
   * cached by setHotbar() since the hotbar isn't part of EntityState.
   */
  private syncHotbar(mesh: EntityMeshGroup): void {
    if (!mesh.boneGroups || !this.content) return;
    const s = mesh.modelScale || 1;
    const entityScale = { x: s, y: s, z: s };

    for (let i = 0; i < HOTBAR_SLOT_ANCHOR.length; i++) {
      const renderSlotId = `hotbar_${i}`;
      const anchorId = HOTBAR_SLOT_ANCHOR[i];
      const anchorDef = anchorId ? HOTBAR_BODY_ANCHORS[anchorId] : null;
      const occupied = anchorDef && i !== this.hotbarActiveIndex
        ? (this.hotbarPrefabIds[i] ?? null)
        : null;
      const prefab  = occupied ? this.itemPrefabs.get(occupied) : null;
      const modelId = prefab?.modelId ?? null;

      const existing = mesh.attachments.get(renderSlotId);
      if (modelId === (existing?.modelId ?? null)) continue;   // unchanged

      detachModelFromSlot(mesh, renderSlotId);
      if (!modelId || !anchorDef) continue;

      const boneGroup = mesh.boneGroups.get(anchorDef.boneId);
      if (!boneGroup) continue;   // bone not present on this skeleton

      const pendingSlot = ensureBoneAttachment(
        mesh, renderSlotId, boneGroup,
        anchorDef.pos[0], anchorDef.pos[1], anchorDef.pos[2],
        entityScale, 1, anchorDef.rot,
      );
      pendingSlot.modelId = modelId;   // reserve

      // Absolute item scale, same convention syncHandSlot uses for held
      // weapons — a slung sword doesn't inherit the body's scale the way a
      // form-fitting armor plate does.
      const itemScale = prefab?.modelScale ?? 1.0;
      const voxelScale = { x: itemScale, y: itemScale, z: itemScale };
      this.loadSlotModel(mesh, renderSlotId, modelId, (def, mats) => {
        attachModelToSlot(mesh, renderSlotId, def, mats, voxelScale);
      });
    }
  }

  /**
   * Sync a single entity-root attachment slot (weapon or off-hand).
   * The anchor is positioned per-frame by updateAttachmentPositions.
   *
   * `holdBoneId` is the bone `resolveItemAttachment` (T-223) resolved from
   * the scene graph for this item, or null while that's still transient
   * (the item's `Parent` hasn't decoded yet). It is the PRIMARY source for
   * `restBoneId`; the `?? primaryAction?.holdHand ?? "hand_r"/"hand_l"`
   * chain below is only the narrow bootstrap default for that transient
   * window (self-heals next tick once the graph resolves), never a
   * reinstated slotId→bone table.
   */
  private syncHandSlot(
    mesh: EntityMeshGroup,
    slotId: "main_hand" | "off_hand",
    slot: { entityId: string; prefabId: string } | null,
    _entityScale: { x: number; y: number; z: number },
    holdBoneId: string | null,
  ): void {
    const prefabId = slot?.prefabId ?? null;
    const prefab  = (prefabId ? this.itemPrefabs.get(prefabId) : null) ?? null;
    const modelId = prefab?.modelId ?? null;
    // T-306: a generated blade shares one anchor `modelId` (`generated_blade`)
    // across every procedural sword, so the modelId-unchanged early-exit can't
    // tell two different generated swords apart — key the generated case on the
    // ITEM entity id too. T-346: `bowGrammar` is the same shape (a generated
    // bow/crossbow shares one `generated_bow` anchor) so it needs the same
    // item-id keying.
    const swingableComp = prefab?.components?.["swingable"] as
      | { bladeGrammar?: string; bowGrammar?: string }
      | undefined;
    const bladeGrammarId = swingableComp?.bladeGrammar ?? null;
    const bowGrammarId = swingableComp?.bowGrammar ?? null;
    const itemId = slot?.entityId ?? null;

    const existing = mesh.attachments.get(slotId);
    const unchanged = modelId === (existing?.modelId ?? null) &&
      (!(bladeGrammarId || bowGrammarId) || itemId === (existing?.builtItemId ?? null));
    if (unchanged) {
      // The model didn't change, but the graph-resolved bone may have
      // (e.g. it just resolved out of "unresolved") — keep restBoneId current
      // even on the early-exit path.
      if (existing && holdBoneId) existing.restBoneId = holdBoneId;
      return;
    }

    detachModelFromSlot(mesh, slotId);
    if (slotId === "main_hand") mesh.bladeDimensions = null;
    const existingSlot = mesh.attachments.get(slotId);
    if (existingSlot) { existingSlot.bladeAttach = null; existingSlot.builtItemId = null; }
    if (!modelId) return;

    const pendingSlot = ensureAttachment(mesh, slotId);
    pendingSlot.modelId = modelId;   // reserve to prevent races
    if (holdBoneId) pendingSlot.restBoneId = holdBoneId;

    // Held weapons size themselves in absolute world units via the prefab's
    // own `modelScale` — independent of the holder's body scale. Using the
    // entity's scale here made a sword inherit the player's 2.4× scale and
    // come out 6× the size of the character (24 voxels × 2.4). The voxel
    // anchor is parented to the bone and the bone is already positioned in
    // world units by the body's entity scale, so the weapon doesn't need a
    // second multiplication.
    const weaponScale = prefab?.modelScale ?? 1.0;
    const voxelScale = { x: weaponScale, y: weaponScale, z: weaponScale };

    // T-306: a blade_grammar weapon bakes its held model from the generator's
    // seed-unique atoms (blade_grammar emits along model +z, matching the
    // authored-sword convention below), NOT the empty-nodes anchor model. The
    // seed is hash32(itemEntityId) — the SAME derivation the server's
    // weapon_trace resolver uses (see combat.ts) so the visible blade and the
    // swept hitbox share one geometry.
    if (bladeGrammarId && itemId) {
      this.bakeGeneratedBlade(mesh, slotId, modelId, itemId, bladeGrammarId, prefab, weaponScale, holdBoneId);
      return;
    }

    // T-346: a bow_grammar weapon bakes its held model the same way a
    // blade_grammar weapon does — see bakeGeneratedBow's doc for how the
    // anchor semantics carry over unchanged (purely visual, no server
    // trace consumer).
    if (bowGrammarId && itemId) {
      this.bakeGeneratedBow(mesh, slotId, modelId, itemId, bowGrammarId, prefab, weaponScale, holdBoneId);
      return;
    }

    this.loadSlotModel(mesh, slotId, modelId, (def, mats) => {
      // AABB scan in model coords. Model Z is the blade-axis (voxel-rendered
      // → three.js Y). For hand slots we anchor the model's BOTTOM (minZ) at
      // the hand bone so the pommel sits in the fist and the blade extends
      // along the elbow→wrist axis. Authored sword origins are typically
      // mid-grip, which puts half the model behind the wrist if anchored
      // directly.
      let minX = Infinity, minY = Infinity, minZ = Infinity;
      let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
      for (const n of def.nodes) {
        if (n.x     < minX) minX = n.x;     if (n.x + 1 > maxX) maxX = n.x + 1;
        if (n.y     < minY) minY = n.y;     if (n.y + 1 > maxY) maxY = n.y + 1;
        if (n.z     < minZ) minZ = n.z;     if (n.z + 1 > maxZ) maxZ = n.z + 1;
      }
      // Voxel coord swap (entity_mesh.ts buildVoxelMesh): model (x,y,z) →
      // three.js (x*sx, z*sz, y*sy). To shift the lowest model-Z voxel to
      // three.js y=0, translate modelGroup by +(-minZ * sz) on three.js Y.
      const anchorOffset = { x: 0, y: -minZ * weaponScale, z: 0 };
      attachModelToSlot(mesh, slotId, def, mats, voxelScale, false, anchorOffset);

      if (slotId === "main_hand" && def.nodes.length > 0) {
        // Trail/hit-volume dimensions come from the model AABB after the
        // bottom-anchor shift: blade tip is at three.js y = (maxZ - minZ) *
        // weaponScale measured from the anchor (the pommel).
        mesh.bladeDimensions = {
          length:    (maxZ - minZ) * weaponScale,
          halfCross: Math.max(maxX - minX, maxY - minY) / 2 * weaponScale,
        };
      }
      // Cache the item's primary swingable action blade endpoints onto the
      // slot — used by updateAttachmentPositions for FK-driven hand
      // attachment. holdBone is overridden by the SLOT (main → hand_r,
      // off → hand_l) regardless of the action's authored holdHand,
      // because the same weapon prefab can sit in either hand and we
      // attach to whichever hand is actually equipping.
      const swingable = (prefab?.components?.["swingable"] as
        | { chain?: { light: string; heavy: string }[] }
        | undefined);
      const primaryActionId = swingable?.chain?.[0]?.light;
      const primaryAction = primaryActionId
        ? this.weaponActions.get(primaryActionId)
        : undefined;
      const slotHoldBone = holdBoneId
        ?? primaryAction?.holdHand
        ?? (slotId === "off_hand" ? "hand_l" : "hand_r");
      const newSlot = mesh.attachments.get(slotId);
      if (newSlot) {
        newSlot.restBoneId = slotHoldBone;
        if (primaryAction?.blade) {
          newSlot.bladeAttach = {
            base: [primaryAction.blade.baseLocal[0], primaryAction.blade.baseLocal[1], primaryAction.blade.baseLocal[2]],
            tip:  [primaryAction.blade.tipLocal[0],  primaryAction.blade.tipLocal[1],  primaryAction.blade.tipLocal[2]],
            holdBone: slotHoldBone,
          };
        }
      }
    });
  }

  /**
   * T-306 — bake a hand slot from a `blade_grammar` generator's seed-unique
   * atoms (a procedural weapon) instead of the empty-nodes anchor model.
   * Synchronous (a blade is tens of voxels): resolve the procModel, run the
   * shared `bladeGrammarAtoms` core with `seed = hash32(itemEntityId)` (the
   * SAME seed the server's weapon_trace derives independently → hit == visual),
   * scale to the weapon's `modelScale`, and attach through the atom bake path.
   * bladeDimensions (trail/anchor) come from the baked atoms' AABB exactly as
   * the authored path derives them from `def.nodes`.
   */
  private bakeGeneratedBlade(
    mesh: EntityMeshGroup,
    slotId: "main_hand" | "off_hand",
    modelId: string,
    itemId: string,
    bladeGrammarId: string,
    prefab: Prefab | null,
    weaponScale: number,
    holdBoneId: string | null,
  ): void {
    if (!this.content) return;
    const procModel = this.content.getProcModelSync(bladeGrammarId);
    const currentSlot = mesh.attachments.get(slotId);
    if (!procModel || !mesh.boneGroups || currentSlot?.modelId !== modelId) return;

    const seed = hash32(itemId);
    const rawAtoms = bladeGrammarAtoms(seed, procModel.params as BladeGrammarParams, (name) => {
      const m = this.content!.getMaterialByName(name);
      if (!m) throw new Error(`[blade_grammar] procModel "${bladeGrammarId}" uses unknown material "${name}"`);
      return m.id;
    });
    // Scale generator atoms (authored in world units) by the weapon's modelScale.
    const atoms = rawAtoms.map((a) => ({
      ...a,
      cx: a.cx * weaponScale, cy: a.cy * weaponScale, cz: a.cz * weaponScale,
      sx: a.sx * weaponScale, sy: a.sy * weaponScale, sz: a.sz * weaponScale,
    }));

    // AABB in model space (blade axis = model +z, per blade_grammar). Anchor
    // the model's lowest z (pommel butt) at the hand bone, same as the authored
    // path — model z → three.js y (buildVoxelMesh swap), so shift +(-minZ) on y.
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    let minY = Infinity;
    for (const a of atoms) {
      minX = Math.min(minX, a.cx - a.sx / 2); maxX = Math.max(maxX, a.cx + a.sx / 2);
      minY = Math.min(minY, a.cy - a.sy / 2); maxY = Math.max(maxY, a.cy + a.sy / 2);
      minZ = Math.min(minZ, a.cz - a.sz / 2); maxZ = Math.max(maxZ, a.cz + a.sz / 2);
    }
    const mats = new Map<number, MaterialDef>();
    for (const a of atoms) {
      const m = this.content.getMaterialSync(a.materialId);
      if (m) mats.set(a.materialId, m);
    }
    const anchorOffset = { x: 0, y: -minZ, z: 0 };
    attachAtomsToSlot(mesh, slotId, modelId, atoms, mats, false, anchorOffset);

    if (slotId === "main_hand") {
      mesh.bladeDimensions = {
        length: (maxZ - minZ),
        halfCross: Math.max(maxX - minX, maxY - minY) / 2,
      };
    }

    const swingable = (prefab?.components?.["swingable"] as
      | { chain?: { light: string; heavy: string }[] }
      | undefined);
    const primaryAction = swingable?.chain?.[0]?.light
      ? this.weaponActions.get(swingable.chain[0].light)
      : undefined;
    const slotHoldBone = holdBoneId
      ?? primaryAction?.holdHand
      ?? (slotId === "off_hand" ? "hand_l" : "hand_r");
    const newSlot = mesh.attachments.get(slotId);
    if (newSlot) {
      newSlot.builtItemId = itemId;
      newSlot.restBoneId = slotHoldBone;
      if (primaryAction?.blade) {
        newSlot.bladeAttach = {
          base: [primaryAction.blade.baseLocal[0], primaryAction.blade.baseLocal[1], primaryAction.blade.baseLocal[2]],
          tip:  [primaryAction.blade.tipLocal[0],  primaryAction.blade.tipLocal[1],  primaryAction.blade.tipLocal[2]],
          holdBone: slotHoldBone,
        };
      }
    }
  }

  /**
   * T-346 — bake a hand slot from a `bow_grammar` generator's seed-unique
   * atoms (a procedural bow/crossbow) instead of the empty-nodes anchor
   * model. Structurally identical to `bakeGeneratedBlade` (same seed
   * derivation, same minZ-anchor convention, same bladeDimensions/
   * bladeAttach bookkeeping every main-hand item gets) — kept as a separate
   * method rather than generalized because the two grammars' anchor
   * semantics only coincide by construction; `armor_grammar`'s
   * `syncArmorSlot` is the precedent for one dedicated bake method per
   * grammar rather than a shared abstraction. Unlike blade, there is no
   * server-side geometry to keep in sync — a bow is purely visual (see
   * `bow_grammar.ts`'s file doc), so this is the ONLY consumer of the seed.
   */
  private bakeGeneratedBow(
    mesh: EntityMeshGroup,
    slotId: "main_hand" | "off_hand",
    modelId: string,
    itemId: string,
    bowGrammarId: string,
    prefab: Prefab | null,
    weaponScale: number,
    holdBoneId: string | null,
  ): void {
    if (!this.content) return;
    const procModel = this.content.getProcModelSync(bowGrammarId);
    const currentSlot = mesh.attachments.get(slotId);
    if (!procModel || !mesh.boneGroups || currentSlot?.modelId !== modelId) return;

    const seed = hash32(itemId);
    const rawAtoms = bowGrammarAtoms(seed, procModel.params as BowGrammarParams, (name) => {
      const m = this.content!.getMaterialByName(name);
      if (!m) throw new Error(`[bow_grammar] procModel "${bowGrammarId}" uses unknown material "${name}"`);
      return m.id;
    });
    // Scale generator atoms (authored in world units) by the weapon's modelScale.
    const atoms = rawAtoms.map((a) => ({
      ...a,
      cx: a.cx * weaponScale, cy: a.cy * weaponScale, cz: a.cz * weaponScale,
      sx: a.sx * weaponScale, sy: a.sy * weaponScale, sz: a.sz * weaponScale,
    }));

    // AABB in model space (limb axis = model z, per bow_grammar). Anchor the
    // model's lowest z at the hand bone, same convention bakeGeneratedBlade
    // uses (and the authored path used before it, via the generic
    // loadSlotModel AABB anchor below) — model z -> three.js y (buildVoxelMesh
    // swap), so shift +(-minZ) on y.
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    let minY = Infinity;
    for (const a of atoms) {
      minX = Math.min(minX, a.cx - a.sx / 2); maxX = Math.max(maxX, a.cx + a.sx / 2);
      minY = Math.min(minY, a.cy - a.sy / 2); maxY = Math.max(maxY, a.cy + a.sy / 2);
      minZ = Math.min(minZ, a.cz - a.sz / 2); maxZ = Math.max(maxZ, a.cz + a.sz / 2);
    }
    const mats = new Map<number, MaterialDef>();
    for (const a of atoms) {
      const m = this.content.getMaterialSync(a.materialId);
      if (m) mats.set(a.materialId, m);
    }
    const anchorOffset = { x: 0, y: -minZ, z: 0 };
    attachAtomsToSlot(mesh, slotId, modelId, atoms, mats, false, anchorOffset);

    if (slotId === "main_hand") {
      mesh.bladeDimensions = {
        length: (maxZ - minZ),
        halfCross: Math.max(maxX - minX, maxY - minY) / 2,
      };
    }

    const swingable = (prefab?.components?.["swingable"] as
      | { chain?: { light: string; heavy: string }[] }
      | undefined);
    const primaryAction = swingable?.chain?.[0]?.light
      ? this.weaponActions.get(swingable.chain[0].light)
      : undefined;
    const slotHoldBone = holdBoneId
      ?? primaryAction?.holdHand
      ?? (slotId === "off_hand" ? "hand_l" : "hand_r");
    const newSlot = mesh.attachments.get(slotId);
    if (newSlot) {
      newSlot.builtItemId = itemId;
      newSlot.restBoneId = slotHoldBone;
      if (primaryAction?.blade) {
        newSlot.bladeAttach = {
          base: [primaryAction.blade.baseLocal[0], primaryAction.blade.baseLocal[1], primaryAction.blade.baseLocal[2]],
          tip:  [primaryAction.blade.tipLocal[0],  primaryAction.blade.tipLocal[1],  primaryAction.blade.tipLocal[2]],
          holdBone: slotHoldBone,
        };
      }
    }
  }

  /**
   * Sync a single bone-parented armor slot.
   *
   * The anchor is parented to the bone group and positioned at the sub-object
   * transform recorded in mesh.boneSlotTransforms so the armor voxels overlay
   * the body-part voxels exactly.  polygonOffset (onTop=true) prevents z-fighting.
   */
  private syncArmorSlot(
    mesh: EntityMeshGroup,
    renderSlotId: string,
    boneId: string,
    modelId: string | null,
    itemId: string | null,
    prefab: Prefab | null,
    entityScale: { x: number; y: number; z: number },
  ): void {
    // T-306: an armor_grammar piece shares one anchor modelId across every
    // instance — key the generated case on the item entity id too, same as
    // the generated-blade hand slot.
    const armorGrammarId = (prefab?.components?.["armor"] as { armorGrammar?: string } | undefined)?.armorGrammar ?? null;
    const existing = mesh.attachments.get(renderSlotId);
    const unchanged = modelId === (existing?.modelId ?? null) &&
      (!armorGrammarId || itemId === (existing?.builtItemId ?? null));
    if (unchanged) return;

    detachModelFromSlot(mesh, renderSlotId);
    if (existing) existing.builtItemId = null;
    if (!modelId) return;

    const boneGroup = mesh.boneGroups!.get(boneId);
    if (!boneGroup) return; // bone not present on this skeleton

    // Look up the sub-object transform for this bone so the armor aligns with it.
    const subInfo = mesh.boneSlotTransforms.get(boneId);
    const pendingSlot = ensureBoneAttachment(
      mesh, renderSlotId, boneGroup,
      subInfo?.x ?? 0, subInfo?.y ?? 0, subInfo?.z ?? 0,
      entityScale,
      subInfo?.scale ?? 1,
    );
    pendingSlot.modelId = modelId;  // reserve

    // T-306: a generated armor plate bakes from armor_grammar's seed-unique
    // bone-LOCAL atoms (armorGrammarByBone), attached under the SAME bone-
    // parented anchor authored armor uses — so a generated plate poses with
    // the limb for free (the per-bone Group mechanism T-302 established).
    if (armorGrammarId && itemId) {
      this.bakeGeneratedArmor(mesh, renderSlotId, boneId, modelId, itemId, armorGrammarId, entityScale);
      return;
    }

    this.loadSlotModel(mesh, renderSlotId, modelId, (def, mats) => {
      // Armor voxels bake synchronously through the bakeVoxels kitchen (T-281),
      // one merged mesh per material at the slot's armor scale.
      attachArmorToSlot(mesh, renderSlotId, def, mats, entityScale);
    });
  }

  /**
   * T-306 — bake a bone-parented armor slot from an `armor_grammar` generator's
   * seed-unique bone-LOCAL atoms (a procedural plate) instead of an authored
   * model. Synchronous (a plate is a handful of voxels): resolve the procModel,
   * run `armorGrammarByBone` with `seed = hash32(itemEntityId)` for the ONE
   * bone this render slot covers, and attach through the atom bake path under
   * the bone's anchor (already positioned/parented by ensureBoneAttachment).
   */
  private bakeGeneratedArmor(
    mesh: EntityMeshGroup,
    renderSlotId: string,
    boneId: string,
    modelId: string,
    itemId: string,
    armorGrammarId: string,
    entityScale: { x: number; y: number; z: number },
  ): void {
    if (!this.content) return;
    const procModel = this.content.getProcModelSync(armorGrammarId);
    const skeleton = mesh.skeletonId ? this.content.getSkeletonSync(mesh.skeletonId) : undefined;
    const currentSlot = mesh.attachments.get(renderSlotId);
    if (!procModel || !skeleton || currentSlot?.modelId !== modelId) return;

    const seed = hash32(itemId);
    // armorGrammarByBone builds every plate the params declare; take only the
    // one bone this render slot covers (armor pieces map one equipment slot to
    // several bone render slots — legs → 4 bones — each its own plate).
    const byBone = armorGrammarByBone(seed, skeleton, procModel.params as ArmorGrammarParams, (name) => {
      const m = this.content!.getMaterialByName(name);
      if (!m) throw new Error(`[armor_grammar] procModel "${armorGrammarId}" uses unknown material "${name}"`);
      return m.id;
    });
    const atoms = byBone.get(boneId);
    if (!atoms || atoms.length === 0) { if (currentSlot) currentSlot.modelId = null; return; }

    const mats = new Map<number, MaterialDef>();
    for (const a of atoms) {
      const m = this.content.getMaterialSync(a.materialId);
      if (m) mats.set(a.materialId, m);
    }
    // Scale bone-local atoms to the slot's armor scale (entityScale × the slot's
    // stored armorSubScale), matching attachArmorToSlot — armorGrammarByBone
    // emits in bone-local model units (the recipe convention).
    const armorScale = armorSlotScale(mesh, renderSlotId, entityScale) ?? entityScale;
    const scaled = atoms.map((a) => ({
      ...a,
      cx: a.cx * armorScale.x, cy: a.cy * armorScale.y, cz: a.cz * armorScale.z,
      sx: a.sx * armorScale.x, sy: a.sy * armorScale.y, sz: a.sz * armorScale.z,
    }));
    attachAtomsToSlot(mesh, renderSlotId, modelId, scaled, mats, true);
    const newSlot = mesh.attachments.get(renderSlotId);
    if (newSlot) newSlot.builtItemId = itemId;
  }

  /**
   * Shared async slot-model load (T-282) — the one place the slot stale-guard
   * lives. Prefetch the model, then re-check the slot STILL wants `modelId` both
   * before and after the await (the entity may be re-equipped or its skeleton
   * torn down mid-fetch); load the model def + its materials; hand to `attach`.
   * Any stale/missing condition clears the slot's `modelId` reservation. Callers
   * (syncHandSlot / syncArmorSlot) reserve `slot.modelId` first and supply their
   * own attach step — the only part that differs between an entity-root weapon
   * and a bone-parented armour piece.
   */
  private loadSlotModel(
    mesh: EntityMeshGroup,
    slot: string,
    modelId: string,
    attach: (def: ModelDefinition, mats: Map<number, MaterialDef>) => void,
  ): void {
    this.content!.prefetchModel(modelId).then(() => {
      const currentSlot = mesh.attachments.get(slot);
      if (currentSlot?.modelId !== modelId || !mesh.boneGroups) return;
      const def = this.content!.getModelSync(modelId);
      if (!def) { if (currentSlot) currentSlot.modelId = null; return; }

      const mats = new Map<number, MaterialDef>();
      for (const id of def.materials) {
        const m = this.content!.getMaterialSync(id);
        if (m) mats.set(id, m);
      }

      // Re-check the slot still wants this model after the async model prefetch.
      if (mesh.attachments.get(slot)?.modelId !== modelId || !mesh.boneGroups) return;
      attach(def, mats);
    }).catch(() => {
      const currentSlot = mesh.attachments.get(slot);
      if (currentSlot?.modelId === modelId) currentSlot.modelId = null;
    });
  }

  /**
   * Position each entity's attachment slot anchors for the current frame.
   * Owned by the registry (entity-domain attachment math) but called from the
   * render loop after the pose is evaluated.
   *
   * "main_hand" — during an attack the anchor is placed at the hilt position
   * derived from the swing-path keyframes (same data the server uses for hit
   * detection).  At all other times it follows the hand_r bone so the weapon
   * sits naturally in the hand during locomotion.
   *
   * Future entity-root slots simply follow their `restBoneId` (T-223,
   * resolved from the scene graph in `syncHandSlot`/`bakeGeneratedBlade`) —
   * no per-slotId table to extend.
   */
  updateAttachmentPositions(
    mesh: EntityMeshGroup,
    anim: AnimationStateData | null,
    weaponAction: WeaponActionDef | undefined,
    t: number,
  ): void {
    if (!mesh.attachments.size) return;

    // Compute entity world matrix once before the loop (needed for world→local).
    mesh.group.updateWorldMatrix(true, true);
    const _entityWorldQuat = new THREE.Quaternion();
    mesh.group.getWorldQuaternion(_entityWorldQuat);
    const _entityWorldQuatInv = _entityWorldQuat.clone().invert();

    for (const [slotId, slot] of mesh.attachments) {
      // Bone-parented slots inherit their bone's transform automatically through
      // the Three.js scene hierarchy — no per-frame work needed.
      if (slot.boneParented) continue;

      // Hand slots: blade-anchored attachment when the equipped item has
      // swingable blade data on the slot; otherwise generic rest-bone
      // follow (for shields, lanterns, anything without a blade).
      const isHandSlot = slotId === "main_hand" || slotId === "off_hand";
      if (isHandSlot && slot.bladeAttach) {
        // Active-swing weapon action wins for the main hand (the only hand
        // that swings today); otherwise use the cached rest blade-attach.
        const swingBlade = slotId === "main_hand" ? weaponAction?.blade : undefined;
        const swingHoldBone = swingBlade
          ? (weaponAction?.holdHand ?? slot.bladeAttach.holdBone)
          : slot.bladeAttach.holdBone;
        const bwSwing = swingBlade ? evaluateBladeWorld(mesh, swingBlade, swingHoldBone) : null;
        const useSwing = !!(slotId === "main_hand" && anim?.weaponActionId && bwSwing);

        let bw = useSwing ? bwSwing : null;
        if (!bw) {
          bw = evaluateBladeWorld(
            mesh,
            { baseLocal: slot.bladeAttach.base, tipLocal: slot.bladeAttach.tip, radius: 0 },
            slot.bladeAttach.holdBone,
          );
        }

        if (bw) {
          mesh.group.worldToLocal(_attachTmp.copy(bw.base));
          slot.anchor.position.copy(_attachTmp);
          mesh.group.worldToLocal(_bladeTip.copy(bw.tip));
          _attachTmp.subVectors(_bladeTip, slot.anchor.position).normalize();
          slot.anchor.quaternion.setFromUnitVectors(_bladeUp, _attachTmp);
        }
      } else {
        // Generic rest-bone follow — copies both position AND rotation so
        // held items (a shield in the off-hand, a torch in some other
        // slot) animate naturally with the limb. Used for any slot
        // without bladeAttach. restBoneId is resolved from the scene graph
        // (T-223), not a per-slotId table.
        const restBoneId = slot.restBoneId;
        if (restBoneId) {
          const bone = mesh.boneGroups?.get(restBoneId);
          if (bone) {
            bone.getWorldPosition(_attachTmp);
            mesh.group.worldToLocal(_attachTmp);
            slot.anchor.position.copy(_attachTmp);
            bone.getWorldQuaternion(_attachQuat);
            _attachQuat.premultiply(_entityWorldQuatInv);
            slot.anchor.quaternion.copy(_attachQuat);
          }
        }
      }
    }
  }
}

