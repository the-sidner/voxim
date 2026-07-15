/// <reference lib="dom" />
/**
 * Nearest-interactable proximity system (T-320).
 *
 * There is no cursor under free-look pointer lock, so interaction is proximity,
 * not hover-click. Each frame the system scans the world for entities matching
 * a registered handler's `canHandle` within that handler's `interactionRange`,
 * picks the single nearest qualifying one (priority breaks ties at equal
 * distance), and publishes it to `hoverState` — the SAME signal the hover
 * outline renderer and the Use (E) key already read, so the outline + prompt
 * now light up off proximity instead of a raycast.
 *
 * Activation: the Use key calls `activateNearest()`, which fires the matching
 * handler's onClick for the current selection (open a panel, pick up, use a
 * POI prop). Every existing interaction kind is preserved — the handler set is
 * unchanged; only the SELECTION mechanism moved from cursor to proximity.
 *
 * The selection math is the pure `pickNearestInteractable` helper (tested);
 * this class is the world-scan + signal plumbing around it.
 */
import type { ClientWorld } from "../state/client_world.ts";
import type { EntityInteractionHandler, InteractionTarget } from "./types.ts";
import { hoverState } from "../input/context.ts";
import { pickNearestInteractable, type InteractableCandidate } from "./nearest.ts";

export class InteractionSystem {
  private readonly handlers: EntityInteractionHandler[] = [];
  private selectedEntityId: string | null = null;
  /** Player position from the last update() — the ONE position source shared
   *  by selection and activation, so an entity the prompt lit up for can never
   *  silently refuse activation because a different source (predicted vs
   *  networked) straddled the range line. */
  private lastPlayerX = 0;
  private lastPlayerY = 0;

  constructor(private readonly world: ClientWorld) {}

  // ---- handler registry ----

  register(handler: EntityInteractionHandler): void {
    this.handlers.push(handler);
    this.handlers.sort((a, b) => b.priority - a.priority);
  }

  unregister(id: string): void {
    const idx = this.handlers.findIndex((h) => h.id === id);
    if (idx !== -1) this.handlers.splice(idx, 1);
  }

  // ---- per-frame update ----

  /**
   * Re-select the nearest interactable to the local player and publish it to
   * `hoverState`. Called once per render frame with the player's world XY.
   */
  update(playerX: number, playerY: number): void {
    this.lastPlayerX = playerX;
    this.lastPlayerY = playerY;
    const candidates: InteractableCandidate[] = [];
    for (const [entityId, state] of this.world.entries()) {
      const pos = state.position;
      if (!pos) continue;
      const target = this._buildTarget(entityId);
      if (!target) continue;
      // The highest-priority matching handler decides this entity's range.
      for (const h of this.handlers) {
        if (!h.canHandle(target)) continue;
        candidates.push({ entityId, x: pos.x, y: pos.y, range: h.interactionRange, priority: h.priority });
        break;
      }
    }

    const nearest = pickNearestInteractable(candidates, playerX, playerY);
    const nextId = nearest?.entityId ?? null;
    if (nextId === this.selectedEntityId) return;
    this.selectedEntityId = nextId;
    hoverState.value = nextId !== null ? { kind: "entity", entityId: nextId } : { kind: "none" };
  }

  /**
   * Fire the matching handler's activate (onClick) for the current selection —
   * the Use key's action. Returns true if a handler consumed it. Range is
   * re-checked here (against the SAME position update() last selected with)
   * so a selection that drifted out of range this frame doesn't fire. This is
   * the single client-side reach gate; the server re-checks every command.
   */
  activateNearest(): boolean {
    if (this.selectedEntityId === null) return false;
    const target = this._buildTarget(this.selectedEntityId);
    if (!target) return false;
    const dx = target.worldX - this.lastPlayerX;
    const dy = target.worldY - this.lastPlayerY;
    const distSq = dx * dx + dy * dy;
    for (const h of this.handlers) {
      if (!h.canHandle(target)) continue;
      if (distSq > h.interactionRange * h.interactionRange) continue;
      return h.onClick(target);
    }
    return false;
  }

  /** The currently selected interactable entity id, or null. */
  get selected(): string | null { return this.selectedEntityId; }

  dispose(): void {
    this.handlers.length = 0;
    this.selectedEntityId = null;
  }

  // ---- internals ----

  private _buildTarget(entityId: string): InteractionTarget | null {
    const state = this.world.get(entityId);
    if (!state) return null;
    return {
      entityId,
      entityState: state,
      worldX: state.position?.x ?? 0,
      worldY: state.position?.y ?? 0,
    };
  }
}
