/**
 * Game component definitions for the tile server.
 *
 * All networked components use the shared codecs from @voxim/codecs so
 * client and server agree on the binary format by construction. This file
 * pairs each codec with a ComponentDef (wireId, schema, default); no codec
 * logic lives inline.
 */
import { defineComponent } from "@voxim/engine";
import { ComponentType } from "@voxim/protocol";
import * as v from "valibot";
import {
  positionCodec, velocityCodec, facingCodec,
  inputStateCodec, healthCodec, hungerCodec, thirstCodec, lifetimeCodec,
  staminaCodec, modelRefCodec, animationStateCodec,
} from "@voxim/codecs";
import type {
  PositionData, VelocityData, FacingData,
  InputStateData, HealthData, HungerData, ThirstData, LifetimeData,
  StaminaData, ModelRefData, AnimationStateData,
} from "@voxim/codecs";

// ---- re-exported shared types for convenience ----
export type {
  PositionData, VelocityData, FacingData,
  InputStateData, HealthData, HungerData, ThirstData, LifetimeData,
  StaminaData,
};

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

export const InputState = defineComponent({
  name: "inputState" as const,
  wireId: ComponentType.inputState,
  codec: inputStateCodec,
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

const healthSchema = v.object({
  current: v.number(),
  max: v.number(),
});

export const Health = defineComponent({
  name: "health" as const,
  wireId: ComponentType.health,
  codec: healthCodec,
  schema: healthSchema,
  default: (): HealthData => ({ current: 100, max: 100 }),
});

// ---- Hunger ---- 0 (full) → 100 (starving)

const hungerSchema = v.object({
  value: v.number(),
});

export const Hunger = defineComponent({
  name: "hunger" as const,
  wireId: ComponentType.hunger,
  codec: hungerCodec,
  schema: hungerSchema,
  default: (): HungerData => ({ value: 0 }),
});

// ---- Thirst ---- 0 (sated) → 100 (parched)

const thirstSchema = v.object({
  value: v.number(),
});

export const Thirst = defineComponent({
  name: "thirst" as const,
  wireId: ComponentType.thirst,
  codec: thirstCodec,
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

// ---- Lifetime ---- remaining ticks; entity is destroyed when this reaches 0

export const Lifetime = defineComponent({
  name: "lifetime" as const,
  wireId: ComponentType.lifetime,
  codec: lifetimeCodec,
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
