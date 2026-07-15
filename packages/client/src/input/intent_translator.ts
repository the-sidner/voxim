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
 *   any    + KeyE-down → interact (nearest interactable)
 *
 * Facing (T-328): mouse-X directly rotates the player's FACING under pointer
 * lock — `applyLookDelta` accumulates `facing += dx * sensitivity` (wrapped),
 * fed the same raw deltas PointerLockController delivers. This carries on the
 * wire and drives the local body prediction. Movement is transformed by the
 * FACING basis (not the camera's), so A/D strafe and S back-pedals while the
 * character keeps facing wherever the mouse pointed it — the camera derives
 * its yaw from this same facing (see camera_rig.ts `setYaw`), rigidly, so the
 * two never disagree. Supersedes T-320's `facingFromMove` (facing = movement
 * direction), which made it impossible to strafe around a target while
 * looking at it.
 *
 * UI events: when the click target is an interactive UI element, world
 * intents are suppressed — the UI's own onClick handlers run. Independently
 * (T-325), every mouse handler bails out entirely whenever `inputMode` (the
 * single mouse-ownership owner, `input_mode.ts`) is `ui` — that covers clicks
 * and moves that land on the CANVAS around/behind a panel, which a target
 * check alone can't catch since the event target there genuinely is the
 * canvas, not a UI node.
 */
import { clamp } from "@voxim/engine";
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
import { facingFromLook } from "./facing.ts";
import { inputMode } from "./input_mode.ts";

/** The `mouseSensitivity` slice of game_config `camera.*` (T-328) — the same
 *  knob CameraRig's pitch axis consumes, so turning the mouse rotates facing
 *  and pitch at the identical rate. A narrow shape (not the full CameraConfig)
 *  so this module doesn't need to import render/camera_rig.ts's type. */
export interface FacingConfig {
  mouseSensitivity: number;
  /** `game_config.input.bindings` — action id → KeyboardEvent codes (T-335).
   *  Optional so a caller that only wants to set sensitivity keeps the
   *  defaults. */
  bindings?: Record<string, string[]>;
  /**
   * Hold-to-aim pitch band (T-337) — `game_config.combat.aim`, the SAME
   * degrees the server clamps `InputState.pitch` into
   * (`ProjectileSpawnResolver`). The client accumulates `aimPitch` directly
   * in this range (0 = level, positive = upward elevation) — there is no
   * separate client-side curve to keep in sync with the server's, by
   * construction. Optional so a caller that only wants facing/bindings
   * keeps the pre-bootstrap default (0..45deg).
   */
  aim?: { pitchMinDeg: number; pitchMaxDeg: number };
}

/**
 * Every action a key can be bound to. The translator switches on THESE, never on
 * a raw `KeyboardEvent.code` — the code→action mapping is content
 * (`game_config.input.bindings`, T-335), so a rebind is a JSON edit and the
 * boot validator can refuse a binding a browser would steal (crouch used to sit
 * on Ctrl, which made crouch-walking forward — Ctrl+W — close the tab).
 */
export type InputAction =
  | "moveForward" | "moveBack" | "moveLeft" | "moveRight"
  | "jump" | "dodge" | "crouch" | "block" | "interact" | "consume"
  | "useSkill" | "skill1" | "skill2" | "skill3" | "skill4";

/** Pre-bootstrap fallback — mirrors `game_config.input.bindings` exactly, so the
 *  keyboard works on the join screen before the content blob lands. Ctrl appears
 *  nowhere, by construction. */
const DEFAULT_BINDINGS: Record<InputAction, string[]> = {
  moveForward: ["KeyW", "ArrowUp"],
  moveBack:    ["KeyS", "ArrowDown"],
  moveLeft:    ["KeyA", "ArrowLeft"],
  moveRight:   ["KeyD", "ArrowRight"],
  jump:        ["Space"],
  dodge:       ["ShiftLeft", "ShiftRight"],
  crouch:      ["KeyC"],
  block:       ["KeyF"],
  interact:    ["KeyE"],
  consume:     ["KeyQ"],
  useSkill:    ["KeyZ"],
  skill1:      ["Digit1"],
  skill2:      ["Digit2"],
  skill3:      ["Digit3"],
  skill4:      ["Digit4"],
};

