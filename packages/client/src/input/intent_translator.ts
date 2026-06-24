/// <reference lib="dom" />
/**
 * IntentTranslator — turns RawEvents into typed Intents.
 *
 * Owns transient input state that doesn't belong on the wire: held keys,
 * facing angle, RMB-down flag, accumulated one-shot action bits.
 * Charging gestures (LMB hold) are mirrored into the global HoldState
 * signal so UI components (charge bar, build ghost) can subscribe.
 *
 * Maintains the per-frame MovementDatagram for the game loop — the same
 * shape the old InputController produced, with `chargeMs` populated on
 * release ticks.
 *
 * Mode rules:
 *   normal + LMB-down → start charge
 *   normal + LMB-up   → world-main-action { chargeMs }
 *   normal + RMB-down + hammer equipped → open-build-radial
 *   normal + RMB-down + no hammer       → block-start
 *   normal + RMB-up   + no hammer       → block-end
 *   build  + LMB-up   → build-action  (place / anchor)
 *   build  + RMB-up   → build-undo    (pop anchor or exit)
 *   build  + ESC      → build-cancel
 *   any    + KeyE-down → interact (with current hover)
 *
 * UI events: when the click target is an interactive UI element, world
 * intents are suppressed — the UI's own onClick handlers run.
 */
import type { MovementDatagram } from "@voxim/protocol";
import {
  ACTION_USE_SKILL,
  ACTION_BLOCK,
  ACTION_JUMP,
  ACTION_DODGE,
  ACTION_CROUCH,
  ACTION_CONSUME,
  ACTION_SKILL_1,
  ACTION_SKILL_2,
  ACTION_SKILL_3,
  ACTION_SKILL_4,
} from "@voxim/protocol";
import { holdState, hoverState, modeState } from "./context.ts";
import type { IntentRouter } from "./intent_router.ts";
import type { RawEvent } from "./input_capture.ts";
import { targetIsInteractiveUI } from "./input_capture.ts";

const GAME_KEYS = new Set([
  "KeyW", "KeyA", "KeyS", "KeyD",
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
  "Space", "ShiftLeft", "ShiftRight",
  "ControlLeft", "ControlRight",
  "KeyZ", "KeyE", "KeyC", "KeyF",
  "Digit1", "Digit2", "Digit3", "Digit4",
  "Escape",
]);

export class IntentTranslator {
  private readonly keys = new Set<string>();
  /** Player facing — updated each mouse-move from cursor-on-ground raycast.
   *  Exposed via `get facing()` so the renderer can predict the local body's
   *  rotation without the server round-trip (T-287). */
  private _facing = 0;
  /** Accumulated one-shot bits cleared each buildDatagram(). */
  private pendingActions = 0;
  /** Charge that becomes part of the next datagram (cleared after build). */
  private pendingChargeMs = 0;

  private mouseCanvasX = 0;
  private mouseCanvasY = 0;

  /** True while RMB is physically held — drives the held block bit when not in build mode. */
  private rmbDown = false;

  /**
   * Set by game.ts whenever the player's equipped weapon changes.
   * True when a hammer is equipped → RMB short-press places a blueprint
   * and a ≥300ms hold opens the radial. Otherwise RMB toggles block.
   *
   * (T-131 will replace this field with a proper Mode state machine.)
   */
  buildMode = false;

  constructor(
    private readonly router: IntentRouter,
    private readonly getPlayerScreen: () => { x: number; y: number },
    private readonly getCursorFacing: (canvasX: number, canvasY: number) => number | null,
    /** Fixed camera yaw — the basis for camera-relative movement (T-287). */
    private readonly getCameraYaw: () => number,
  ) {}

  /** Wire this as the InputCapture sink. */
  readonly handle = (e: RawEvent): void => {
    switch (e.kind) {
      case "key-down":   this.onKeyDown(e); return;
      case "key-up":     this.keys.delete(e.code); return;
      case "mouse-move": this.onMouseMove(e); return;
      case "mouse-down": this.onMouseDown(e); return;
      case "mouse-up":   this.onMouseUp(e); return;
    }
  };

  // ---- key handling ------------------------------------------------------

