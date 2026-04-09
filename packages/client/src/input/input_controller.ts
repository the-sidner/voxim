/// <reference lib="dom" />
/**
 * Converts keyboard + mouse state into MovementDatagram values each frame.
 *
 * Movement: WASD / arrow keys → normalised (movementX, movementY) in world space.
 *   W = forward  (toward mouse cursor / facing direction)
 *   S = backward (away from mouse cursor)
 *   A = strafe left  (90° CCW from facing)
 *   D = strafe right (90° CW  from facing)
 *   Per-key world-space contributions are accumulated then normalised, so
 *   diagonal movement (W+D) is automatically capped at unit length.
 *
 * Facing:   mouse position relative to player screen position → world-space angle
 *           in radians (atan2 with π/4 isometric adjustment).
 * Actions:  bitfield accumulated each frame; one-shot actions (jump, interact)
 *           fire once and clear; held actions (block) remain while key is held.
 *
 * Slot-based commands (equip, drop, move item, lore, trade) are sent as
 * CommandDatagrams by game.ts via VoximGame._sendCommand() — not from here.
 */
import type { MovementDatagram } from "@voxim/protocol";
import {
  ACTION_USE_SKILL,
  ACTION_BLOCK,
  ACTION_JUMP,
  ACTION_INTERACT,
  ACTION_DODGE,
  ACTION_CROUCH,
  ACTION_CONSUME,
  ACTION_SKILL_1,
  ACTION_SKILL_2,
  ACTION_SKILL_3,
  ACTION_SKILL_4,
} from "@voxim/protocol";

export class InputController {
  private readonly keys = new Set<string>();
  private facing = 0;
  /** One-shot actions accumulated between buildDatagram calls. */
  private pendingActions = 0;

  /**
   * When true, RMB does blueprint placement instead of blocking.
   * Set by game.ts whenever the equipped weapon changes.
   */
  buildMode = false;

  /** Canvas-relative mouse position, updated on every mousemove. */
  private mouseCanvasX = 0;
  private mouseCanvasY = 0;

  /** RMB long-press tracking. */
  private rmbDownTime = 0;
  private rmbLongPressTimer = 0;

  /**
   * Called on short RMB (tap < 300 ms) when buildMode is true.
   * Receives canvas-relative mouse coordinates at the time of the click.
   */
  onBuildPlace?: (canvasX: number, canvasY: number) => void;

  /**
   * Called when RMB is held ≥ 300 ms and buildMode is true.
   * Receives canvas-relative mouse coordinates at press time.
   */
  onBuildOpenMenu?: (canvasX: number, canvasY: number) => void;

  private readonly _keydown: (e: KeyboardEvent) => void;
  private readonly _keyup: (e: KeyboardEvent) => void;
  private readonly _mousemove: (e: MouseEvent) => void;
  private readonly _mousedown: (e: MouseEvent) => void;
  private readonly _mouseup: (e: MouseEvent) => void;
  private readonly _contextmenu: (e: Event) => void;