function invertBindings(b: Record<string, string[]>): Map<string, InputAction> {
  const byCode = new Map<string, InputAction>();
  for (const [action, codes] of Object.entries(b)) {
    for (const code of codes) byCode.set(code, action as InputAction);
  }
  return byCode;
}

export class IntentTranslator {
  private readonly keys = new Set<string>();
  /** Player facing — accumulated directly from mouse-X look deltas
   *  (`applyLookDelta`, T-328), wrapped into (-π, π]. Exposed via
   *  `get facing()` so the renderer predicts the local body's rotation
   *  without the server round-trip, and so the camera can derive its yaw
   *  from the identical value (rigid coupling — see camera_rig.ts). */
  private _facing = 0;
  /** Radians of facing rotation per look-delta pixel — game_config
   *  `camera.mouseSensitivity` (T-328). Pre-bootstrap default mirrors
   *  CameraRig's own pre-configure default so the two axes match before
   *  `configure()` overwrites both from content. */
  private sensitivity = 0.011;
  /** Live keyboard bindings — `game_config.input.bindings` once the content blob
   *  lands, DEFAULT_BINDINGS until then (T-335). */
  private bindings: Record<InputAction, string[]> = DEFAULT_BINDINGS;
  /** Reverse of `bindings`, rebuilt on configure(). The switch in
   *  `applyKeyEffect` dispatches through this — never on a literal key code. */
  private actionByCode = invertBindings(DEFAULT_BINDINGS);
  /** Accumulated one-shot bits cleared each buildDatagram(). */
  private pendingActions = 0;
  /** Charge that becomes part of the next datagram (cleared after build). */
  private pendingChargeMs = 0;

  private mouseCanvasX = 0;
  private mouseCanvasY = 0;

  /** True while RMB is physically held — drives the held block bit when not in build mode. */
  private rmbDown = false;
  /** True while LMB is physically held AND `aimWeaponActive` — the mouse-driven
   *  half of the hold-to-aim trigger (T-337), mirroring `rmbDown`'s shape.
   *  Kept separate from the normal LMB charge-timer (`holdState`) — a
   *  hold-to-aim weapon suppresses that path entirely (see onMouseDown). */
  private mouseSkillHeld = false;

  /**
   * Set by game.ts whenever the player's equipped weapon changes.
   * True when a hammer is equipped → RMB short-press places a blueprint
   * and a ≥300ms hold opens the radial. Otherwise RMB toggles block.
   *
   * (T-131 will replace this field with a proper Mode state machine.)
   */
  buildMode = false;

  /**
   * Set by game.ts whenever the player's equipped weapon changes (T-337).
   * True when the weapon's resolved swingActionId names a hold-to-aim
   * ActionDef (kind:"ambient" + releaseActionId — its first phase need not
   * itself be perpetual, since a finite windup can lead into one). While
   * true, LMB/`useSkill` is read as a HELD signal every frame (`isAiming`)
   * instead of the normal one-shot tap-on-release, and mouse-Y is captured
   * into `aimPitch` instead of the camera's own pitch (see game.ts's
   * pointer-lock handler).
   */
  aimWeaponActive = false;

  /** Aim elevation while charging a hold-to-aim cast (T-337), radians,
   *  0 = level. Accumulated from mouse-Y ONLY while `isAiming` — a
   *  dedicated axis, decoupled from CameraRig's own (narrow, framing-only)
   *  pitch band. Clamped to `combat.aim.pitchMinDeg/pitchMaxDeg` — the SAME
   *  band the server clamps `InputState.pitch` into, so there is no
   *  separate curve to keep in sync. */
  private _aimPitch = 0;
  private aimPitchMinRad = 0;
  private aimPitchMaxRad = Math.PI / 4; // pre-bootstrap default: 45deg

  constructor(
    private readonly router: IntentRouter,
  ) {}

