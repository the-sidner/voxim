/**
 * Game-specific component definitions for the tile server.
 *
 * Shared geometric components (Position, Velocity, Facing) use the codecs from
 * @voxim/codecs so the same binary format is used server-side and client-side.
 * Game-logic components (Health, Hunger, InputState, etc.) are defined here.
 */
import { defineComponent } from "@voxim/engine";
import { ComponentType } from "@voxim/protocol";
import * as v from "valibot";
import {
  positionCodec, velocityCodec, facingCodec, buildCodec,
  staminaCodec, combatStateCodec, modelRefCodec, animationStateCodec,
} from "@voxim/codecs";
import type { PositionData, VelocityData, FacingData, StaminaData, CombatStateData, ModelRefData, AnimationStateData } from "@voxim/codecs";

// ---- re-exported shared types for convenience ----
export type { PositionData, VelocityData, FacingData, StaminaData, CombatStateData };

// Re-export content types that other files import from here
export type { ModelRefData, AnimationStateData };

// ---- shared geometric components ----

export const Position = defineComponent({
  name: "position" as const,
  wireId: ComponentType.position,
  codec: positionCodec,
  default: (): PositionData => ({ x: 256, y: 256, z: 4.0 }), // tile centre, default terrain height
});

export const Velocity = defineComponent({
  name: "velocity" as const,
  wireId: ComponentType.velocity,
  codec: velocityCodec,
  default: (): VelocityData => ({ x: 0, y: 0, z: 0 }),
});

export const Facing = defineComponent({
  name: "facing" as const,
  wireId: ComponentType.facing,
  codec: facingCodec,
  default: (): FacingData => ({ angle: 0 }),
});

// ---- InputState ----
// Written immediately at tick start from the drained input ring buffer.
// Not deferred — it is the stimulus for the tick, not an output of it.
// All other systems read this as "what the player (or NPC AI) intends this tick."

export interface InputStateData {
  facing: number;     // radians — replicated to Facing component at end of tick
  movementX: number;  // normalised horizontal, -1..1
  movementY: number;
  actions: number;    // bitfield (ACTION_* from @voxim/protocol)
  seq: number;        // last drained input sequence — echoed in StateMessage.ackInputSeq
  /** Client wall-clock (ms) from the originating MovementDatagram. */
  timestamp: number;
  /** Exponential moving average of round-trip time in ms, maintained per session. */
  rttMs: number;
}

export const InputState = defineComponent({
  name: "inputState" as const,
  wireId: ComponentType.inputState,
  codec: buildCodec<InputStateData>({
    facing: { type: "f32" },
    movementX: { type: "f32" },
    movementY: { type: "f32" },
    actions: { type: "i32" },
    seq: { type: "i32" },
    timestamp: { type: "f64" },
    rttMs: { type: "f32" },
  }),
  default: (): InputStateData => ({
    facing: 0,
    movementX: 0,
    movementY: 0,
    actions: 0,
    seq: 0,
    timestamp: 0,
    rttMs: 0,
  }),
});

// ---- Health ----

export interface HealthData {
  current: number;
  max: number;
}

const healthSchema = v.object({
  current: v.number(),
  max: v.number(),
});

export const Health = defineComponent({
  name: "health" as const,
  wireId: ComponentType.health,
  codec: buildCodec<HealthData>({ current: { type: "f32" }, max: { type: "f32" } }),
  schema: healthSchema,
  default: (): HealthData => ({ current: 100, max: 100 }),
});

// ---- Hunger ---- 0 (full) → 100 (starving)

export interface HungerData {
  value: number;
}

const hungerSchema = v.object({
  value: v.number(),
});

export const Hunger = defineComponent({
  name: "hunger" as const,
  wireId: ComponentType.hunger,
  codec: buildCodec<HungerData>({ value: { type: "f32" } }),
  schema: hungerSchema,
  default: (): HungerData => ({ value: 0 }),
});

// ---- Thirst ---- 0 (sated) → 100 (parched)

export interface ThirstData {
  value: number;
}

const thirstSchema = v.object({
  value: v.number(),
});

export const Thirst = defineComponent({
  name: "thirst" as const,
  wireId: ComponentType.thirst,
  codec: buildCodec<ThirstData>({ value: { type: "f32" } }),
  schema: thirstSchema,
  default: (): ThirstData => ({ value: 0 }),
});

// ---- Stamina ---- 0 (exhausted) → max (full)

const staminaSchema = v.object({
  current: v.number(),
  max: v.number(),
  regenPerSecond: v.number(),
  exhausted: v.boolean(),
});

export const Stamina = defineComponent({
  name: "stamina" as const,
  wireId: ComponentType.stamina,
  codec: staminaCodec,
  schema: staminaSchema,
  default: (): StaminaData => ({ current: 100, max: 100, regenPerSecond: 8, exhausted: false }),
});

// ---- CombatState ---- per-entity combat lifecycle counters

const combatStateSchema = v.object({
  blockHeldTicks: v.number(),
  staggerTicksRemaining: v.number(),
  counterReady: v.boolean(),
  iFrameTicksRemaining: v.number(),
  dodgeCooldownTicks: v.number(),
});

export const CombatState = defineComponent({
  name: "combatState" as const,
  wireId: ComponentType.combatState,
  codec: combatStateCodec,
  schema: combatStateSchema,
  default: (): CombatStateData => ({
    blockHeldTicks: 0,
    staggerTicksRemaining: 0,
    counterReady: false,
    iFrameTicksRemaining: 0,
    dodgeCooldownTicks: 0,
  }),
});

// ---- Lifetime ---- remaining ticks; entity is destroyed when this reaches 0

export interface LifetimeData {
  ticks: number;
}

export const Lifetime = defineComponent({
  name: "lifetime" as const,
  wireId: ComponentType.lifetime,
  codec: buildCodec<LifetimeData>({ ticks: { type: "i32" } }),
  default: (): LifetimeData => ({ ticks: 0 }),
});

// ---- ModelRef ---- which model template this entity renders as (client-side only)

export const ModelRef = defineComponent({
  name: "modelRef" as const,
  wireId: ComponentType.modelRef,
  codec: modelRefCodec,
  default: (): ModelRefData => ({ modelId: "human_base", scaleX: 0.35, scaleY: 0.35, scaleZ: 0.35, seed: 0 }),
});

// ---- AnimationState ---- current animation mode; written by AnimationSystem each tick

export const AnimationState = defineComponent({
  name: "animationState" as const,
  wireId: ComponentType.animationState,
  codec: animationStateCodec,
  default: (): AnimationStateData => ({
    layers: [],
    weaponActionId: "",
    ticksIntoAction: 0,
  }),
});
