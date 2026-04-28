/**
 * HoverOutlineRenderer — single source of truth for what gets outlined.
 *
 * Subscribes to `hoverState` (the input system's hover signal) and produces
 * a silhouette mask that EdgePass dilates into a rim + interior wash.
 *
 * Two paths to put a silhouette into the mask:
 *
 *   Path A — Live EntityMeshGroup:
 *     The entity's own meshes are still in the scene (placeholder, static
 *     voxel model, or skeletal). Toggle HOVER_LAYER on every Mesh in its
 *     group; the renderer's mask pass picks them up via the layer filter.
 *     Skeletal entities follow their bone transforms automatically.
 *
 *   Path B — Static prop (PropInstancePool):
 *     The entity's geometry was handed off to instanced rendering and its
 *     EntityMeshGroup was disposed.  PropInstancePool.buildHoverShells()
 *     hands us per-slot Mesh wrappers sharing the pool's geometry; we add
 *     them to the scene on HOVER_LAYER only and drop them on hover-change.
 *
 * What gets outlined is decided by `outlineCategoryFor(state)` — a tiny
 * pure function over the entity's components. NPCs and players are not in
 * the table today, so they don't outline; one entry flips that on.
 *
 * The renderer never tracks hover state itself. It exposes a few accessors
 * (entity mesh, prop position, prop pool, edge pass) and the rest lives
 * here.
 */
import * as THREE from "three";
import { effect } from "@preact/signals";
import { hoverState } from "../input/context.ts";
import type { ClientWorld } from "../state/client_world.ts";
import type { EntityState } from "../state/client_world.ts";
import { HOVER_LAYER, type VoximRenderer, type HoverOutlineSink } from "./renderer.ts";

interface OutlineCategory {
  /** Tint used by EdgePass for both the rim and the interior wash. */
  tint: THREE.ColorRepresentation;
}

/**
 * Decide whether (and in what colour) to outline an entity. Returning null
 * suppresses the outline entirely. Add an entry per category to opt new
 * entity kinds in — keeping NPCs/players out is intentional for now.
 */
function outlineCategoryFor(state: EntityState | null): OutlineCategory | null {
  if (!state) return null;
  if (state.workstationBuffer)    return { tint: 0xffc060 };  // amber
  if (state.raw.has("resource_node")) return { tint: 0xffe080 };  // warm yellow
  if (state.itemData)             return { tint: 0x80e0ff };  // cyan
  return null;
}

export class HoverOutlineRenderer implements HoverOutlineSink {
  /** Live shells parented to the scene for the prop-pool case. Empty otherwise. */
  private propShells: THREE.Mesh[] = [];
  /** Entity whose EntityMeshGroup currently has HOVER_LAYER toggled, or null. */
  private layerEntityId: string | null = null;
  /** Last entity we built outlines for — used by notifyEntityRebuilt. */
  private currentEntityId: string | null = null;
  private readonly disposeEffect: () => void;

  constructor(
    private readonly renderer: VoximRenderer,
    private readonly world: ClientWorld,
  ) {
    this.disposeEffect = effect(() => this._update());
    this.renderer.setHoverOutline(this);
  }

  /**
   * Called by VoximRenderer when an entity's meshes are rebuilt mid-hover
   * (placeholder → skeletal upgrade is the canonical case).  If we were
   * outlining that entity via Path A the freshly built meshes don't carry
   * the HOVER_LAYER — re-attach.
   */
  notifyEntityRebuilt(entityId: string): void {
    if (entityId !== this.currentEntityId) return;
    if (this.layerEntityId === entityId) {
      // Re-toggle on the new geometry; the previous reference was the disposed group.
      this.layerEntityId = null;
      this._enableLayerFor(entityId);
    }
  }

  dispose(): void {
    this.disposeEffect();
    this._teardown();
    this.renderer.setHoverOutline(null);
  }

  // ---- internals ----------------------------------------------------------

  private _update(): void {
    const hover = hoverState.value;
    const edge = this.renderer.getEdgePass();

    if (hover.kind !== "entity") {
      this._teardown();
      edge.setHoverActive(false);
      return;
    }

    const state = this.world.get(hover.entityId);
    const category = outlineCategoryFor(state ?? null);
    if (!category) {
      this._teardown();
      edge.setHoverActive(false);
      return;
    }

    // Same entity, same category — nothing to rebuild.
    if (this.currentEntityId === hover.entityId) {
      edge.setHoverColor(category.tint);
      edge.setHoverActive(true);
      return;
    }

    this._teardown();
    this.currentEntityId = hover.entityId;
    edge.setHoverColor(category.tint);

    // Path B first: prop-pool entities have no live EntityMeshGroup.
    const propPos = this.renderer.getPropPosition(hover.entityId);
    if (propPos !== null) {
      const shells = this.renderer.getPropPool().buildHoverShells(hover.entityId);
      for (const m of shells) {
        m.layers.disableAll();
        m.layers.enable(HOVER_LAYER);
        this.renderer.scene.add(m);
      }
      this.propShells = shells;
      edge.setHoverActive(shells.length > 0);
      return;
    }

    // Path A: live EntityMeshGroup. Skeletal and static voxel both end up here.
    if (this._enableLayerFor(hover.entityId)) {
      edge.setHoverActive(true);
    } else {
      // No mesh yet (still loading) — outline will re-attach via notifyEntityRebuilt.
      edge.setHoverActive(false);
    }
  }

  private _enableLayerFor(entityId: string): boolean {
    const mesh = this.renderer.getEntityMesh(entityId);
    if (!mesh) return false;
    mesh.group.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh)) return;
      // Skip pick cylinders (InteractionSystem tags them with entityId).
      if (obj.userData.entityId !== undefined) return;
      obj.layers.enable(HOVER_LAYER);
    });
    this.layerEntityId = entityId;
    return true;
  }

  private _disableLayerFor(entityId: string): void {
    const mesh = this.renderer.getEntityMesh(entityId);
    if (!mesh) return;
    mesh.group.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh)) return;
      if (obj.userData.entityId !== undefined) return;
      obj.layers.disable(HOVER_LAYER);
    });
  }

  private _teardown(): void {
    if (this.layerEntityId !== null) {
      this._disableLayerFor(this.layerEntityId);
      this.layerEntityId = null;
    }
    if (this.propShells.length > 0) {
      for (const m of this.propShells) {
        m.removeFromParent();
        // Geometry + material are pool-owned — never dispose them here.
      }
      this.propShells = [];
    }
    this.currentEntityId = null;
  }
}