  private onKeyDown(e: Extract<RawEvent, { kind: "key-down" }>): void {
    // GAME_KEYS preventDefault'd in DOM via the dedicated capture step would
    // need access to the original event. Browsers will see Ctrl+W etc. — for
    // now we just gate the in-game effect, not the browser default. Revisit
    // if any browser shortcut becomes annoying.
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

    this.applyKeyEffect(e.code);

    // Keyboard-only UI dispatches — these need the live hover/mode state and so
    // are not part of the shared (test-reachable) movement/action path.
    switch (e.code) {
      case "KeyE":
        // Hover-driven interact. Translator emits the intent; the router
        // dispatches to whatever handler matches the current hover target.
        this.router.dispatch({ kind: "interact", hover: hoverState.value });
        break;
      case "Escape":
        // ESC exits build mode; in normal mode it falls through to the
        // global modal-stack popper handled by ui_manager.
        if (modeState.value.kind === "build") {
          this.router.dispatch({ kind: "build-cancel" });
        }
        break;
    }
  }

  /**
   * Apply a key-down's gameplay effect: track it in the held set + raise any
   * one-shot action bit. Shared by the real keyboard (onKeyDown) and the
   * test-input hook (`pressKey`) so both drive the exact same InputState path.
   */
  private applyKeyEffect(code: string): void {
    // Edge-trigger Shift only on transition from up→down so a held Shift
    // doesn't auto-redodge every frame.
    const wasDown = this.keys.has(code);
    this.keys.add(code);
    switch (code) {
      case "Space":      this.pendingActions |= ACTION_JUMP;      break;
      case "KeyZ":       this.pendingActions |= ACTION_USE_SKILL; break;
      case "KeyC":       this.pendingActions |= ACTION_CONSUME;   break;
      case "Digit1":     this.pendingActions |= ACTION_SKILL_1;   break;
      case "Digit2":     this.pendingActions |= ACTION_SKILL_2;   break;
      case "Digit3":     this.pendingActions |= ACTION_SKILL_3;   break;
      case "Digit4":     this.pendingActions |= ACTION_SKILL_4;   break;
      case "ShiftLeft":
      case "ShiftRight":
        if (!wasDown) this.pendingActions |= ACTION_DODGE;
        break;
    }
  }

  /**
   * Test/automation input (T-272 harness): drive a key through the SAME held-set
   * + action-bit path the real keyboard feeds, so harness presses exercise
   * `buildDatagram` and the wire — not a faked DOM event whose focus target the
   * browser canvas can't reliably receive. Mirrors how `_voxim_game` exposes
   * world/playerId for reads. Skips the E/Escape UI dispatches by design.
   */
  pressKey(code: string): void { this.applyKeyEffect(code); }
  releaseKey(code: string): void { this.keys.delete(code); }

  // Reference for callers that still need the GAME_KEYS gate (future).
  static readonly GAME_KEYS = GAME_KEYS;

  // ---- mouse handling ----------------------------------------------------

  private onMouseMove(e: Extract<RawEvent, { kind: "mouse-move" }>): void {
    this.mouseCanvasX = e.canvasX;
    this.mouseCanvasY = e.canvasY;
    // Cursor → player facing: raycast onto the ground plane at player Y.
    // The renderer owns the camera + player position so it does the projection.
    const f = this.getCursorFacing(e.canvasX, e.canvasY);
    if (f !== null) this._facing = f;
  }

  private onMouseDown(e: Extract<RawEvent, { kind: "mouse-down" }>): void {
    if (targetIsInteractiveUI(e.target)) return;
    const mode = modeState.value;

    if (e.button === 0) {
      // LMB charge timer only outside build mode — in build mode the click
      // is an immediate place/anchor with no charge meaning.
      if (mode.kind === "normal") {
        holdState.value = { lmb: { downAtMs: e.t, canvasX: e.canvasX, canvasY: e.canvasY } };
      }
    }

    if (e.button === 2) {
      this.rmbDown = true;
      if (mode.kind === "normal" && this.buildMode) {
        // Hammer equipped, normal mode → opening the radial selects the
        // blueprint and enters build mode.
        this.router.dispatch({ kind: "open-build-radial", canvasX: e.canvasX, canvasY: e.canvasY });
      } else if (mode.kind === "normal") {
        // No hammer: held block. ACTION_BLOCK rides on the per-frame held
        // bit while rmbDown remains true.
        this.router.dispatch({ kind: "block-start" });
      }
    }
  }