  /** Install the mouse-sensitivity knob from game_config `camera.*` (T-328),
   *  plus the T-337 aim-pitch band. Idempotent, mirrors CameraRig.configure()
   *  — both read the identical `camera.mouseSensitivity` value so facing and
   *  pitch turn at the same rate (the aim-pitch accumulator reuses this same
   *  rate too — a deliberate simplification: same look-feel, different axis
   *  and range, not a second sensitivity knob to tune). */
  configure(cfg: FacingConfig): void {
    this.sensitivity = cfg.mouseSensitivity;
    if (cfg.bindings) {
      this.bindings = cfg.bindings as Record<InputAction, string[]>;
      this.actionByCode = invertBindings(cfg.bindings);
    }
    if (cfg.aim) {
      this.aimPitchMinRad = cfg.aim.pitchMinDeg * Math.PI / 180;
      this.aimPitchMaxRad = cfg.aim.pitchMaxDeg * Math.PI / 180;
      this._aimPitch = clamp(this._aimPitch, this.aimPitchMinRad, this.aimPitchMaxRad);
    }
  }

  /**
   * Accumulate a raw mouse-X look delta (pixels) into facing (T-328) — the
   * clean input seam for pointer-lock `movementX` (and, later, a pad
   * right-stick). Wrapped into (-π, π]; see facing.ts for the pure rule.
   * The camera has no equivalent yaw accumulator anymore — it derives its
   * yaw from this facing every frame (camera_rig.ts `setYaw`).
   */
  applyLookDelta(dxPixels: number): void {
    this._facing = facingFromLook(this._facing, dxPixels, this.sensitivity);
  }

  /**
   * Accumulate a raw mouse-Y look delta (pixels) into `aimPitch` (T-337) —
   * the CAPTURED aim axis, fed instead of CameraRig's own pitch while
   * `isAiming` (see game.ts's pointer-lock handler, which branches on that
   * exact condition). Mouse UP (negative DOM movementY) increases pitch =
   * "up = farther", per the ticket; this is a SEPARATE, independently-signed
   * accumulator from CameraRig.applyLookDelta's own convention (there, +dy
   * steepens the gaze down) — the two are decoupled by design (T-337's
   * documented camera-capture decision), not required to agree.
   */
  applyAimPitchDelta(dyPixels: number): void {
    this._aimPitch = clamp(this._aimPitch - dyPixels * this.sensitivity, this.aimPitchMinRad, this.aimPitchMaxRad);
  }

  /** Aim elevation (radians, 0 = level) while a hold-to-aim cast charges. */
  get aimPitch(): number { return this._aimPitch; }

  /** True while a hold-to-aim weapon is equipped AND its trigger (LMB or the
   *  `useSkill` binding) is physically held — the client-side mirror of the
   *  server's "holding" branch in PrimaryIntentResolver. Drives which axis
   *  mouse-Y feeds (see game.ts) and whether ACTION_USE_SKILL rides as a
   *  HELD bit in buildDatagram(). */
  get isAiming(): boolean {
    return this.aimWeaponActive && (this.isHeld("useSkill") || this.mouseSkillHeld);
  }

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
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

    this.applyKeyEffect(e.code);

