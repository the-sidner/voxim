/// <reference lib="dom" />
/**
 * DragSystem — singleton service that manages drag/drop across all panels.
 *
 * Panels register drop zones; the system handles the ghost element, cursor
 * state, and dispatches resolved drop actions back to game.ts via callbacks.
 *
 * Usage:
 *   // In a panel component — register a drop zone on mount:
 *   dragSystem.registerZone(el, { accept: ["inventory", "equipment"], onDrop });
 *
 *   // To start a drag (e.g. on mousedown in InventoryPanel):
 *   dragSystem.startDrag(item, "inventory", slotIndex, originElement);
 */
import { uiState } from "./ui_store.ts";
import type { DragState, DragSourceKind, ItemStack } from "./ui_store.ts";

// ── Drop zone ──────────────────────────────────────────────────────────────────

export interface DropZoneOptions {
  /** Which drag source kinds this zone accepts. */
  accept: DragSourceKind[];
  /**
   * Called when a compatible drag is released over this zone.
   * The handler should dispatch the appropriate server action (equip, move, etc.)
   * and then call dragSystem.endDrag().
   */
  onDrop: (drag: DragState, zoneId: string) => void;
  /** Optional: highlight the zone while a compatible item is being dragged over it. */
  onEnter?: (drag: DragState) => void;
  onLeave?: () => void;
}

interface RegisteredZone {
  el:     HTMLElement;
  zoneId: string;
  opts:   DropZoneOptions;
}

// ── Singleton ──────────────────────────────────────────────────────────────────

class DragSystem {
  private zones: RegisteredZone[] = [];
  private ghostEl: HTMLElement | null = null;
  private activeZone: RegisteredZone | null = null;
  /**
   * Called when a drag ends outside any valid drop zone.
   * Set by startDrag; cleared by endDrag.
   */
  private onDropOutside: (() => void) | null = null;

  // ── Zone registration ────────────────────────────────────────────────────────

  /**
   * Register a DOM element as a drop zone.  Call this in a component's
   * mount/useEffect and pair with unregisterZone on unmount.
   */
  registerZone(el: HTMLElement, zoneId: string, opts: DropZoneOptions): void {
    this.zones.push({ el, zoneId, opts });
    el.addEventListener("mouseenter", () => this.onZoneEnter(zoneId));
    el.addEventListener("mouseleave", () => this.onZoneLeave(zoneId));
  }

  unregisterZone(zoneId: string): void {
    this.zones = this.zones.filter((z) => z.zoneId !== zoneId);
    if (this.activeZone?.zoneId === zoneId) this.activeZone = null;
  }

  // ── Drag lifecycle ────────────────────────────────────────────────────────────

  /**
   * @param onDropOutside  Optional callback invoked when the drag ends without
   *                       landing on a valid drop zone (e.g. unequip by dragging
   *                       an item off the equipment panel).
   */
  startDrag(
    item: ItemStack,
    sourceKind: DragSourceKind,
    sourceIndex: number,
    originEl: HTMLElement,
    onDropOutside?: () => void,
  ): void {
    const drag: DragState = { item, sourceKind, sourceIndex };
    uiState.value = { ...uiState.value, drag };
    this.onDropOutside = onDropOutside ?? null;
    this._spawnGhost(item, originEl);
    document.addEventListener("mousemove", this._onMouseMove);
    document.addEventListener("mouseup",   this._onMouseUp);
  }

  endDrag(): void {
    uiState.value = { ...uiState.value, drag: null };
    this._removeGhost();
    this.activeZone?.opts.onLeave?.();
    this.activeZone = null;
    this.onDropOutside = null;
    document.removeEventListener("mousemove", this._onMouseMove);
    document.removeEventListener("mouseup",   this._onMouseUp);
  }

  // ── Internal ──────────────────────────────────────────────────────────────────

  private onZoneEnter(zoneId: string): void {
    const drag = uiState.value.drag;
    if (!drag) return;
    const zone = this.zones.find((z) => z.zoneId === zoneId);
    if (!zone || !zone.opts.accept.includes(drag.sourceKind)) return;
    this.activeZone = zone;
    zone.opts.onEnter?.(drag);
  }

  private onZoneLeave(zoneId: string): void {
    if (this.activeZone?.zoneId !== zoneId) return;
    this.activeZone.opts.onLeave?.();
    this.activeZone = null;
  }

  private readonly _onMouseMove = (e: MouseEvent): void => {
    if (!this.ghostEl) return;
    this.ghostEl.style.left = `${e.clientX + 12}px`;
    this.ghostEl.style.top  = `${e.clientY + 12}px`;
  };

  private readonly _onMouseUp = (): void => {
    const drag = uiState.value.drag;
    if (!drag) { this.endDrag(); return; }

    if (this.activeZone && this.activeZone.opts.accept.includes(drag.sourceKind)) {
      this.activeZone.opts.onDrop(drag, this.activeZone.zoneId);
      // onDrop is responsible for calling endDrag() after dispatching the action.
    } else {
      // Dropped outside any valid zone — fire the caller's onDropOutside handler
      // (e.g. unequip when dragging from equipment panel, drop-to-ground from inventory).
      const cb = this.onDropOutside;
      this.endDrag();   // clear onDropOutside before calling cb
      cb?.();
    }
  };

  private _spawnGhost(item: ItemStack, originEl: HTMLElement): void {
    const rect = originEl.getBoundingClientRect();
    const ghost = document.createElement("div");
    ghost.className = "drag-ghost";
    ghost.textContent = item.displayName;
    ghost.style.cssText = `
      position: fixed;
      left: ${rect.left}px;
      top: ${rect.top}px;
      pointer-events: none;
      z-index: 9999;
      opacity: 0.85;
      transform: scale(0.95);
    `;
    document.body.appendChild(ghost);
    this.ghostEl = ghost;
  }

  private _removeGhost(): void {
    this.ghostEl?.remove();
    this.ghostEl = null;
  }
}

export const dragSystem = new DragSystem();