  private onMouseUp(e: Extract<RawEvent, { kind: "mouse-up" }>): void {
    const mode = modeState.value;

    if (e.button === 0) {
      if (mode.kind === "build") {
        // Build mode: every LMB-up commits a placement/anchor.
        if (!targetIsInteractiveUI(e.target)) {
          this.router.dispatch({ kind: "build-action", canvasX: e.canvasX, canvasY: e.canvasY });
        }
      } else {
        // Normal mode: emit world-main-action with charged duration.
        const held = holdState.value.lmb;
        holdState.value = { lmb: null };
        if (held && !targetIsInteractiveUI(e.target)) {
          const chargeMs = Math.max(0, Math.round(e.t - held.downAtMs));
          this.pendingChargeMs = chargeMs;
          this.pendingActions |= ACTION_USE_SKILL;
          this.router.dispatch({ kind: "world-main-action", chargeMs, hover: hoverState.value });
        }
      }
    }

    if (e.button === 2) {
      this.rmbDown = false;
      if (mode.kind === "build") {
        // Build mode: pop the last anchor (or exit if no anchor staged).
        this.router.dispatch({ kind: "build-undo" });
      } else if (!this.buildMode) {
        // No-hammer normal mode: end the held block.
        this.router.dispatch({ kind: "block-end" });
      }
      // Hammer + normal mode: RMB-up is the radial commit, owned by
      // RadialMenu's own listener.
    }
  }

  // ---- per-frame datagram --------------------------------------------------

  /** Called once per frame by the game loop. */
  buildDatagram(seq: number, tick: number): MovementDatagram {
    // Movement is CAMERA-relative (T-287): W = "into the screen" (away from
    // the camera along its fixed yaw), D = screen-right — independent of where
    // the cursor points. The body still aims at the cursor (`facing` on the
    // wire below), so melee/aim track the cursor while locomotion follows the
    // screen. Diablo/PoE muscle memory on a fixed-yaw camera.
    const yaw = this.getCameraYaw();
    const fwdX =  Math.cos(yaw);
    const fwdY =  Math.sin(yaw);
    // Screen-right is camera-forward × world-up; for this fixed top-down rig
    // that resolves to the math-CCW perpendicular (-sin, cos), so pressing D
    // strafes to the player-perceived right of the screen.
    const rgtX = -Math.sin(yaw);
    const rgtY =  Math.cos(yaw);

    let movX = 0, movY = 0;
    if (this.keys.has("KeyW") || this.keys.has("ArrowUp"))    { movX += fwdX; movY += fwdY; }
    if (this.keys.has("KeyS") || this.keys.has("ArrowDown"))  { movX -= fwdX; movY -= fwdY; }
    if (this.keys.has("KeyA") || this.keys.has("ArrowLeft"))  { movX -= rgtX; movY -= rgtY; }
    if (this.keys.has("KeyD") || this.keys.has("ArrowRight")) { movX += rgtX; movY += rgtY; }

    const len = Math.sqrt(movX * movX + movY * movY);
    if (len > 0) { movX /= len; movY /= len; }

    let held = 0;
    if (this.keys.has("ControlLeft") || this.keys.has("ControlRight")) held |= ACTION_CROUCH;
    if (this.keys.has("KeyF")) held |= ACTION_BLOCK;
    // No-hammer normal mode: RMB held re-emits ACTION_BLOCK every frame so
    // the server-side block stays active.
    if (!this.buildMode && this.rmbDown) held |= ACTION_BLOCK;

    const actions = this.pendingActions | held;
    this.pendingActions = 0;
    const chargeMs = this.pendingChargeMs;
    this.pendingChargeMs = 0;

    return {
      seq,
      tick,
      timestamp: Date.now(),
      facing: this._facing,
      movementX: movX,
      movementY: movY,
      actions,
      chargeMs,
    };
  }

  // ---- accessors ---------------------------------------------------------

  get mouseX(): number { return this.mouseCanvasX; }
  get mouseY(): number { return this.mouseCanvasY; }

  /** Cursor-derived facing (radians). The local, un-round-tripped value the
   *  renderer applies to the local mesh for predicted body rotation (T-287). */
  get facing(): number { return this._facing; }
}
