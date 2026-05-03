/// <reference lib="dom" />
/**
 * CameraRig — fixed-yaw "PoE-with-perspective" camera.
 *
 * Geometry: BACK_DISTANCE behind the player (along yaw), HEIGHT_ABOVE above
 * the ground, looking at the player's chest. Yaw is fixed (no mouse control)
 * — the world has stable cardinal directions, like Path of Exile / Diablo.
 *
 * The downward gaze angle is geometric (atan2(HEIGHT - LOOK_AT_BIAS, BACK)
 * ≈ 54° below horizontal). Combined with a narrow FOV that keeps the
 * horizon out of frame even on rising terrain, this gives an "overview"
 * tactical feel while still rendering with depth.
 *
 * Yaw 0 means the camera looks toward +X in game coords (= Three.js +x).
 * Yaw π/4 (the default) preserves the old iso "look northeast" orientation.
 */
import * as THREE from "three";

// Geometry tuned so a ~1.8m player occupies ~7% of vertical view.
// Slant distance ≈ √(BACK² + (HEIGHT-LOOK_AT_BIAS)²) ≈ 35m.
// Gaze angle below horizontal ≈ atan2(HEIGHT-LOOK_AT_BIAS, BACK) ≈ 55°.
const BACK_DISTANCE = 20.0;
const HEIGHT_ABOVE  = 30.0;
const LOOK_AT_BIAS  = 1.0;   // look-at point this many metres above player root
const FOV_DEG       = 40;    // narrow FOV — compresses depth, keeps horizon hidden
const DEFAULT_YAW   = Math.PI / 4;  // "northeast" — matches the old iso direction

export class CameraRig {
  readonly camera: THREE.PerspectiveCamera;

  private yaw = DEFAULT_YAW;
  private readonly _target = new THREE.Vector3();

  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(FOV_DEG, aspect, 0.1, 600);
  }

  resize(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  getYaw(): number { return this.yaw; }

  /**
   * Reposition camera so it sits BACK_DISTANCE behind `targetPos` (along yaw)
   * and HEIGHT_ABOVE above it, looking at the player's chest.
   */
  update(targetPos: THREE.Vector3): void {
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
}
