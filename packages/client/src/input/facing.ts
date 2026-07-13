/**
 * Facing derivation (T-328): mouse-X directly rotates the player's FACING
 * under pointer lock — `facing += dxPixels * sensitivity`, wrapped into
 * (-π, π] so a continuous turn never discontinuities. IntentTranslator
 * accumulates this every look event (the same raw pointer-lock deltas
 * T-324/T-324b already deliver); the camera yaw derives from the result
 * (see camera_rig.ts `setYaw`) instead of the other way around.
 *
 * Supersedes T-320's `facingFromMove` (facing = movement direction): that
 * rule made it impossible to strafe around a target while looking at it,
 * since facing WAS the movement direction. Movement is now transformed by
 * the facing basis instead (see intent_translator.ts `buildDatagram`).
 *
 * Pure so the wrap contract is deterministically testable — this is also
 * where T-324's "dense sweep must never snap" regression pin now lives,
 * since wrap ownership moved here with the accumulator.
 */

/** Wrap an angle into (-π, π]. */
function wrapPi(a: number): number {
  const t = ((a + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
  return t - Math.PI;
}

export function facingFromLook(prev: number, dxPixels: number, sensitivity: number): number {
  return wrapPi(prev + dxPixels * sensitivity);
}
