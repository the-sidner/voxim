import { defineComponent } from "@voxim/engine";
import { buildCodec } from "@voxim/codecs";

// ---- WorldClock ----
// Singleton: exactly one entity per tile carries this component.
// Replicated to clients so they can render time-of-day visuals.

export interface WorldClockData {
  /** Total ticks elapsed since tile startup. Monotonically increasing. */
  ticksElapsed: number;
  /** Full day/night cycle length in ticks. Default 14400 = 12 real-time minutes at 20 Hz. */
  dayLengthTicks: number;
}

export const WorldClock = defineComponent({
  name: "worldClock" as const,
  codec: buildCodec<WorldClockData>({ ticksElapsed: { type: "i32" }, dayLengthTicks: { type: "i32" } }),
  default: (): WorldClockData => ({ ticksElapsed: 0, dayLengthTicks: 14400 }),
});

/** Time of day as a 0–1 fraction. 0.25 = dawn, 0.5 = noon, 0.75 = dusk, 0/1 = midnight. */
export function timeOfDay(clock: WorldClockData): number {
  return (clock.ticksElapsed % clock.dayLengthTicks) / clock.dayLengthTicks;
}

/** True during day phase (0.25–0.75). */
export function isDay(clock: WorldClockData): boolean {
  const t = timeOfDay(clock);
  return t >= 0.25 && t < 0.75;
}

// ---- TileCorruption ----
// Tile-level corruption level 0–100. Carried on the same world-state entity as WorldClock.
// Replicated to clients for visual effects (colour grading, particle density).

export interface TileCorruptionData {
  /** 0 = pristine, 100 = maximum corruption. */
  level: number;
}

export const TileCorruption = defineComponent({
  name: "tileCorruption" as const,
  codec: buildCodec<TileCorruptionData>({ level: { type: "f32" } }),
  default: (): TileCorruptionData => ({ level: 0 }),
});

// ---- CorruptionExposure ----
// Per-entity accumulated exposure to tile corruption. 0–100.
// Increases while the tile is corrupted, decays when the entity is in a clean area.

export interface CorruptionExposureData {
  level: number;
}

export const CorruptionExposure = defineComponent({
  name: "corruptionExposure" as const,
  codec: buildCodec<CorruptionExposureData>({ level: { type: "f32" } }),
  default: (): CorruptionExposureData => ({ level: 0 }),
});

// ---- SpeedModifier ----
// Multiplier on maxGroundSpeed for this entity this tick.
// Written by EncumbranceSystem; read by PhysicsSystem.
// Value 1.0 = no effect. Lower values slow the entity.

export interface SpeedModifierData {
  multiplier: number;
}

export const SpeedModifier = defineComponent({
  name: "speedModifier" as const,
  codec: buildCodec<SpeedModifierData>({ multiplier: { type: "f32" } }),
  default: (): SpeedModifierData => ({ multiplier: 1.0 }),
  networked: false,
});
