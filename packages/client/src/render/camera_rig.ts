/// <reference lib="dom" />
/**
 * CameraRig — mouse-facing third-person camera (T-317).
 *
 * Geometry: BACK_DISTANCE behind the player (along yaw), HEIGHT_ABOVE above
 * the ground, looking at the player's chest. Yaw is DYNAMIC: it chases the
 * local player's mouse-driven facing so a committed cursor flick swings the
 * camera naturally behind the new heading, while micro-aiming inside a
 * deadzone leaves the world dead still.
 *
 * The downward gaze angle is geometric (atan2(HEIGHT - LOOK_AT_BIAS, BACK)
 * ≈ 54° below horizontal). Combined with a narrow FOV that keeps the
 * horizon out of frame even on rising terrain, this gives an "overview"
 * tactical feel while still rendering with depth.
 *
 * Yaw 0 means the camera looks toward +X in game coords (= Three.js +x).
 *
 * ── Why the camera CHASES facing rather than deriving it ──────────────────
 * Facing is raw gameplay state (it goes on the wire), updated ONLY on real
 * mousemove events by raycasting the cursor pixel onto the ground plane
 * (world-pinned). The camera is presentation that lags toward it. This split
 * is load-bearing for stability: recomputing facing from the static cursor
 * pixel every frame, or making facing screen-relative, both create a
 * positive feedback loop where the yaw error never shrinks and the world
 * spins forever (see prompts/T-317 analysis). So facing is never smoothed or
 * touched by this controller — the controller only reads it as a target.
 *
 * ── Deadzone + hysteresis + damped spring + max rate ──────────────────────
 * Engage the chase only when the shortest-arc yaw error exceeds an OUTER
 * threshold; disengage when it falls below an INNER threshold. The
 * hysteresis band prevents boundary twitch when the cursor hovers near the
 * engage angle. While engaged, yaw moves toward the target with a
 * framerate-corrected critically-damped step, capped at a max angular rate
 * so a 150° flick swings smoothly rather than snapping. All four knobs live
 * in game_config `camera.*` (ContentStore doctrine — no hardcoded feel).
 */
import * as THREE from "three";

// Geometry tuned so a ~1.8m player occupies ~7% of vertical view.
// Slant distance ≈ √(BACK² + (HEIGHT-LOOK_AT_BIAS)²) ≈ 35m.
// Gaze angle below horizontal ≈ atan2(HEIGHT-LOOK_AT_BIAS, BACK) ≈ 55°.
// Telephoto framing (T-310, phase F): a narrower FOV with the camera pushed back
// proportionally (×1.18) keeps the player the same on-screen size and the same
// ~55° gaze, but flattens perspective into a more cinematic, "longer-lens" look.
const BACK_DISTANCE = 23.6;
const HEIGHT_ABOVE  = 35.4;
const LOOK_AT_BIAS  = 1.0;   // look-at point this many metres above player root
const FOV_DEG       = 34;    // narrower telephoto — flatter, more cinematic depth
// Boot value only: the yaw before the first facing target exists (join screen,
// pre-spawn). Once setFacingTarget() is fed a real facing, the controller owns
// the yaw entirely — this is never a resting orientation the camera returns to.
const DEFAULT_YAW   = Math.PI / 4;

/** Tuning for the yaw-follow controller (from game_config `camera.*`). */
export interface CameraFollowConfig {
  /** Seconds for the engaged chase to close half the remaining yaw error. */
  followHalfLife: number;
  /** Ceiling on angular yaw rate while chasing (degrees per second). */
  maxTurnRateDeg: number;
  /** Shortest-arc error (degrees) above which the chase engages. */
  deadzoneOuterDeg: number;
  /** Shortest-arc error (degrees) below which the chase disengages. */
  deadzoneInnerDeg: number;
}

/** Wrap an angle into (-π, π]. */
function wrapPi(a: number): number {
  const t = ((a + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
  return t - Math.PI;
}

export class CameraRig {
  readonly camera: THREE.PerspectiveCamera;

  private yaw = DEFAULT_YAW;
  /** Latest local predicted facing to chase; null before the player spawns. */
  private facingTarget: number | null = null;
  /** Hysteresis latch: true while actively chasing the target. */
  private engaged = false;
  private readonly _target = new THREE.Vector3();

  // Feel knobs (radians), defaulted so the rig is usable before config lands;
  // configure() overwrites them from game_config at boot.
  private halfLife    = 0.18;
  private maxTurnRate = Math.PI;         // rad/s
  private outerRad    = 20 * Math.PI / 180;
  private innerRad    = 4  * Math.PI / 180;

  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(FOV_DEG, aspect, 0.1, 600);
  }

  /** Install the tuned follow feel from game_config. Idempotent. */
  configure(cfg: CameraFollowConfig): void {
    this.halfLife    = cfg.followHalfLife;
    this.maxTurnRate = cfg.maxTurnRateDeg * Math.PI / 180;
    this.outerRad    = cfg.deadzoneOuterDeg * Math.PI / 180;
    this.innerRad    = cfg.deadzoneInnerDeg * Math.PI / 180;
  }

  resize(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  getYaw(): number { return this.yaw; }

  /**
   * Feed the LOCAL player's predicted facing (radians) for the camera to
   * chase. Pass null while there is no local player (join / pre-spawn) — the
   * yaw then holds at its boot value. Facing itself is never modified here.
   */
  setFacingTarget(facing: number | null): void {
    this.facingTarget = facing;
  }

  /**
   * Advance the yaw controller by `dt` seconds, then reposition the camera so
   * it sits BACK_DISTANCE behind `targetPos` (along the settled yaw) and
   * HEIGHT_ABOVE above it, looking at the player's chest.
   */
  update(targetPos: THREE.Vector3, dt: number): void {
    this.stepYaw(dt);

    this._target.set(targetPos.x, targetPos.y + LOOK_AT_BIAS, targetPos.z);

    const cosY = Math.cos(this.yaw);
    const sinY = Math.sin(this.yaw);

    this.camera.position.set(
      targetPos.x - cosY * BACK_DISTANCE,
      targetPos.y + HEIGHT_ABOVE,
      targetPos.z - sinY * BACK_DISTANCE,
    );
    this.camera.lookAt(this._target);
  }

  /**
   * Move `yaw` toward `facingTarget` under the deadzone/hysteresis/spring/
   * max-rate rules. No-op when there is no target (holds the boot yaw).
   */
  private stepYaw(dt: number): void {
    if (this.facingTarget === null || dt <= 0) return;

    const err = wrapPi(this.facingTarget - this.yaw);
    const absErr = Math.abs(err);

    // Hysteresis: engage past the outer threshold, disengage under the inner.
    if (this.engaged) {
      if (absErr <= this.innerRad) { this.engaged = false; return; }
    } else {
      if (absErr < this.outerRad) return;     // deadzone — hold still
      this.engaged = true;
    }

    // Critically-damped exponential step toward the target (framerate-corrected),
    // capped at the max angular rate so a hard flick swings rather than snaps.
    const alpha = 1 - Math.exp(-Math.LN2 / this.halfLife * dt);
    let step = err * alpha;
    const maxStep = this.maxTurnRate * dt;
    if (step > maxStep) step = maxStep;
    else if (step < -maxStep) step = -maxStep;

    this.yaw = wrapPi(this.yaw + step);
  }
}
