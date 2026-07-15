/// <reference lib="dom" />
/**
 * CameraRig — controller-native third-person camera (T-320; rotation
 * ownership inverted by T-328).
 *
 * Geometry: `backDistance` behind the player (along yaw), `heightAbove` above
 * the ground, looking at a point `lookAtBias` metres above the player root,
 * with a `fovDeg` telephoto lens. All four are game_config `camera.*` knobs so
 * the framing (top-down tactical vs. a lower, closer over-the-shoulder feel)
 * is pure content tuning. At the REST pitch the gaze angle below horizontal is
 * geometric: atan2(heightAbove − lookAtBias, backDistance) — ≈55° at the
 * shipped defaults, where a ~1.8m player occupies ~7% of vertical view and the
 * narrow telephoto FOV keeps the horizon out of frame even on rising terrain
 * (T-310 phase F: pushed-back long-lens framing flattens perspective into a
 * more cinematic look at the same on-screen player size).
 *
 * ── Yaw is DERIVED from facing (T-328) ──────────────────────────────────────
 * Mouse-X used to drive this rig's yaw directly (T-320); it now drives the
 * player's FACING instead (`IntentTranslator.applyLookDelta`, accumulated
 * from the same raw pointer-lock deltas). This rig no longer has a yaw
 * accumulator: `setYaw()` is called once per frame with the live facing
 * (renderer.render(), fed `localFacing`), and `getYaw()` is a pure read of
 * whatever was last set — the camera sits RIGIDLY behind the character's
 * heading, no damping/lag, because T-324 already proved any damping on this
 * axis reads as sluggish. Movement is transformed by the facing basis too
 * (intent_translator.ts), so this is a true rigid coupling: camera yaw,
 * player facing, and the movement basis are all the same number.
 *
 * Yaw 0 means the camera looks toward +X in game coords (= Three.js +x).
 * Wrapping is owned upstream by facing.ts's `facingFromLook` — `setYaw` just
 * assigns.
 *
 * ── Clamped pitch (unchanged, camera-only) ─────────────────────────────────
 * Pitch still pans the gaze up/down directly from mouse-Y via
 * `applyLookDelta`, within a DELIBERATELY NARROW band around the shipped rest
 * gaze (`pitchMinDeg`/`pitchMaxDeg` about `pitchRestDeg`). The band is small
 * on purpose: a wide pitch would let the horizon flood in, which reopens the
 * fog / draw-distance / telephoto-flatness issues T-310 F closed. The
 * camera's offset-from-lookat vector is rotated rigidly in its vertical plane
 * by (pitch − rest), so at pitch == rest the framing is byte-identical to the
 * T-317 geometry (asserted in camera_rig.test.ts).
 */
import * as THREE from "three";
import { clamp } from "@voxim/engine";

// Boot value only: the yaw before the first frame's facing arrives (join
// screen, pre-spawn). setYaw() owns the yaw from the first render() call on.
const DEFAULT_YAW = Math.PI / 4;

/** Rig geometry + look feel (from game_config `camera.*`). */
export interface CameraConfig {
  /** Metres behind the player along the yaw direction (at rest pitch). */
  backDistance: number;
  /** Metres above the player's ground position (at rest pitch). */
  heightAbove: number;
  /** Look-at point this many metres above the player root. */
  lookAtBias: number;
  /** Vertical field of view in degrees (telephoto ≈34 at defaults). */
  fovDeg: number;
  /** Radians of pitch per look-delta pixel (mouse sensitivity) — the same
   *  value IntentTranslator's facing accumulator uses (T-328), so the two
   *  axes turn at the identical rate. */
  mouseSensitivity: number;
  /** When true, up-mouse pitches down (classic flight-stick invert). */
  invertY: boolean;
  /** Rest pitch in degrees below horizontal — reproduces the T-317 gaze. */
  pitchRestDeg: number;
  /** Lower clamp (degrees below horizontal) — smaller = flatter gaze. */
  pitchMinDeg: number;
  /** Upper clamp (degrees below horizontal) — larger = steeper top-down. */
  pitchMaxDeg: number;
}

/** Pre-bootstrap-only fallback (T-356) — one object mirroring
 *  data/game_config.json's shipped `camera.*` values exactly (previously 8
 *  hand-copied per-field literals that had drifted: mouseSensitivity sat at
 *  0.0022 here while game_config.json had moved to 0.011). Keeps the rig
 *  usable for the handful of frames before configure() installs the real
 *  GameConfig, and stays authoritative in the no-bootstrap-blob degraded
 *  path where configure() is never called. Mirrors PRE_BOOTSTRAP_GRADE
 *  (edge_pass.ts). */
export const PRE_BOOTSTRAP_CAMERA: CameraConfig = {
  backDistance: 23.6,
  heightAbove: 35.4,
  lookAtBias: 1.0,
  fovDeg: 34,
  mouseSensitivity: 0.011,
  invertY: false,
  pitchRestDeg: 55,
  pitchMinDeg: 45,
  pitchMaxDeg: 62,
};

export class CameraRig {
  readonly camera: THREE.PerspectiveCamera;

  private yaw = DEFAULT_YAW;
  private readonly _target = new THREE.Vector3();

