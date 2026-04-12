import { defineComponent } from "@voxim/engine";
import { ComponentType } from "@voxim/protocol";
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
  wireId: ComponentType.worldClock,
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
  wireId: ComponentType.tileCorruption,
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
  wireId: ComponentType.corruptionExposure,
  codec: buildCodec<CorruptionExposureData>({ level: { type: "f32" } }),
  default: (): CorruptionExposureData => ({ level: 0 }),
});

// ---- SpeedModifier ----
// Composed speed multiplier written exclusively by BuffSystem each tick.
// BuffSystem multiplies EncumbrancePenalty (base) × all speed ActiveEffects.
// PhysicsSystem reads this as the final maxGroundSpeed multiplier.
// Nothing else should write SpeedModifier directly.

export interface SpeedModifierData {
  multiplier: number;
}

export const SpeedModifier = defineComponent({
  name: "speedModifier" as const,
  codec: buildCodec<SpeedModifierData>({ multiplier: { type: "f32" } }),
  default: (): SpeedModifierData => ({ multiplier: 1.0 }),
  networked: false,
});

// ---- EncumbrancePenalty ----
// Written each tick by EncumbranceSystem based on carried weight.
// Value 1.0 = no penalty. Lower = slowed by overloading.
// Read by BuffSystem which multiplies speed buffs on top of this base.

export interface EncumbrancePenaltyData {
  multiplier: number;
}

export const EncumbrancePenalty = defineComponent({
  name: "encumbrancePenalty" as const,
  codec: buildCodec<EncumbrancePenaltyData>({ multiplier: { type: "f32" } }),
  default: (): EncumbrancePenaltyData => ({ multiplier: 1.0 }),
  networked: false,
});
