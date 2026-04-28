/// <reference lib="dom" />
/**
 * Entity hover + click interaction system.
 *
 * Each entity gets an invisible per-instance pick BOX on THREE.js layer
 * PICK_LAYER.  The box is sized to the entity's actual visual AABB so a
 * small dropped item doesn't occlude a workstation behind it — uniform
 * cylinders previously made tight clusters un-pickable.  The camera only
 * renders layer 0 (default), so pick boxes are never visible.  A raycaster
 * targeting PICK_LAYER finds the entity under the cursor each frame.
 *
 * Box shape lifecycle:
 *   - addEntity(entityId): creates a unit box parented to the entity's
 *     group, then sizes it from the current mesh bounding box.
 *   - addStaticEntity(entityId, worldPos, scene, halfExtents): for prop-pool
 *     entities; the box is parented to the scene root with caller-supplied
 *     half-extents (the renderer derives them from the model AABB before
 *     handing the geometry to the prop pool).
 *   - refreshEntityShape(entityId): walks the live mesh group's bbox and
 *     resizes; called by the renderer after every mesh upgrade so the
 *     placeholder→model transition is reflected in pick accuracy.
 *
 * Hover state lives in the input system's `hoverState` signal — this system
 * publishes to it and fires handler onHoverStart/onHoverEnd callbacks. The
 * outline renderer subscribes to the same signal independently; the system
 * never touches outline state directly.
 *
 * Click dispatch: registered EntityInteractionHandlers are sorted by priority.
 * The highest-priority handler whose canHandle() returns true fires onClick().
 * If onClick() returns true the click is consumed (caller suppresses attack input).
 */
import * as THREE from "three";
import type { VoximRenderer } from "../render/renderer.ts";
import type { ClientWorld } from "../state/client_world.ts";
import type { EntityInteractionHandler, InteractionTarget } from "./types.ts";
import { hoverState } from "../input/context.ts";

/** Three.js layer reserved for invisible pick boxes. */
export const PICK_LAYER = 3;

/** Shared invisible material — one instance, never disposed. */
const PICK_MAT = new THREE.MeshBasicMaterial({ visible: false });
/** Shared unit box geometry — meshes scale this per-entity to fit their AABB. */
const PICK_GEO = new THREE.BoxGeometry(1, 1, 1);

/**
 * Floor for pick-box dimensions (world units). Tiny ground items would be
 * sub-pixel-impossible to click without this; keeps the box big enough to
 * grab while still small enough to not occlude bigger entities behind.
 */
const MIN_EXTENT = 0.35;

/** Half-extents used before a real bounding box is available. */
const PLACEHOLDER_EXTENTS: AabbHalfExtents = {
  hx: 0.4, hy: 0.9, hz: 0.4, cx: 0, cy: 0.9, cz: 0,
};

export interface AabbHalfExtents {
  hx: number; hy: number; hz: number;  // half-extents in three.js space
  cx: number; cy: number; cz: number;  // local centre relative to entity origin
}

export class InteractionSystem {
  private readonly handlers: EntityInteractionHandler[] = [];
  /** entityId → pick box mesh. */
  private readonly pickMeshes = new Map<string, THREE.Mesh>();
  /** Scratch raycaster — reused each frame. */
  private readonly raycaster = new THREE.Raycaster();
  /** Reused scratch — avoids per-pick Box3 allocations. */
  private readonly _bboxScratch = new THREE.Box3();

  private hoveredEntityId: string | null = null;

  constructor(
    private readonly renderer: VoximRenderer,
    private readonly world: ClientWorld,
  ) {
    this.raycaster.layers.disableAll();
    this.raycaster.layers.enable(PICK_LAYER);
  }

  // ---- handler registry ----

  register(handler: EntityInteractionHandler): void {
    this.handlers.push(handler);
    this.handlers.sort((a, b) => b.priority - a.priority);
  }

  unregister(id: string): void {
    const idx = this.handlers.findIndex((h) => h.id === id);
    if (idx !== -1) this.handlers.splice(idx, 1);
  }

  // ---- entity lifecycle (called by renderer) ----