  // Rig geometry + feel knobs, seeded from PRE_BOOTSTRAP_CAMERA (T-356);
  // configure() overwrites them from game_config once the content blob arrives.
  private backDistance = PRE_BOOTSTRAP_CAMERA.backDistance;
  private heightAbove  = PRE_BOOTSTRAP_CAMERA.heightAbove;
  private lookAtBias   = PRE_BOOTSTRAP_CAMERA.lookAtBias;
  private sensitivity  = PRE_BOOTSTRAP_CAMERA.mouseSensitivity; // rad per look pixel
  private invertY      = PRE_BOOTSTRAP_CAMERA.invertY;
  private pitchRestRad = PRE_BOOTSTRAP_CAMERA.pitchRestDeg * Math.PI / 180;
  private pitchMinRad  = PRE_BOOTSTRAP_CAMERA.pitchMinDeg * Math.PI / 180;
  private pitchMaxRad  = PRE_BOOTSTRAP_CAMERA.pitchMaxDeg * Math.PI / 180;

  /** Current gaze pitch below horizontal (radians). Seeded to rest. */
  private pitch = PRE_BOOTSTRAP_CAMERA.pitchRestDeg * Math.PI / 180;

  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(PRE_BOOTSTRAP_CAMERA.fovDeg, aspect, 0.1, 600);
  }

  /** Install the rig geometry + look feel from game_config. Idempotent. */
  configure(cfg: CameraConfig): void {
    this.backDistance = cfg.backDistance;
    this.heightAbove  = cfg.heightAbove;
    this.lookAtBias   = cfg.lookAtBias;
    this.sensitivity  = cfg.mouseSensitivity;
    this.invertY      = cfg.invertY;
    this.pitchRestRad = cfg.pitchRestDeg * Math.PI / 180;
    this.pitchMinRad  = cfg.pitchMinDeg * Math.PI / 180;
    this.pitchMaxRad  = cfg.pitchMaxDeg * Math.PI / 180;
    // Re-seat pitch into the (possibly new) band, keeping the same offset from
    // rest so a reconfigure mid-session doesn't jump the view.
    this.pitch = clamp(this.pitch, this.pitchMinRad, this.pitchMaxRad);
    if (this.camera.fov !== cfg.fovDeg) {
      this.camera.fov = cfg.fovDeg;
      this.camera.updateProjectionMatrix();
    }
  }

  resize(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  /** Camera yaw (radians). Since T-328 this is a pure READ of whatever was
   *  last fed via `setYaw()` — the rig has no yaw accumulator of its own. */
  getYaw(): number { return this.yaw; }
  getPitch(): number { return this.pitch; }

  /**
   * Set the camera's yaw directly from the player's facing (T-328). Call
   * once per frame before `update()` with the live facing value
   * (IntentTranslator owns the mouse-X accumulator) — rigid coupling, no
   * smoothing: the camera sits exactly behind the character's heading,
   * matching T-324's finding that any damping on this axis reads as
   * sluggish. `facing` is already wrapped into (-π, π] upstream (facing.ts).
   */
  setYaw(facing: number): void {
    this.yaw = facing;
  }

  /**
   * Apply a pitch-only look delta (pixels) — the clean input seam for
   * mouse-Y (pointer-lock movementY) and, later, a pad right-stick's
   * vertical axis. Pitch accumulates but is CLAMPED to the narrow band. Yaw
   * no longer accumulates here (T-328): mouse-X now drives the player's
   * FACING instead (`IntentTranslator.applyLookDelta`), and camera yaw is
   * derived from it via `setYaw`. A positive dy raises the gaze toward the
   * horizon (pitch decreases) unless `invertY`.
   */
  applyLookDelta(dyPixels: number): void {
    // Screen-up (negative dy in DOM movementY is up) should tilt the gaze up =
    // toward the horizon = a SMALLER pitch-below-horizontal. DOM movementY is
    // positive downward, so `+dy` (mouse down) increases pitch (steeper). This
    // is the non-inverted default; invertY flips it.
    const sign = this.invertY ? -1 : 1;
    this.pitch = clamp(
      this.pitch + sign * dyPixels * this.sensitivity,
      this.pitchMinRad,
      this.pitchMaxRad,
    );
  }

  /**
   * Reposition the camera from (yaw, pitch, geometry). The rest offset from the
   * look-at point sits `backDistance` back and `heightAbove − lookAtBias` up;
   * we rotate that offset rigidly in its vertical plane by (pitch − rest) so
   * the gaze pans while the look-at point stays pinned to the player's chest.
   * At pitch == rest this is byte-identical to the T-317 geometry.
   */
  update(targetPos: THREE.Vector3): void {
    // Look-at point: chest height above the player root.
    const lookY = targetPos.y + this.lookAtBias;
    this._target.set(targetPos.x, lookY, targetPos.z);

    // Rest offset from the look-at point, in the vertical plane spanned by the
    // horizontal back direction (−yaw) and world-up:
    //   horizontal = backDistance, vertical = heightAbove − lookAtBias.
    const horiz0 = this.backDistance;
    const vert0  = this.heightAbove - this.lookAtBias;

    // Rotate (horiz0, vert0) by the pitch delta about the look-at point.
    // A larger pitch (steeper gaze down) means the camera rises and pulls in
    // over the target, so we rotate the offset toward vertical.
    const dPitch = this.pitch - this.pitchRestRad;
    const c = Math.cos(dPitch);
    const s = Math.sin(dPitch);
    const horiz = horiz0 * c - vert0 * s;
    const vert  = horiz0 * s + vert0 * c;

    const cosY = Math.cos(this.yaw);
    const sinY = Math.sin(this.yaw);

    this.camera.position.set(
      this._target.x - cosY * horiz,
      lookY + vert,
      this._target.z - sinY * horiz,
    );
    this.camera.lookAt(this._target);
  }
}
