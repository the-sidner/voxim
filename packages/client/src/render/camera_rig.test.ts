/**
 * CameraRig is the T-320 free-look controller. The correctness weight is the
 * pure yaw/pitch math (accumulate, wrap, clamp, invert) plus the byte-stable
 * rest framing — the pointer-lock FEEL is un-headless and stays a manual pass.
 * These tests pin the math against injected look deltas and the shipped
 * game_config geometry, with the rest gaze asserted equal to the T-317
 * atan2(heightAbove − lookAtBias, backDistance) framing to 1e-9.
 */
import { assert, assertAlmostEquals } from "jsr:@std/assert";
import * as THREE from "three";
import { CameraRig, type CameraConfig } from "./camera_rig.ts";

// Shipped game_config.camera defaults (T-320).
const CFG: CameraConfig = {
  backDistance: 23.6,
  heightAbove: 35.4,
  lookAtBias: 1.0,
  fovDeg: 34,
  mouseSensitivity: 0.0022,
  invertY: false,
  pitchRestDeg: 55,
  pitchMinDeg: 45,
  pitchMaxDeg: 62,
};

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

  r.update(TARGET, 0);
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

Deno.test("applyLookDelta accumulates yaw by dx*sensitivity", () => {
  const r = rig();
  const y0 = r.getYaw();
  r.applyLookDelta(100, 0);
  assertAlmostEquals(r.getYaw(), y0 + 100 * CFG.mouseSensitivity, 1e-12);
  r.applyLookDelta(50, 0);
  assertAlmostEquals(r.getYaw(), y0 + 150 * CFG.mouseSensitivity, 1e-12);
});

Deno.test("yaw wraps into (-π, π]", () => {
  const r = rig();
  // Drive yaw well past π so wrapping is exercised.
  const pixelsForOneTurn = (2 * Math.PI) / CFG.mouseSensitivity;
  r.applyLookDelta(pixelsForOneTurn * 1.25, 0);
  assert(r.getYaw() > -Math.PI && r.getYaw() <= Math.PI, `yaw ${r.getYaw()} not wrapped`);
});

Deno.test("applyLookDelta rotates the camera around the target by the yaw delta", () => {
  const r = rig();
  r.update(TARGET, 0);
  const p0 = r.camera.position.clone();
  const quarterTurnPx = (Math.PI / 2) / CFG.mouseSensitivity;
  r.applyLookDelta(quarterTurnPx, 0);
  r.update(TARGET, 0);
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
  r.applyLookDelta(0, 1e6);
  assertAlmostEquals(r.getPitch(), CFG.pitchMaxDeg * Math.PI / 180, 1e-12);
  // Huge upward drag → clamps at pitchMin (flatter).
  r.applyLookDelta(0, -1e6);
  assertAlmostEquals(r.getPitch(), CFG.pitchMinDeg * Math.PI / 180, 1e-12);
});

Deno.test("invertY flips the pitch response sign", () => {
  const plain = rig();
  const inv = rig({ invertY: true });
  plain.applyLookDelta(0, 30);
  inv.applyLookDelta(0, 30);
  // Same-magnitude opposite-direction delta from the shared rest pitch.
  assertAlmostEquals(plain.getPitch() - CFG.pitchRestDeg * Math.PI / 180,
    -(inv.getPitch() - CFG.pitchRestDeg * Math.PI / 180), 1e-12);
});

Deno.test("pitching down raises and pulls the camera in over the target", () => {
  const r = rig();
  r.update(TARGET, 0);
  const rest = r.camera.position.clone();
  r.applyLookDelta(0, 500); // pitch toward pitchMax
  r.update(TARGET, 0);
  const steep = r.camera.position.clone();
  const horizRest = Math.hypot(rest.x - TARGET.x, rest.z - TARGET.z);
  const horizSteep = Math.hypot(steep.x - TARGET.x, steep.z - TARGET.z);
  assert(steep.y > rest.y, "steeper pitch should raise the camera");
  assert(horizSteep < horizRest, "steeper pitch should pull the camera in");
});