  addEntity(entityId: string): void {
    const meshGroup = this.renderer.getEntityMesh(entityId);
    if (!meshGroup) return;

    const pm = this._createPickMesh(entityId);
    meshGroup.group.add(pm);
    this.pickMeshes.set(entityId, pm);
    // Size from the current mesh bbox (placeholder for now; refresh after upgrade).
    this.refreshEntityShape(entityId);
  }

  /**
   * Register a static prop's pick box (PropInstancePool entities).  The
   * caller supplies half-extents derived from the prop's model AABB so the
   * box matches the rendered geometry without needing to walk the pool.
   */
  addStaticEntity(
    entityId: string,
    worldPos: THREE.Vector3,
    scene: THREE.Scene,
    halfExtents: AabbHalfExtents,
  ): void {
    this.removeEntity(entityId);
    const pm = this._createPickMesh(entityId);
    pm.position.set(
      worldPos.x + halfExtents.cx,
      worldPos.y + halfExtents.cy,
      worldPos.z + halfExtents.cz,
    );
    pm.scale.set(halfExtents.hx * 2, halfExtents.hy * 2, halfExtents.hz * 2);
    scene.add(pm);
    this.pickMeshes.set(entityId, pm);
  }

  /**
   * Recompute the pick box from the entity's current mesh group bbox.
   * Called by the renderer after every mesh rebuild (placeholder → static
   * voxel, placeholder → skeletal upgrade).  No-op for prop-pool entities,
   * whose box is sized once at addStaticEntity time.
   */
  refreshEntityShape(entityId: string): void {
    const pm = this.pickMeshes.get(entityId);
    const meshGroup = this.renderer.getEntityMesh(entityId);
    if (!pm || !meshGroup) return;
    if (pm.parent !== meshGroup.group) return;  // prop-pool case

    const ext = this._computeLocalExtents(meshGroup.group, pm) ?? PLACEHOLDER_EXTENTS;
    pm.position.set(ext.cx, ext.cy, ext.cz);
    pm.scale.set(ext.hx * 2, ext.hy * 2, ext.hz * 2);
  }

  removeEntity(entityId: string): void {
    const pm = this.pickMeshes.get(entityId);
    if (!pm) return;
    pm.removeFromParent();
    this.pickMeshes.delete(entityId);

    if (this.hoveredEntityId === entityId) {
      this.hoveredEntityId = null;
      // Push the cleared hover to the signal so the outline renderer drops
      // its silhouette before the entity's geometry vanishes.  Without this,
      // hoverState would still point at the dead id until the next mouse
      // move, leaving an orphan shell on screen for one frame.
      hoverState.value = { kind: "none" };
    }
  }

  private _createPickMesh(entityId: string): THREE.Mesh {
    const pm = new THREE.Mesh(PICK_GEO, PICK_MAT);
    pm.layers.disableAll();
    pm.layers.enable(PICK_LAYER);
    pm.userData.entityId = entityId;
    return pm;
  }

  /**
   * Walk the entity group's child meshes (excluding the pick mesh itself)
   * and return half-extents + centre in group-local space.  Returns null
   * when the group has no meshes yet (placeholder still loading).
   */
  private _computeLocalExtents(
    group: THREE.Object3D,
    pickMesh: THREE.Mesh,
  ): AabbHalfExtents | null {
    const bbox = this._bboxScratch.makeEmpty();
    let any = false;
    group.traverse((obj) => {
      if (obj === pickMesh) return;
      if (!(obj instanceof THREE.Mesh)) return;
      if (obj.userData.entityId !== undefined) return;  // skip other pick meshes
      const geo = obj.geometry;
      if (!geo.boundingBox) geo.computeBoundingBox();
      if (!geo.boundingBox) return;
      // Express the child's geo bbox in group-local coordinates.  We need
      // localMatrix from the child up to (but not through) the group root.
      const m = new THREE.Matrix4();
      let cur: THREE.Object3D | null = obj;
      while (cur && cur !== group) {
        m.premultiply(cur.matrix);
        cur = cur.parent;
      }
      const childBox = geo.boundingBox.clone().applyMatrix4(m);
      bbox.union(childBox);
      any = true;
    });
    if (!any) return null;
    const sz = bbox.getSize(new THREE.Vector3());
    const ct = bbox.getCenter(new THREE.Vector3());
    return {
      hx: Math.max(MIN_EXTENT, sz.x / 2),
      hy: Math.max(MIN_EXTENT, sz.y / 2),
      hz: Math.max(MIN_EXTENT, sz.z / 2),
      cx: ct.x, cy: ct.y, cz: ct.z,
    };
  }

