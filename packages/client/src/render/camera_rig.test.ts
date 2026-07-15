/**
 * CameraRig is the T-320 third-person controller; T-328 inverted rotation
 * ownership so yaw is DERIVED from facing (`setYaw`, rigid coupling) instead
 * of accumulated from mouse-X directly. The correctness weight is the pure
 * pitch math (accumulate, clamp, invert) + the yaw derivation (setYaw tracks
 * exactly, no damping) + the byte-stable rest framing — the pointer-lock FEEL
 * is un-headless and stays a manual pass. Yaw's own accumulate/wrap math now
 * lives in facing.ts (facingFromLook) and is pinned there, including the
 * T-324 dense-sweep continuity regression.
 */
import { assert, assertAlmostEquals } from "jsr:@std/assert";
import * as THREE from "three";
import { CameraRig, PRE_BOOTSTRAP_CAMERA, type CameraConfig } from "./camera_rig.ts";

// Shipped game_config.camera defaults (T-320) — the single fallback constant
// (T-356), not a third hand-copied set of the same numbers.
const CFG: CameraConfig = PRE_BOOTSTRAP_CAMERA;

const rig = (over: Partial<CameraConfig> = {}): CameraRig => {
  const r = new CameraRig(16 / 9);
  r.configure({ ...CFG, ...over });
  return r;
};

const TARGET = new THREE.Vector3(10, 4, -7);

/** Gaze angle below horizontal (radians) of the camera looking at TARGET. */
function gazeBelowHorizontal(cam: THREE.PerspectiveCamera, lookAt: THREE.Vector3): number {
  const dir = new THREE.Vector3().subVectors(lookAt, cam.position);
  const horiz = Math.hypot(dir.x, dir.z);
  return Math.atan2(-dir.y, horiz); // +y down = looking down
}

Deno.test("rest pitch reproduces the T-317 framing byte-stable", () => {
  const r = rig();
  assertAlmostEquals(r.getPitch(), 55 * Math.PI / 180, 1e-12);

  r.update(TARGET);
  const lookAt = new THREE.Vector3(TARGET.x, TARGET.y + CFG.lookAtBias, TARGET.z);

  // T-317 geometry: camera backDistance behind (yaw), heightAbove above,
  // looking at chest → gaze = atan2(heightAbove − lookAtBias, backDistance).
  const expectedGaze = Math.atan2(CFG.heightAbove - CFG.lookAtBias, CFG.backDistance);
  assertAlmostEquals(gazeBelowHorizontal(r.camera, lookAt), expectedGaze, 1e-9);

  // And the exact camera position the old rig produced at yaw = π/4.
  const cosY = Math.cos(Math.PI / 4), sinY = Math.sin(Math.PI / 4);
  assertAlmostEquals(r.camera.position.x, TARGET.x - cosY * CFG.backDistance, 1e-9);
  assertAlmostEquals(r.camera.position.y, TARGET.y + CFG.heightAbove, 1e-9);
  assertAlmostEquals(r.camera.position.z, TARGET.z - sinY * CFG.backDistance, 1e-9);
});

Deno.test("T-328: setYaw makes getYaw() track the input exactly (rigid coupling, no damping)", () => {
  const r = rig();
  r.setYaw(1.23);
  assertAlmostEquals(r.getYaw(), 1.23, 1e-12);
  r.setYaw(-2.9);
  assertAlmostEquals(r.getYaw(), -2.9, 1e-12);
  // Camera yaw tracks facing EXACTLY on the very next read — no lag, no
  // partial step toward the target (T-324: any damping here reads sluggish).
  r.setYaw(Math.PI);
  assertAlmostEquals(r.getYaw(), Math.PI, 1e-12);
});

Deno.test("setYaw rotates the camera around the target by the yaw delta", () => {
  const r = rig();
  r.setYaw(0);
  r.update(TARGET);
  const p0 = r.camera.position.clone();
  r.setYaw(Math.PI / 2);
  r.update(TARGET);
  const p1 = r.camera.position.clone();
  // Horizontal distance to target is preserved; azimuth advanced by ~90°.
  const az = (p: THREE.Vector3) => Math.atan2(p.z - TARGET.z, p.x - TARGET.x);
  const d0 = Math.hypot(p0.x - TARGET.x, p0.z - TARGET.z);
  const d1 = Math.hypot(p1.x - TARGET.x, p1.z - TARGET.z);
  assertAlmostEquals(d1, d0, 1e-9);
  const dAz = ((az(p1) - az(p0)) + 2 * Math.PI) % (2 * Math.PI);
  assertAlmostEquals(dAz, Math.PI / 2, 1e-9);
});

Deno.test("pitch clamps at the configured band", () => {
  const r = rig();
  // Huge downward drag → clamps at pitchMax (steeper, larger below-horizontal).
  r.applyLookDelta(1e6);
  assertAlmostEquals(r.getPitch(), CFG.pitchMaxDeg * Math.PI / 180, 1e-12);
  // Huge upward drag → clamps at pitchMin (flatter).
  r.applyLookDelta(-1e6);
  assertAlmostEquals(r.getPitch(), CFG.pitchMinDeg * Math.PI / 180, 1e-12);
});

Deno.test("invertY flips the pitch response sign", () => {
  const plain = rig();
  const inv = rig({ invertY: true });
  // Small enough that neither direction hits the clamp band (rest 55° with
  // only 7° down / 10° up of headroom at the shipped 0.011 sensitivity).
  plain.applyLookDelta(10);
  inv.applyLookDelta(10);
  // Same-magnitude opposite-direction delta from the shared rest pitch.
  assertAlmostEquals(plain.getPitch() - CFG.pitchRestDeg * Math.PI / 180,
    -(inv.getPitch() - CFG.pitchRestDeg * Math.PI / 180), 1e-12);
});

Deno.test("pitching down raises and pulls the camera in over the target", () => {
  const r = rig();
  r.update(TARGET);
  const rest = r.camera.position.clone();
  r.applyLookDelta(500); // pitch toward pitchMax
  r.update(TARGET);
  const steep = r.camera.position.clone();
  const horizRest = Math.hypot(rest.x - TARGET.x, rest.z - TARGET.z);
  const horizSteep = Math.hypot(steep.x - TARGET.x, steep.z - TARGET.z);
  assert(steep.y > rest.y, "steeper pitch should raise the camera");
  assert(horizSteep < horizRest, "steeper pitch should pull the camera in");
});
