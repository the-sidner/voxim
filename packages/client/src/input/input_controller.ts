/// <reference lib="dom" />
/**
 * Converts keyboard + mouse state into InputDatagram values each frame.
 *
 * Movement: WASD / arrow keys → normalised (movementX, movementY).
 * Facing:   mouse position relative to player screen position → angle in radians.
 * Actions:  bitfield accumulated each frame; one-shot actions (jump, interact)
 *           fire once and clear; held actions (block) remain while key is held.
 */
import type { InputDatagram } from "@voxim/protocol";
import {
  ACTION_USE_SKILL,
  ACTION_BLOCK,
  ACTION_JUMP,
  ACTION_INTERACT,
  ACTION_DODGE,
  ACTION_CROUCH,
  ACTION_EQUIP,
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
  private interactSlot = 0;

  private readonly _keydown: (e: KeyboardEvent) => void;
  private readonly _keyup: (e: KeyboardEvent) => void;
  private readonly _mousemove: (e: MouseEvent) => void;
  private readonly _mousedown: (e: MouseEvent) => void;
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
      const { x: px, y: py } = this.getPlayerScreen();
      // Subtract π/4 to convert from screen-space to world-space angle.
      // The isometric camera sits at 45° azimuth, so screen-right = world-northeast.
      // The server hitbox uses world-space atan2, so facing must match.
      this.facing = Math.atan2(
        (e.clientY - rect.top) - py,
        (e.clientX - rect.left) - px,
      ) - Math.PI / 4;
    };
    this._mousedown = (e) => {
      if (e.button === 0) this.pendingActions |= ACTION_USE_SKILL;
      if (e.button === 2) this.pendingActions |= ACTION_BLOCK;
    };
    this._contextmenu = (e) => e.preventDefault();

    globalThis.addEventListener("keydown", this._keydown);
    globalThis.addEventListener("keyup", this._keyup);
    canvas.addEventListener("mousemove", this._mousemove);
    canvas.addEventListener("mousedown", this._mousedown);
    canvas.addEventListener("contextmenu", this._contextmenu);
  }

  private handleKeyDown(e: KeyboardEvent): void {
    this.keys.add(e.code);
    switch (e.code) {
      case "Space":     this.pendingActions |= ACTION_JUMP;     e.preventDefault(); break;
      case "KeyZ":      this.pendingActions |= ACTION_USE_SKILL;   break;
      case "KeyE":      this.pendingActions |= ACTION_INTERACT; break;
      case "KeyQ":      this.pendingActions |= ACTION_EQUIP;    break;
      case "KeyC":      this.pendingActions |= ACTION_CONSUME;  break;
      case "Digit1":    this.pendingActions |= ACTION_SKILL_1;  break;
      case "Digit2":    this.pendingActions |= ACTION_SKILL_2;  break;
      case "Digit3":    this.pendingActions |= ACTION_SKILL_3;  break;
      case "Digit4":    this.pendingActions |= ACTION_SKILL_4;  break;
    }
  }

  /** Called by the game loop at input frequency (~60 Hz). Consumes one-shot actions. */
  buildDatagram(seq: number, tick: number): InputDatagram {
    let movX = 0;
    let movY = 0;
    if (this.keys.has("KeyW") || this.keys.has("ArrowUp"))    movY -= 1;
    if (this.keys.has("KeyS") || this.keys.has("ArrowDown"))  movY += 1;
    if (this.keys.has("KeyA") || this.keys.has("ArrowLeft"))  movX -= 1;
    if (this.keys.has("KeyD") || this.keys.has("ArrowRight")) movX += 1;

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
      interactSlot: this.interactSlot,
    };
  }

  setInteractSlot(slot: number): void {
    this.interactSlot = slot;
  }

  dispose(): void {
    window.removeEventListener("keydown", this._keydown);
    window.removeEventListener("keyup", this._keyup);
    this.canvas.removeEventListener("mousemove", this._mousemove);
    this.canvas.removeEventListener("mousedown", this._mousedown);
    this.canvas.removeEventListener("contextmenu", this._contextmenu);
  }
}
