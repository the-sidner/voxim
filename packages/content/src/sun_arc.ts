/**
 * sun_arc (T-311 P5a) — pure, dependency-free sun altitude/azimuth/direction as
 * a function of the server's `WorldClock` time-of-day fraction. Mirrors
 * `field_expr.ts`'s doctrine: no THREE, no client/server coupling, just a
 * closed-form function content authors tune via `SunArcParams` and any future
 * server caller can reuse (today only the client calls it, per the "wire
 * carries data, client derives presentation" decision — see AtmosphereDef).
 *
 * `timeOfDay01` uses the SAME convention as
 * `packages/tile-server/src/components/world.ts`'s `timeOfDay()`:
 * 0/1 = midnight, 0.25 = dawn, 0.5 = noon, 0.75 = dusk — the identical
 * boundaries `game_config.json`'s `dayNight` block and `worldClockPhase()`
 * (client-side day-phase bucket) already use, so the arc's anchors agree with
 * the existing discrete-phase system rather than inventing a second clock.
 */

/** Authored sun-path shape for one AtmosphereDef. */
export interface SunArcParams {
  /** Azimuth (degrees, 0 = +X/world-east-ish, sweeps toward +Z) at dawn (t=0.25). */
  dawnAzimuthDeg: number;
  /** Azimuth (degrees) at dusk (t=0.75). */
  duskAzimuthDeg: number;
  /** Peak altitude (degrees above horizon) at solar noon (t=0.5). */
  maxAltitudeDeg: number;
  /** How far below the horizon the sun dips at midnight (degrees; positive). */
  nightDepthDeg: number;
}

export interface SunArcResult {
  /** Degrees above (positive) or below (negative) the horizon. */
  altitudeDeg: number;
  /** Degrees, dawn→dusk sweep (see SunArcParams). */
  azimuthDeg: number;
  /** Normalized direction FROM the world origin TOWARD the sun (y-up),
   *  the same convention `environment_lighting.ts`'s old fixed `SUN_DIR`
   *  used — plain numbers so this module stays THREE-free. */
  dir: { x: number; y: number; z: number };
}

/** timeOfDay01 fraction → [0,1], same wrap `WorldClock`'s ticksElapsed uses. */
export function timeOfDay01(ticksElapsed: number, dayLengthTicks: number): number {
  return ((ticksElapsed % dayLengthTicks) + dayLengthTicks) % dayLengthTicks / dayLengthTicks;
}

const DEG2RAD = Math.PI / 180;

/**
 * Sun altitude/azimuth/direction for a given time-of-day fraction.
 *
 * Altitude: a single cosine arc over the full day, peaking at `maxAltitudeDeg`
 * at noon (t=0.5) and troughing at `-nightDepthDeg` at midnight (t=0/1) —
 * continuous and smooth across the midnight wrap by construction (cosine of a
 * phase-shifted, wrapped angle).
 *
 * Azimuth: sweeps linearly from `dawnAzimuthDeg` to `duskAzimuthDeg` across
 * the daylight half (t: 0.25→0.75) and mirrors back across the night half
 * (t: 0.75→1.25, wrapped), so the sweep is continuous at both the dawn and
 * midnight seams — no snap-back discontinuity.
 */
export function sunArc(timeOfDay01: number, params: SunArcParams): SunArcResult {
  const t = ((timeOfDay01 % 1) + 1) % 1;

  // Altitude: cosine centred on noon (t=0.5), one full cycle per day.
  // phase=0 at t=0.5 (noon, peak) and phase=π at t=0 / t=1 (midnight, trough).
  const phase = (t - 0.5) * 2 * Math.PI;
  const alt01 = (Math.cos(phase) + 1) / 2; // 1 at noon, 0 at midnight
  const altitudeDeg = params.nightDepthDeg * -1 + alt01 * (params.maxAltitudeDeg + params.nightDepthDeg);

  // Azimuth: piecewise-linear sweep, mirrored across day/night halves so both
  // seams (t=0.25 dawn, t=0.75/wrap-to-1.25 midnight) are continuous.
  const span = params.duskAzimuthDeg - params.dawnAzimuthDeg;
  let azimuthDeg: number;
  if (t >= 0.25 && t <= 0.75) {
    // Daylight half: dawn → dusk, linear.
    const u = (t - 0.25) / 0.5;
    azimuthDeg = params.dawnAzimuthDeg + span * u;
  } else {
    // Night half: dusk → dawn (mirror of the day sweep, continuing the arc
    // "under the world" so it re-enters at dawn's azimuth next morning).
    const tt = t < 0.25 ? t + 1 : t; // unwrap so 0.75→1.25 is monotonic
    const u = (tt - 0.75) / 0.5;
    azimuthDeg = params.duskAzimuthDeg + span * u;
  }

  const altRad = altitudeDeg * DEG2RAD;
  const azRad = azimuthDeg * DEG2RAD;
  const horiz = Math.cos(altRad);
  const dir = {
    x: horiz * Math.cos(azRad),
    y: Math.sin(altRad),
    z: horiz * Math.sin(azRad),
  };
  // Normalize (horiz/altitude trig already puts this near unit length, but
  // guard against float drift so consumers can trust |dir| == 1).
  const len = Math.sqrt(dir.x * dir.x + dir.y * dir.y + dir.z * dir.z) || 1;
  dir.x /= len; dir.y /= len; dir.z /= len;

  return { altitudeDeg, azimuthDeg, dir };
}
