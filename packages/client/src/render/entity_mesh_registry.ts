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
 * (boneGroups + weaponActions + SLOT_REST_BONE).
 *
 * The three async stale guards in `updateEntity` (and the per-slot re-checks in
 * the sync* helpers) are preserved verbatim — they defend against the entity
 * being removed, replaced, or pooled while a model prefetch is in flight.
 */
import * as THREE from "three";
import type { EntityState } from "../state/client_world.ts";
import type { ContentCache } from "../state/content_cache.ts";
import type {
  MaterialDef,
  ModelDefinition,
  ResolvedSubObject,
  WeaponActionDef,
  Prefab,
  AnimationStateData,
  SkeletonDef,
} from "@voxim/content";
import { resolveSubObjects, resolveMorphParams } from "@voxim/content";
import type { AabbHalfExtents, InteractionSystem } from "../interaction/interaction_system.ts";
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

/** Terrain chunk size in world units. Must match CHUNK_SIZE in @voxim/world.
 *  Mirrored from renderer.ts — the renderer's render-loop terrain cull keeps
 *  its own copy; this one keys static props into the pool's culling grid. */
const CHUNK_SIZE = 32;

/**
 * Squared speed below which a static prop is allowed to settle into the pool.
 * applySnapshot writes velocity = {0,0,0} for every entity regardless of
 * whether the server treats it as a real Velocity component, so the transition
 * tests magnitude (not presence) to avoid deferring all props forever.
 */
const VELOCITY_EPSILON_SQ = 0.01;

// Reusable scratch vectors for per-frame attachment placement (no per-call alloc).
const _attachTmp   = new THREE.Vector3();
const _bladeTip    = new THREE.Vector3();
const _bladeUp     = new THREE.Vector3(0, 1, 0);  // world-up used as orientation hint
const _attachQuat  = new THREE.Quaternion();

/**
 * Entity-root slots that follow a rest bone each frame (position + rotation).
 * "main_hand" is handled separately (swing-path during attacks).
 * Armor slots are bone-parented (see ARMOR_SLOTS) and need no entry here.
 */
const SLOT_REST_BONE: Record<string, string> = {
  main_hand: "hand_r",
  off_hand:  "hand_l",
};

/**
 * Armor slots: maps equipment slot name → one or more render slots, each
 * attached to a specific bone.  Leg and foot items attach to both sides.
 */
const ARMOR_SLOTS: Record<string, Array<{ renderSlotId: string; boneId: string }>> = {
  head:  [{ renderSlotId: "head",          boneId: "head" }],
  chest: [{ renderSlotId: "chest",         boneId: "torso_upper" }],
  back:  [{ renderSlotId: "back",          boneId: "torso_upper" }],
  legs:  [
    { renderSlotId: "legs_upper_l", boneId: "upper_leg_l" },
    { renderSlotId: "legs_upper_r", boneId: "upper_leg_r" },
    { renderSlotId: "legs_lower_l", boneId: "lower_leg_l" },
    { renderSlotId: "legs_lower_r", boneId: "lower_leg_r" },
  ],
  feet:  [
    { renderSlotId: "feet_l",       boneId: "foot_l" },
    { renderSlotId: "feet_r",       boneId: "foot_r" },
  ],
};

export class EntityMeshRegistry {
  private readonly meshes        = new Map<string, EntityMeshGroup>();
  private readonly propPositions = new Map<string, THREE.Vector3>();

  // Mutable deps set after construction by the renderer's setter delegations.
  private content: ContentCache | null = null;
  private localPlayerId: string | null = null;
  private interaction: InteractionSystem | null = null;
  private hover: HoverOutlineSink | null = null;

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
  setLocalPlayer(id: string | null): void { this.localPlayerId = id; }
  setInteraction(s: InteractionSystem | null): void { this.interaction = s; }
  setHover(s: HoverOutlineSink | null): void { this.hover = s; }

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
      this.interaction?.addEntity(entityId);
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
          const morphParams = resolveMorphParams(skeleton, modelRef.seed ?? 0);
          // Build the skeleton's per-sub-object meshes — one merged mesh per
          // material through the bakeVoxels kitchen (T-281). A character is tens
          // of voxels, so the bake is sub-millisecond on the main thread; the
          // off-thread pool + collector/cursor coupling it replaced is gone.
          upgradeToSkeletonModel(capture, def, skeleton, resolvedSubs, subModelDefs, mats, scale, morphParams);
          // Re-attach hover outline + resize the pick box to fit the freshly
          // built meshes — both attach via the entity's group, which now
          // holds real geometry instead of the placeholder.
          this.hover?.notifyEntityRebuilt(entityId);
          this.interaction?.refreshEntityShape(entityId);
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