  // ---- per-frame update ----

  /**
   * Call once per render frame with the current canvas-relative mouse position.
   * Updates hover state and outline materials.
   */
  update(mouseCanvasX: number, mouseCanvasY: number): void {
    const entityId = this._pickEntity(mouseCanvasX, mouseCanvasY);

    if (entityId === this.hoveredEntityId) return;

    // Mirror the hover into the global signal so the IntentTranslator's
    // E-key handler reads the current target without polling. T-131 will
    // also publish terrain-cell hover here for build-mode preview.
    hoverState.value = entityId !== null
      ? { kind: "entity", entityId }
      : { kind: "none" };

    // Un-hover previous: fire onHoverEnd on the matching handler.
    if (this.hoveredEntityId !== null) {
      const prevTarget = this._buildTarget(this.hoveredEntityId);
      if (prevTarget) {
        for (const h of this.handlers) {
          if (h.onHoverEnd && h.canHandle(prevTarget)) {
            h.onHoverEnd(prevTarget);
            break;
          }
        }
      }
      this.hoveredEntityId = null;
    }

    // Hover new: fire onHoverStart on the matching handler.  Prop-pool
    // entities have no EntityMeshGroup but are still hoverable via their
    // pick cylinder, so we don't gate on getEntityMesh any more.
    if (entityId !== null) {
      this.hoveredEntityId = entityId;
      const target = this._buildTarget(entityId);
      if (target) {
        for (const h of this.handlers) {
          if (h.onHoverStart && h.canHandle(target)) {
            h.onHoverStart(target);
            break;
          }
        }
      }
    }
  }

  /**
   * Call on LMB mousedown.  Returns true if a handler consumed the click
   * (the caller should suppress the attack action in that case).
   *
   * @param playerWorldX  Local player world X — used for range check.
   * @param playerWorldY  Local player world Y — used for range check.
   */
  handleClick(
    mouseCanvasX: number,
    mouseCanvasY: number,
    playerWorldX: number,
    playerWorldY: number,
  ): boolean {
    const entityId = this._pickEntity(mouseCanvasX, mouseCanvasY);
    if (entityId === null) return false;

    const target = this._buildTarget(entityId);
    if (!target) return false;

    const dx = target.worldX - playerWorldX;
    const dy = target.worldY - playerWorldY;
    const dist = Math.sqrt(dx * dx + dy * dy);

    for (const h of this.handlers) {
      if (!h.canHandle(target)) continue;
      if (dist > h.interactionRange) continue;
      return h.onClick(target);
    }
    return false;
  }

  dispose(): void {
    for (const [eid] of this.pickMeshes) {
      this.removeEntity(eid);
    }
    this.handlers.length = 0;
  }

  // ---- internals ----

  private _pickEntity(mouseCanvasX: number, mouseCanvasY: number): string | null {
    const canvas = this.renderer.renderer.domElement;
    const w = canvas.clientWidth  || canvas.width;
    const h = canvas.clientHeight || canvas.height;
    if (!w || !h) return null;

    const ndc = new THREE.Vector2(
      (mouseCanvasX / w) * 2 - 1,
      -(mouseCanvasY / h) * 2 + 1,
    );
    this.raycaster.setFromCamera(ndc, this.renderer.camera);

    const pickList = [...this.pickMeshes.values()];
    const hits = this.raycaster.intersectObjects(pickList, false);
    if (!hits.length) return null;

    return (hits[0].object.userData.entityId as string) ?? null;
  }

  private _buildTarget(entityId: string): InteractionTarget | null {
    const state = this.world.get(entityId);
    if (!state) return null;

    const mesh = this.renderer.getEntityMesh(entityId);
    const screenPos = mesh ? this.renderer.getEntityScreenPos(entityId) : null;

    return {
      entityId,
      entityState: state,
      worldX: state.position?.x ?? 0,
      worldY: state.position?.y ?? 0,
      screenX: screenPos?.x ?? 0,
      screenY: screenPos?.y ?? 0,
    };
  }
}
