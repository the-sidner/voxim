/// <reference lib="dom" />
/**
 * IntentTranslator — turns RawEvents into typed Intents.
 *
 * Owns transient input state that doesn't belong on the wire: held keys,
 * facing angle, RMB long-press timer, accumulated one-shot action bits.
 * Charging gestures (LMB hold) are mirrored into the global HoldState
 * signal so UI components (charge bar, build ghost) can subscribe.
 *
 * Maintains the per-frame MovementDatagram for the game loop — the same
 * shape the old InputController produced, with `chargeMs` populated on
 * release ticks.
 *
 * Mode rules:
 *   normal + LMB-down → start charge
 *   normal + LMB-up   → emit world-main-action { chargeMs }
 *   normal + RMB-down + hammer equipped → start RMB long-press timer
 *   normal + RMB-up + hammer equipped, held < 300ms → place-blueprint
 *   normal + RMB-up + hammer equipped, held ≥ 300ms → already opened radial
 *   normal + RMB-down + no hammer → block-start
 *   normal + RMB-up   + no hammer → block-end
 *   any   + KeyE-down → interact (with current hover)
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
import { holdState, hoverState } from "./context.ts";
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

const RMB_LONGPRESS_MS = 300;

export class IntentTranslator {
  private readonly keys = new Set<string>();
  private facing = 0;
  /** Accumulated one-shot bits cleared each buildDatagram(). */
  private pendingActions = 0;
  /** Charge that becomes part of the next datagram (cleared after build). */
  private pendingChargeMs = 0;

  private mouseCanvasX = 0;
  private mouseCanvasY = 0;

  /** RMB tracking for short-vs-long detection (build-mode only). */
  private rmbDownAtMs  = 0;
  private rmbLongTimer = 0;
  private rmbDidLong   = false;
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

    this.keys.add(e.code);
    switch (e.code) {
      case "Space":  this.pendingActions |= ACTION_JUMP;      break;
      case "KeyZ":   this.pendingActions |= ACTION_USE_SKILL; break;
      case "KeyC":   this.pendingActions |= ACTION_CONSUME;   break;
      case "Digit1": this.pendingActions |= ACTION_SKILL_1;   break;
      case "Digit2": this.pendingActions |= ACTION_SKILL_2;   break;
      case "Digit3": this.pendingActions |= ACTION_SKILL_3;   break;
      case "Digit4": this.pendingActions |= ACTION_SKILL_4;   break;
      case "KeyE":
        // Hover-driven interact. Translator emits the intent; the router
        // dispatches to whatever handler matches the current hover target.
        this.router.dispatch({ kind: "interact", hover: hoverState.value });
        break;
    }
  }

  // Reference for callers that still need the GAME_KEYS gate (future).
  static readonly GAME_KEYS = GAME_KEYS;

  // ---- mouse handling ----------------------------------------------------

  private onMouseMove(e: Extract<RawEvent, { kind: "mouse-move" }>): void {
    this.mouseCanvasX = e.canvasX;
    this.mouseCanvasY = e.canvasY;
    const { x: px, y: py } = this.getPlayerScreen();
    // Subtract π/4 to convert from screen-space to world-space angle (45°
    // isometric camera; screen-right = world-northeast).
    this.facing = Math.atan2(this.mouseCanvasY - py, this.mouseCanvasX - px) - Math.PI / 4;
  }

  private onMouseDown(e: Extract<RawEvent, { kind: "mouse-down" }>): void {
    if (targetIsInteractiveUI(e.target)) return;       // UI consumed it

    if (e.button === 0) {
      // Start LMB charge timer. The charge bar reads HoldState.lmb
      // reactively; world-main-action fires on release.
      holdState.value = { lmb: { downAtMs: e.t, canvasX: e.canvasX, canvasY: e.canvasY } };
    }

    if (e.button === 2) {
      this.rmbDown = true;
      if (this.buildMode) {
        // Hammer equipped: schedule the radial pop after RMB_LONGPRESS_MS.
        this.rmbDownAtMs = e.t;
        this.rmbDidLong  = false;
        const cx = e.canvasX, cy = e.canvasY;
        this.rmbLongTimer = globalThis.setTimeout(() => {
          this.rmbLongTimer = 0;
          this.rmbDidLong   = true;
          this.router.dispatch({ kind: "open-build-radial", canvasX: cx, canvasY: cy });
        }, RMB_LONGPRESS_MS) as unknown as number;
      } else {
        // No build mode: ACTION_BLOCK is held while RMB is down (the
        // per-frame datagram OR's it in via rmbDown). Emit the start
        // intent for handlers that want to react to entering block state.
        this.router.dispatch({ kind: "block-start" });
      }
    }
  }

  private onMouseUp(e: Extract<RawEvent, { kind: "mouse-up" }>): void {
    if (e.button === 0) {
      const held = holdState.value.lmb;
      holdState.value = { lmb: null };
      // If the down was on a UI element we never set holdState — skip.
      // Otherwise emit a world-main-action with the held duration.
      if (held && !targetIsInteractiveUI(e.target)) {
        const chargeMs = Math.max(0, Math.round(e.t - held.downAtMs));
        this.pendingChargeMs = chargeMs;
        this.pendingActions |= ACTION_USE_SKILL;
        this.router.dispatch({ kind: "world-main-action", chargeMs, hover: hoverState.value });
      }
    }

    if (e.button === 2) {
      this.rmbDown = false;
      if (this.buildMode) {
        if (this.rmbLongTimer) {
          globalThis.clearTimeout(this.rmbLongTimer);
          this.rmbLongTimer = 0;
        }
        if (!this.rmbDidLong) {
          // Short tap → place blueprint at cursor.
          this.router.dispatch({ kind: "place-blueprint", canvasX: e.canvasX, canvasY: e.canvasY });
        }
      } else {
        this.router.dispatch({ kind: "block-end" });
      }
    }
  }

  // ---- per-frame datagram --------------------------------------------------

  /** Called once per frame by the game loop. */
  buildDatagram(seq: number, tick: number): MovementDatagram {
    const fwdX =  Math.cos(this.facing);
    const fwdY =  Math.sin(this.facing);
    const rgtX =  Math.sin(this.facing);
    const rgtY = -Math.cos(this.facing);

    let movX = 0, movY = 0;
    if (this.keys.has("KeyW") || this.keys.has("ArrowUp"))    { movX += fwdX; movY += fwdY; }
    if (this.keys.has("KeyS") || this.keys.has("ArrowDown"))  { movX -= fwdX; movY -= fwdY; }
    if (this.keys.has("KeyA") || this.keys.has("ArrowLeft"))  { movX += rgtX; movY += rgtY; }
    if (this.keys.has("KeyD") || this.keys.has("ArrowRight")) { movX -= rgtX; movY -= rgtY; }

    const len = Math.sqrt(movX * movX + movY * movY);
    if (len > 0) { movX /= len; movY /= len; }

    if (len > 0 && (this.keys.has("ShiftLeft") || this.keys.has("ShiftRight"))) {
      this.pendingActions |= ACTION_DODGE;
    }

    let held = 0;
    if (this.keys.has("ControlLeft") || this.keys.has("ControlRight")) held |= ACTION_CROUCH;
    if (this.keys.has("KeyF")) held |= ACTION_BLOCK;
    // RMB-held block (no hammer) — mirrors the legacy ACTION_BLOCK while RMB is down.
    // Translator tracks via the held key set for symmetry, but RMB isn't a key,
    // so we read the long-press timer state instead: block stays held while
    // we're outside build mode and RMB is down (rmbDownAtMs != 0 unset).
    // For T-130 we rely on the block-start / block-end intents to set/clear
    // a server-side "blocking" flag in the future; for now ACTION_BLOCK
    // remains the wire mechanism. Re-emit while the bit is needed:
    if (!this.buildMode && this.rmbDown) held |= ACTION_BLOCK;

    const actions = this.pendingActions | held;
    this.pendingActions = 0;
    const chargeMs = this.pendingChargeMs;
    this.pendingChargeMs = 0;

    return {
      seq,
      tick,
      timestamp: Date.now(),
      facing: this.facing,
      movementX: movX,
      movementY: movY,
      actions,
      chargeMs,
    };
  }

  // ---- accessors ---------------------------------------------------------

  get mouseX(): number { return this.mouseCanvasX; }
  get mouseY(): number { return this.mouseCanvasY; }
}
