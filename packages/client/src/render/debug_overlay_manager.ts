/**
 * DebugOverlayManager — central registry for all client-side debug overlays.
 *
 * ## Adding a new overlay
 *
 *   1. Create a class that implements `ManagedOverlay` (in its own file).
 *   2. In `GameRenderer`'s constructor, instantiate it and call:
 *        `this.debugOverlayManager.register("myOverlay", instance)`
 *   3. Add "myOverlay" to `DebugLayer` in `debug_store.ts`.
 *   4. Wire a toggle row in `DebugPanel.tsx`.
 *   5. If the overlay needs event-driven calls (e.g. `trackEntity`, `addChunk`),
 *      keep a typed private reference to the instance in the renderer alongside
 *      its manager registration.
 *
 * ## Lifecycle
 *
 *   - `toggle(id)` — flip on/off; calls `onToggle(on)` so the overlay can
 *     hide its Three.js geometry when disabled.
 *   - `update(ctx)` — called every render frame; only routes to overlays that
 *     are currently on. Overlays must not check their own visibility.
 *   - `removeEntity(entityId)` — propagated to all overlays with `removeEntity`.
 *   - `dispose()` — disposes all registered overlays.
 */

import type { WeaponActionDef } from "@voxim/content";
import type { ContentCache } from "../state/content_cache.ts";
import type { EntityMeshGroup } from "./entity_mesh.ts";

// ── Public context passed to every overlay on each frame ─────────────────────

export interface DebugUpdateContext {
  entityMeshes: ReadonlyMap<string, EntityMeshGroup>;
  weaponActionsMap: ReadonlyMap<string, WeaponActionDef>;
  now: number;
  content: ContentCache | null;
}

// ── Overlay interface ─────────────────────────────────────────────────────────

/**
 * Interface every debug overlay must implement.
 *
 * `update(ctx)` is only called when the overlay is on — no internal
 * visibility guard needed inside the overlay.
 *
 * `onToggle(on)` is called whenever the overlay is toggled. Use it to
 * show/hide persistent Three.js geometry (e.g. hide all lines when off).
 *
 * `removeEntity(entityId)` is optional; implement it when the overlay keeps
 * per-entity Three.js objects that must be cleaned up when the entity leaves.
 */
export interface ManagedOverlay {
  update(ctx: DebugUpdateContext): void;
  onToggle?(on: boolean): void;
  removeEntity?(entityId: string): void;
  dispose(): void;
}

// ── Manager ───────────────────────────────────────────────────────────────────

interface RegistryEntry {
  overlay: ManagedOverlay;
  on: boolean;
}

export class DebugOverlayManager {
  private readonly registry = new Map<string, RegistryEntry>();

  /** Register a new overlay under a stable string id. */
  register(id: string, overlay: ManagedOverlay): void {
    this.registry.set(id, { overlay, on: false });
  }

  /**
   * Toggle an overlay on/off.  Returns the new state, or false if the id is
   * unknown (so game.ts can update the debug store signal).
   */
  toggle(id: string): boolean {
    const entry = this.registry.get(id);
    if (!entry) return false;
    entry.on = !entry.on;
    entry.overlay.onToggle?.(entry.on);
    return entry.on;
  }

  isOn(id: string): boolean {
    return this.registry.get(id)?.on ?? false;
  }

  /**
   * Retrieve a specific overlay by id with a type assertion.
   * Used for event-driven calls (e.g. chunkOverlay.addChunk, skeletonOverlay.trackEntity)
   * that cannot go through the generic update path.
   */
  get<T extends ManagedOverlay>(id: string): T {
    const entry = this.registry.get(id);
    if (!entry) throw new Error(`DebugOverlayManager: unknown overlay "${id}"`);
    return entry.overlay as T;
  }

  /** Call update on every overlay that is currently on. */
  update(ctx: DebugUpdateContext): void {
    for (const entry of this.registry.values()) {
      if (entry.on) entry.overlay.update(ctx);
    }
  }

  /** Propagate entity removal to all overlays that care about it. */
  removeEntity(entityId: string): void {
    for (const entry of this.registry.values()) {
      entry.overlay.removeEntity?.(entityId);
    }
  }

  /** Dispose all overlays and clear the registry. */
  dispose(): void {
    for (const entry of this.registry.values()) {
      entry.overlay.dispose();
    }
    this.registry.clear();
  }
}