          // Sync all equipment slots now that boneGroups exist.
          this.syncEquipment(capture, state);
        } else {
          // Static prop — hand off to instanced pool, discard the placeholder Group.
          // InstancePool bakes the entity's position into an instance matrix
          // once and never updates it; the pick box is sized once at this point
          // too.  So we MUST defer the transition until the entity has actually
          // settled — ejected ground items have non-zero velocity while flying,
          // and freezing them mid-arc strands the visual + pick box at random
          // air positions.
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
          const halfExtents = computePropHalfExtents(def, resolvedSubs, subModelDefs, scale);
          this.interaction?.addStaticEntity(entityId, worldPos, this.scene, halfExtents);
        }
      }).catch(() => {});
    }

    // React to equipment changes on already-upgraded skeleton entities.
    // syncEquipment exits early per-slot when the model ID hasn't changed.
    if (mesh.boneGroups && state.equipment !== undefined) {
      this.syncEquipment(mesh, state);
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
          const geometry = buildSubModelGeo(def.nodes, matId, scale);
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
    canopyFade.register(mat, { voxelMode: true });
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
      this.interaction?.removeEntity(entityId);
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
  private syncEquipment(mesh: EntityMeshGroup, state: EntityState): void {
    if (!mesh.boneGroups || !this.content) return;

    const eq = state.equipment;
    const entityScale = state.modelRef
      ? { x: state.modelRef.scaleX, y: state.modelRef.scaleY, z: state.modelRef.scaleZ }
      : { x: 0.35, y: 0.35, z: 0.35 };

    // ── Weapon (main_hand): entity-root anchor, repositioned per-frame ──────
    this.syncHandSlot(mesh, "main_hand", eq?.weapon?.prefabId ?? null, entityScale);

    // ── Off-hand: entity-root anchor, follows hand_l bone per-frame ──────────
    this.syncHandSlot(mesh, "off_hand", eq?.offHand?.prefabId ?? null, entityScale);

    // ── Armor: bone-parented anchors at the sub-object transform ─────────────
    for (const [equipSlot, renderSlots] of Object.entries(ARMOR_SLOTS)) {
      const prefabId = (eq as Record<string, { prefabId: string } | null> | undefined)?.[equipSlot]?.prefabId ?? null;
      const prefab   = prefabId ? this.itemPrefabs.get(prefabId) : null;
      const modelId  = prefab?.modelId ?? null;
      for (const { renderSlotId, boneId } of renderSlots) {
        this.syncArmorSlot(mesh, renderSlotId, boneId, modelId, entityScale);
      }
    }
  }

  /**
   * Sync a single entity-root attachment slot (weapon or off-hand).
   * The anchor is positioned per-frame by updateAttachmentPositions.
   */
  private syncHandSlot(
    mesh: EntityMeshGroup,
    slotId: string,
    prefabId: string | null,
    _entityScale: { x: number; y: number; z: number },
  ): void {
    const prefab  = prefabId ? this.itemPrefabs.get(prefabId) : null;
    const modelId = prefab?.modelId ?? null;

    const existing = mesh.attachments.get(slotId);
    if (modelId === (existing?.modelId ?? null)) return;

    detachModelFromSlot(mesh, slotId);
    if (slotId === "main_hand") mesh.bladeDimensions = null;
    const existingSlot = mesh.attachments.get(slotId);
    if (existingSlot) existingSlot.bladeAttach = null;
    if (!modelId) return;

    const pendingSlot = ensureAttachment(mesh, slotId);
    pendingSlot.modelId = modelId;   // reserve to prevent races

    // Held weapons size themselves in absolute world units via the prefab's
    // own `modelScale` — independent of the holder's body scale. Using the
    // entity's scale here made a sword inherit the player's 2.4× scale and
    // come out 6× the size of the character (24 voxels × 2.4). The voxel
    // anchor is parented to the bone and the bone is already positioned in
    // world units by the body's entity scale, so the weapon doesn't need a
    // second multiplication.
    const weaponScale = prefab?.modelScale ?? 1.0;
    const voxelScale = { x: weaponScale, y: weaponScale, z: weaponScale };

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
      const slotHoldBone = SLOT_REST_BONE[slotId]
        ?? primaryAction?.holdHand
        ?? "hand_r";
      const newSlot = mesh.attachments.get(slotId);
      if (newSlot && primaryAction?.blade) {
        newSlot.bladeAttach = {
          base: [primaryAction.blade.baseLocal[0], primaryAction.blade.baseLocal[1], primaryAction.blade.baseLocal[2]],
          tip:  [primaryAction.blade.tipLocal[0],  primaryAction.blade.tipLocal[1],  primaryAction.blade.tipLocal[2]],
          holdBone: slotHoldBone,
        };
      }
    });
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
    entityScale: { x: number; y: number; z: number },
  ): void {
    const existing = mesh.attachments.get(renderSlotId);
    if (modelId === (existing?.modelId ?? null)) return;

    detachModelFromSlot(mesh, renderSlotId);
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

    this.loadSlotModel(mesh, renderSlotId, modelId, (def, mats) => {
      // Armor voxels bake synchronously through the bakeVoxels kitchen (T-281),
      // one merged mesh per material at the slot's armor scale.
      attachArmorToSlot(mesh, renderSlotId, def, mats, entityScale);
    });
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
   * Future slots ("off_hand", "back", "belt", …) simply follow their
   * designated rest bone; add entries to SLOT_REST_BONE to enable them.
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
        // without bladeAttach.
        const restBoneId = SLOT_REST_BONE[slotId];
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

/**
 * Walk every voxel of a static prop's main model + sub-objects in three.js
 * coordinates and return its AABB as half-extents + centre for the
 * InteractionSystem pick box.  Sub-objects are honoured so trees with
 * branches and props with offset attachments get the correct footprint
 * (the cached getModelAabb only covers main-model nodes).
 *
 * model(x, y, z) → three(x*sx, z*sz, y*sy) — same convention as
 * voxel_bake.bakeSubModel().
 */
function computePropHalfExtents(
  def: ModelDefinition,
  resolvedSubs: ResolvedSubObject[],
  subModelDefs: Map<string, ModelDefinition>,
  scale: { x: number; y: number; z: number },
): AabbHalfExtents {
  let minX =  Infinity, minY =  Infinity, minZ =  Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

  // Voxel n occupies [n, n+1) on each axis.  Three.js corners after scale.
  const accumulate = (
    nodes: ModelDefinition["nodes"],
    sx: number, sy: number, sz: number,
    ox = 0, oy = 0, oz = 0,
  ): void => {
    for (const n of nodes) {
      // model(x,y,z) → three(x*sx, z*sz, y*sy)
      const aX =  n.x      * sx + ox;
      const bX = (n.x + 1) * sx + ox;
      const aY =  n.z      * sz + oy;
      const bY = (n.z + 1) * sz + oy;
      const aZ =  n.y      * sy + oz;
      const bZ = (n.y + 1) * sy + oz;
      if (aX < minX) minX = aX; if (bX > maxX) maxX = bX;
      if (aY < minY) minY = aY; if (bY > maxY) maxY = bY;
      if (aZ < minZ) minZ = aZ; if (bZ > maxZ) maxZ = bZ;
    }
  };

  accumulate(def.nodes, scale.x, scale.y, scale.z);
  for (const sub of resolvedSubs) {
    const subDef = subModelDefs.get(sub.modelId);
    if (!subDef) continue;
    const t = sub.transform;
    const sx = scale.x * t.scaleX;
    const sy = scale.y * t.scaleY;
    const sz = scale.z * t.scaleZ;
    // Sub-object position uses the same model→three mapping; rotations are
    // ignored here (small rotated parts barely shift the AABB and fixing
    // it correctly would mean transforming each voxel through a 4×4 — not
    // worth the cost for a click target).
    const ox = t.x * scale.x;
    const oy = t.z * scale.z;
    const oz = t.y * scale.y;
    accumulate(subDef.nodes, sx, sy, sz, ox, oy, oz);
  }

  if (!isFinite(minX)) {
    return { hx: 0.4, hy: 0.9, hz: 0.4, cx: 0, cy: 0.9, cz: 0 };
  }
  return {
    hx: (maxX - minX) / 2,
    hy: (maxY - minY) / 2,
    hz: (maxZ - minZ) / 2,
    cx: (maxX + minX) / 2,
    cy: (maxY + minY) / 2,
    cz: (maxZ + minZ) / 2,
  };
}
