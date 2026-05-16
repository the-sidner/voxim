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

// TileCorruption (24) + CorruptionExposure (25) retired here (T-238e):
// the corruption mechanic was removed wholesale, to be reintroduced later
// at a different scale. Wire ids 24/25 are reserved in component_types.ts.

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