  /**
   * @param canvas           The rendering canvas (used for mouse event coordinates).
   * @param getPlayerScreen  Returns the canvas-relative pixel position of the local
   *                         player, used to compute the facing angle from the mouse.
   */
  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly getPlayerScreen: () => { x: number; y: number },
  ) {
    this._keydown = (e) => this.handleKeyDown(e);
    this._keyup = (e) => this.keys.delete(e.code);
    this._mousemove = (e) => {
      const rect = canvas.getBoundingClientRect();
      this.mouseCanvasX = e.clientX - rect.left;
      this.mouseCanvasY = e.clientY - rect.top;
      const { x: px, y: py } = this.getPlayerScreen();
      // Subtract π/4 to convert from screen-space to world-space angle.
      // The isometric camera sits at 45° azimuth, so screen-right = world-northeast.
      // The server hitbox uses world-space atan2, so facing must match.
      this.facing = Math.atan2(
        this.mouseCanvasY - py,
        this.mouseCanvasX - px,
      ) - Math.PI / 4;
    };
    this._mousedown = (e) => {
      if (e.button === 0) this.pendingActions |= ACTION_USE_SKILL;
      if (e.button === 2) {
        if (this.buildMode) {
          // Track press for long/short detection; suppress ACTION_BLOCK
          console.log(`[Input] RMB down buildMode=true canvas=(${this.mouseCanvasX.toFixed(0)},${this.mouseCanvasY.toFixed(0)})`);
          this.rmbDownTime = Date.now();
          const cx = this.mouseCanvasX;
          const cy = this.mouseCanvasY;
          this.rmbLongPressTimer = globalThis.setTimeout(() => {
            this.rmbLongPressTimer = 0;
            this.onBuildOpenMenu?.(cx, cy);
          }, 300) as unknown as number;
        } else {
          this.pendingActions |= ACTION_BLOCK;
        }
      }
    };
    this._mouseup = (e) => {
      if (e.button === 2 && this.buildMode) {
        const held = Date.now() - this.rmbDownTime;
        console.log(`[Input] RMB up buildMode=true held=${held}ms`);
        if (this.rmbLongPressTimer) {
          globalThis.clearTimeout(this.rmbLongPressTimer);
          this.rmbLongPressTimer = 0;
        }
        // Only fire short-press if it was released before the long-press threshold
        if (held < 300) {
          this.onBuildPlace?.(this.mouseCanvasX, this.mouseCanvasY);
        }
      }
    };
    this._contextmenu = (e) => e.preventDefault();

    globalThis.addEventListener("keydown", this._keydown);
    globalThis.addEventListener("keyup", this._keyup);
    canvas.addEventListener("mousemove", this._mousemove);
    canvas.addEventListener("mousedown", this._mousedown);
    canvas.addEventListener("mouseup", this._mouseup);
    canvas.addEventListener("contextmenu", this._contextmenu);
  }

  private handleKeyDown(e: KeyboardEvent): void {
    this.keys.add(e.code);
    switch (e.code) {
      case "Space":     this.pendingActions |= ACTION_JUMP;        e.preventDefault(); break;
      case "KeyZ":      this.pendingActions |= ACTION_USE_SKILL;   break;
      case "KeyE":      this.pendingActions |= ACTION_INTERACT;    break;
      case "KeyC":      this.pendingActions |= ACTION_CONSUME;     break;
      case "Digit1":    this.pendingActions |= ACTION_SKILL_1;     break;
      case "Digit2":    this.pendingActions |= ACTION_SKILL_2;     break;
      case "Digit3":    this.pendingActions |= ACTION_SKILL_3;     break;
      case "Digit4":    this.pendingActions |= ACTION_SKILL_4;     break;
    }
  }

  /** Called by the game loop at input frequency (~60 Hz). Consumes one-shot actions. */
  buildDatagram(seq: number, tick: number): MovementDatagram {
    // World-space forward and right unit vectors derived from the current facing angle.
    // facing is the world-space angle (radians) from positive X toward the mouse cursor.
    const fwdX =  Math.cos(this.facing);  // forward = direction entity is looking
    const fwdY =  Math.sin(this.facing);
    const rgtX =  Math.sin(this.facing);  // left = 90° clockwise from forward (world Y flipped in iso)
    const rgtY = -Math.cos(this.facing);

    let movX = 0;
    let movY = 0;
    if (this.keys.has("KeyW") || this.keys.has("ArrowUp"))    { movX += fwdX; movY += fwdY; }
    if (this.keys.has("KeyS") || this.keys.has("ArrowDown"))  { movX -= fwdX; movY -= fwdY; }
    if (this.keys.has("KeyA") || this.keys.has("ArrowLeft"))  { movX += rgtX; movY += rgtY; }
    if (this.keys.has("KeyD") || this.keys.has("ArrowRight")) { movX -= rgtX; movY -= rgtY; }

    const len = Math.sqrt(movX * movX + movY * movY);
    if (len > 0) { movX /= len; movY /= len; }

    // Shift + any movement direction = dodge (one-shot)
    if (len > 0 && (this.keys.has("ShiftLeft") || this.keys.has("ShiftRight"))) {
      this.pendingActions |= ACTION_DODGE;
    }

    // Ctrl = crouch (held)
    let held = 0;
    if (this.keys.has("ControlLeft") || this.keys.has("ControlRight")) held |= ACTION_CROUCH;
    if (this.keys.has("KeyF")) held |= ACTION_BLOCK;

    const actions = this.pendingActions | held;
    this.pendingActions = 0;

    return {
      seq,
      tick,
      timestamp: Date.now(),
      facing: this.facing,
      movementX: movX,
      movementY: movY,
      actions,
    };
  }

  dispose(): void {
    window.removeEventListener("keydown", this._keydown);
    window.removeEventListener("keyup", this._keyup);
    this.canvas.removeEventListener("mousemove", this._mousemove);
    this.canvas.removeEventListener("mousedown", this._mousedown);
    this.canvas.removeEventListener("mouseup", this._mouseup);
    this.canvas.removeEventListener("contextmenu", this._contextmenu);
    if (this.rmbLongPressTimer) globalThis.clearTimeout(this.rmbLongPressTimer);
  }
}