    // Keyboard-only UI dispatches — these need the live hover/mode state and so
    // are not part of the shared (test-reachable) movement/action path.
    if (this.actionByCode.get(e.code) === "interact") {
      // Hover-driven interact. Translator emits the intent; the router
      // dispatches to whatever handler matches the current hover target.
      this.router.dispatch({ kind: "interact", hover: hoverState.value });
    }
    // ESC is not a rebindable game action — it is the universal UI out. In build
    // mode it cancels; otherwise it falls through to ui_manager's modal popper.
    if (e.code === "Escape" && modeState.value.kind === "build") {
      this.router.dispatch({ kind: "build-cancel" });
    }
  }

  /**
   * Apply a key-down's gameplay effect: track it in the held set + raise any
   * one-shot action bit. Shared by the real keyboard (onKeyDown) and the
   * test-input hook (`pressKey`) so both drive the exact same InputState path.
   *
   * Switches on the bound ACTION, never on a raw key code (T-335) — the mapping
   * is content, so an unbound key is simply inert here.
   */
  private applyKeyEffect(code: string): void {
    // Edge-trigger dodge only on the up→down transition so a held key doesn't
    // auto-redodge every frame.
    const wasDown = this.keys.has(code);
    this.keys.add(code);
    switch (this.actionByCode.get(code)) {
      case "jump":     this.pendingActions |= ACTION_JUMP;      break;
      case "useSkill": this.pendingActions |= ACTION_USE_SKILL; break;
      case "consume":  this.pendingActions |= ACTION_CONSUME;   break;
      case "skill1":   this.pendingActions |= ACTION_SKILL_1;   break;
      case "skill2":   this.pendingActions |= ACTION_SKILL_2;   break;
      case "skill3":   this.pendingActions |= ACTION_SKILL_3;   break;
      case "skill4":   this.pendingActions |= ACTION_SKILL_4;   break;
      case "dodge":
        if (!wasDown) this.pendingActions |= ACTION_DODGE;
        break;
    }
  }

  /** True while any key bound to `action` is physically held. */
  private isHeld(action: InputAction): boolean {
    for (const code of this.bindings[action]) {
      if (this.keys.has(code)) return true;
    }
    return false;
  }

  /**
   * Test/automation input (T-272 harness): drive a key through the SAME held-set
   * + action-bit path the real keyboard feeds, so harness presses exercise
   * `buildDatagram` and the wire — not a faked DOM event whose focus target the
   * browser canvas can't reliably receive. Mirrors how `_voxim_game` exposes
   * world/playerId for reads. Skips the interact/Escape UI dispatches by design.
   */
  pressKey(code: string): void { this.applyKeyEffect(code); }
  releaseKey(code: string): void { this.keys.delete(code); }

  /** Codes the canvas should swallow rather than let the page act on. Derived
   *  from the live bindings (plus Escape, which is never a game action). */
  gameKeys(): Set<string> {
    return new Set([...this.actionByCode.keys(), "Escape"]);
  }

  // ---- mouse handling ----------------------------------------------------

  private onMouseMove(e: Extract<RawEvent, { kind: "mouse-move" }>): void {
    // T-325: the UI owns the mouse in "ui" mode — don't even track canvas
    // coords (they'd be stale/irrelevant once mode returns to gameplay/build).
    if (inputMode.value === "ui") return;
    // Facing is not cursor-derived (mouse-X drives it via applyLookDelta
    // under pointer lock, T-328) — this canvas-coord move handler is unused
    // for facing. We still capture the coords because build mode's
    // cursor-plane voxel placement (`_resolveVoxelHit`) reads them via
    // mouseX/mouseY while pointer lock is released for build.
    this.mouseCanvasX = e.canvasX;
    this.mouseCanvasY = e.canvasY;
  }

  private onMouseDown(e: Extract<RawEvent, { kind: "mouse-down" }>): void {
    if (inputMode.value === "ui") return;
    if (targetIsInteractiveUI(e.target)) return;
    const mode = modeState.value;

    if (e.button === 0) {
      if (mode.kind === "normal" && this.aimWeaponActive) {
        // T-337: a hold-to-aim weapon reads LMB as a HELD trigger
        // (buildDatagram), not the charge-timer tap. No holdState — the
        // cast bar (CastBar, driven by the networked action runtime) is
        // the feedback here, not the client-local ChargeBar.
        this.mouseSkillHeld = true;
      } else if (mode.kind === "normal") {
        // LMB charge timer only outside build mode — in build mode the click
        // is an immediate place/anchor with no charge meaning.
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
    // T-325: a panel can open MID-hold (e.g. 'I' pressed while RMB is still
    // physically down) — the held-button bookkeeping below always clears on
    // release so nothing leaks (a stuck ACTION_BLOCK bit, a phantom charge
    // bar), but the resulting world/build DISPATCH only fires while the
    // world still owns the mouse.
    const gameOwnsMouse = inputMode.value !== "ui";

    if (e.button === 0) {
      // T-337: unconditional clear, same "always clears on release so
      // nothing leaks" discipline as rmbDown below — a weapon swap mid-hold
      // (aimWeaponActive flips false before LMB-up) must not strand this
      // true forever.
      const wasAimingLmb = this.mouseSkillHeld;
      this.mouseSkillHeld = false;

      if (mode.kind === "build") {
        // Build mode: every LMB-up commits a placement/anchor.
        if (gameOwnsMouse && !targetIsInteractiveUI(e.target)) {
          this.router.dispatch({ kind: "build-action", canvasX: e.canvasX, canvasY: e.canvasY });
        }
      } else if (this.aimWeaponActive || wasAimingLmb) {
        // Release is server-driven (PrimaryIntentResolver reacts to the bit
        // dropping in buildDatagram) — no chargeMs, no world-main-action
        // dispatch. Clear holdState too in case a weapon swap crossed the
        // aim/normal boundary mid-hold (rare, but must not strand ChargeBar
        // showing a phantom charge).
        holdState.value = { lmb: null };
      } else {
        // Normal mode: emit world-main-action with charged duration.
        const held = holdState.value.lmb;
        holdState.value = { lmb: null };
        if (gameOwnsMouse && held && !targetIsInteractiveUI(e.target)) {
          const chargeMs = Math.max(0, Math.round(e.t - held.downAtMs));
          this.pendingChargeMs = chargeMs;
          this.pendingActions |= ACTION_USE_SKILL;
          this.router.dispatch({ kind: "world-main-action", chargeMs, hover: hoverState.value });
        }
      }
    }

    if (e.button === 2) {
      this.rmbDown = false;
      if (gameOwnsMouse) {
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
  }

  // ---- per-frame datagram --------------------------------------------------

  /** Called once per frame by the game loop. */
  buildDatagram(seq: number, tick: number): MovementDatagram {
    // Movement is FACING-relative (T-328): W = forward along facing, S =
    // back-pedal, A/D = strafe perpendicular to facing WHILE STILL FACING
    // the same heading — the character can finally circle a target while
    // looking at it. Facing itself is mouse-driven (`applyLookDelta`, fed by
    // pointer lock) and re-sampled every input frame; it does NOT come from
    // this movement vector anymore (that was T-320's rule — deleted).
    const fwdX =  Math.cos(this._facing);
    const fwdY =  Math.sin(this._facing);
    // Strafe-right is facing-forward × world-up; for this steeply-angled rig
    // that resolves to the math-CCW perpendicular (-sin, cos), so pressing D
    // strafes to the character's right.
    const rgtX = -Math.sin(this._facing);
    const rgtY =  Math.cos(this._facing);

    let movX = 0, movY = 0;
    if (this.isHeld("moveForward")) { movX += fwdX; movY += fwdY; }
    if (this.isHeld("moveBack"))    { movX -= fwdX; movY -= fwdY; }
    if (this.isHeld("moveLeft"))    { movX -= rgtX; movY -= rgtY; }
    if (this.isHeld("moveRight"))   { movX += rgtX; movY += rgtY; }

    const len = Math.sqrt(movX * movX + movY * movY);
    if (len > 0) { movX /= len; movY /= len; }

    let held = 0;
    if (this.isHeld("crouch")) held |= ACTION_CROUCH;
    if (this.isHeld("block"))  held |= ACTION_BLOCK;
    // No-hammer normal mode: RMB held re-emits ACTION_BLOCK every frame so
    // the server-side block stays active.
    if (!this.buildMode && this.rmbDown) held |= ACTION_BLOCK;
    // T-337: a hold-to-aim weapon reads ACTION_USE_SKILL as a HELD bit every
    // frame while its trigger (LMB or the `useSkill` binding) stays down —
    // gated on `aimWeaponActive` so every OTHER weapon's one-shot
    // tap-on-release semantics (below, `pendingActions`) are byte-for-byte
    // unchanged.
    if (this.isAiming) held |= ACTION_USE_SKILL;

    const actions = this.pendingActions | held;
    this.pendingActions = 0;
    const chargeMs = this.pendingChargeMs;
    this.pendingChargeMs = 0;

    return {
      seq,
      tick,
      timestamp: Date.now(),
      facing: this._facing,
      pitch: this._aimPitch,
      movementX: movX,
      movementY: movY,
      actions,
      chargeMs,
    };
  }

  // ---- accessors ---------------------------------------------------------

  get mouseX(): number { return this.mouseCanvasX; }
  get mouseY(): number { return this.mouseCanvasY; }

  /** Mouse-driven facing (radians, T-328). The local, un-round-tripped value
   *  the renderer applies to the local mesh for predicted body rotation AND
   *  feeds into the camera rig's yaw each frame (`cameraRig.setYaw`). */
  get facing(): number { return this._facing; }
}
