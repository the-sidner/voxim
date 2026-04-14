/// <reference lib="dom" />
/**
 * Entity hover + click interaction system.
 *
 * Each entity gets an invisible pick cylinder on THREE.js layer PICK_LAYER.
 * The camera only renders layer 0 (default), so pick cylinders are never visible.
 * A raycaster targeting PICK_LAYER finds the entity under the cursor each frame.
 *
 * Hover state: tracked per-frame; handlers receive onHoverStart/onHoverEnd callbacks.
 *
 * Click dispatch: registered EntityInteractionHandlers are sorted by priority.
 * The highest-priority handler whose canHandle() returns true fires onClick().
 * If onClick() returns true the click is consumed (caller suppresses attack input).
 *
 * Usage (game.ts):
 *   const is = new InteractionSystem(renderer, world);
 *   is.register(new WorkbenchHandler(...));
 *   input.onLmbClick = (x, y) => is.handleClick(x, y, playerWorldPos);
 *   // in render loop:
 *   is.update(mouseCanvasX, mouseCanvasY);
 */
import * as THREE from "three";
import type { VoximRenderer } from "../render/renderer.ts";
import type { ClientWorld } from "../state/client_world.ts";
import type { EntityInteractionHandler, InteractionTarget } from "./types.ts";

/** Three.js layer reserved for invisible pick cylinders. */
export const PICK_LAYER = 3;

/** Default pick cylinder half-height and radius (world units). */
const DEFAULT_PICK_H  = 2.0;
const DEFAULT_PICK_R  = 0.6;

/** Shared geometry for pick cylinders — one instance, never disposed. */
const PICK_GEO = new THREE.CylinderGeometry(DEFAULT_PICK_R, DEFAULT_PICK_R, DEFAULT_PICK_H, 8);
/** Shared invisible material — one instance, never disposed. */
const PICK_MAT = new THREE.MeshBasicMaterial({ visible: false });

export class InteractionSystem {
  private readonly handlers: EntityInteractionHandler[] = [];
  /** entityId → pick cylinder mesh (child of entity group). */
  private readonly pickMeshes = new Map<string, THREE.Mesh>();
  /** Scratch raycaster — reused each frame. */
  private readonly raycaster = new THREE.Raycaster();

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

    const pm = new THREE.Mesh(PICK_GEO, PICK_MAT);
    pm.layers.disableAll();
    pm.layers.enable(PICK_LAYER);
    pm.position.y = DEFAULT_PICK_H / 2;  // cylinder origin is at center; lift to ground level
    pm.userData.entityId = entityId;
    meshGroup.group.add(pm);
    this.pickMeshes.set(entityId, pm);
  }

  removeEntity(entityId: string): void {
    const pm = this.pickMeshes.get(entityId);
    if (!pm) return;
    pm.removeFromParent();
    // Geometry and material are shared — never dispose them here
    this.pickMeshes.delete(entityId);

    if (this.hoveredEntityId === entityId) {
      this.hoveredEntityId = null;
      // No need to reset outline mat — entity is gone
    }
  }

  // ---- per-frame update ----

  /**
   * Call once per render frame with the current canvas-relative mouse position.
   * Updates hover state and outline materials.
   */
  update(mouseCanvasX: number, mouseCanvasY: number): void {
    const entityId = this._pickEntity(mouseCanvasX, mouseCanvasY);

    if (entityId === this.hoveredEntityId) return;

    // Un-hover previous
    if (this.hoveredEntityId !== null) {
      if (this.renderer.getEntityMesh(this.hoveredEntityId)) {
        const prevTarget = this._buildTarget(this.hoveredEntityId);
        if (prevTarget) {
          for (const h of this.handlers) {
            if (h.onHoverEnd && h.canHandle(prevTarget)) {
              h.onHoverEnd(prevTarget);
              break;
            }
          }
        }
      }
      this.hoveredEntityId = null;
      this.renderer.setHoveredEntity(null);
    }

    // Hover new
    if (entityId !== null) {
      if (this.renderer.getEntityMesh(entityId)) {
        this.hoveredEntityId = entityId;
        const target = this._buildTarget(entityId);
        // Only show the silhouette outline when at least one matching handler opts in.
        const wantsOutline = target !== null &&
          this.handlers.some((h) => h.showHoverOutline && h.canHandle(target));
        this.renderer.setHoveredEntity(wantsOutline ? entityId : null);
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
