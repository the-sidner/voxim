/// <reference lib="dom" />
/**
 * PointerLockController — owns the free-look pointer-lock lifecycle (T-320).
 *
 * The free-look camera reads raw mouse deltas (`movementX/movementY`), which
 * the browser only delivers while the pointer is locked. This controller:
 *
 *   - locks on a canvas mousedown when the world should own the cursor
 *     (no UI panel open, not in build mode);
 *   - feeds each locked mousemove delta to `onLook` (→ cameraRig.applyLookDelta);
 *   - releases (`exitPointerLock`) the moment a UI panel opens or build mode is
 *     entered, so the cursor returns for menus / voxel placement — REQUIRED,
 *     not optional (an unreleased lock makes every panel unusable);
 *   - never auto-re-locks: re-engaging is always an explicit canvas click, so a
 *     panel-close can't fight the browser into a lock/unlock loop.
 *
 * Build mode is treated exactly like an open menu: it needs the OS cursor for
 * cursor-plane voxel placement (`_resolveVoxelHit`), impossible under lock.
 *
 * The controller listens on `document` (pointerlockchange fires there) and owns
 * a `locked` mirror so callers can gate rotation. Esc is handled by the browser
 * (auto-exits lock) — no explicit unbind needed.
 */
import { effect } from "@preact/signals";
import { modeState } from "./context.ts";
import { uiState } from "../ui/ui_store.ts";

export class PointerLockController {
  private _locked = false;
  private readonly disposeEffect: () => void;
  private readonly _onDown: (e: MouseEvent) => void;
  private readonly _onMove: (e: MouseEvent) => void;
  private readonly _onChange: () => void;
  private readonly _onError: () => void;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    /** Apply an accumulated look delta (pixels) — cameraRig.applyLookDelta. */
    private readonly onLook: (dxPixels: number, dyPixels: number) => void,
  ) {
    // Engage on a bare canvas mousedown when the world owns the cursor.
    this._onDown = (e) => {
      if (e.target !== this.canvas) return;
      if (this._locked) return;
      if (!this.worldOwnsCursor()) return;
      this.canvas.requestPointerLock();
    };

    // Only feed deltas while genuinely locked to THIS canvas.
    this._onMove = (e) => {
      if (!this._locked) return;
      this.onLook(e.movementX, e.movementY);
    };

    this._onChange = () => {
      this._locked = document.pointerLockElement === this.canvas;
    };
    this._onError = () => {
      this._locked = false;
    };

    document.addEventListener("mousedown", this._onDown);
    document.addEventListener("mousemove", this._onMove);
    document.addEventListener("pointerlockchange", this._onChange);
    document.addEventListener("pointerlockerror", this._onError);

    // Auto-release whenever the world no longer owns the cursor (a panel opened
    // or build mode was entered). Re-locking is always an explicit click.
    this.disposeEffect = effect(() => {
      const world = this.worldOwnsCursor();
      if (!world && document.pointerLockElement === this.canvas) {
        document.exitPointerLock();
      }
    });
  }

  /** True when the world (not a menu / build mode) should hold the cursor. */
  private worldOwnsCursor(): boolean {
    return uiState.value.openPanels.size === 0 && modeState.value.kind !== "build";
  }

  get locked(): boolean { return this._locked; }

  dispose(): void {
    this.disposeEffect();
    document.removeEventListener("mousedown", this._onDown);
    document.removeEventListener("mousemove", this._onMove);
    document.removeEventListener("pointerlockchange", this._onChange);
    document.removeEventListener("pointerlockerror", this._onError);
    if (document.pointerLockElement === this.canvas) document.exitPointerLock();
  }
}
