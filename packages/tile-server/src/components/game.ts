/**
 * Game-specific component definitions for the tile server.
 *
 * Shared geometric components (Position, Velocity, Facing) use the codecs from
 * @voxim/codecs so the same binary format is used server-side and client-side.
 * Game-logic components (Health, Hunger, InputState, etc.) are defined here.
 */
import { defineComponent } from "@voxim/engine";
import type { Serialiser } from "@voxim/engine"; // used by skillInProgressCodec
import {
  positionCodec, velocityCodec, facingCodec, buildCodec,
  staminaCodec, combatStateCodec, modelRefCodec, animationStateCodec,
  WireWriter, WireReader,
} from "@voxim/codecs";
import type { PositionData, VelocityData, FacingData, StaminaData, CombatStateData, ModelRefData, AnimationStateData } from "@voxim/codecs";

// ---- re-exported shared types for convenience ----
export type { PositionData, VelocityData, FacingData, StaminaData, CombatStateData };

// Re-export content types that other files import from here
export type { ModelRefData, AnimationStateData };

// ---- shared geometric components ----

export const Position = defineComponent({
  name: "position" as const,
  codec: positionCodec,
  default: (): PositionData => ({ x: 256, y: 256, z: 4.0 }), // tile centre, default terrain height
});

export const Velocity = defineComponent({
  name: "velocity" as const,
  codec: velocityCodec,
  default: (): VelocityData => ({ x: 0, y: 0, z: 0 }),
});

export const Facing = defineComponent({
  name: "facing" as const,
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
  /** Client wall-clock (ms) from the originating InputDatagram — used for RTT estimation. */
  timestamp: number;
  /**
   * General-purpose slot index accompanying an action.
   * TraderSystem: index into trader's listing array.
   * DynastySystem: index into learnedFragmentIds (externalise) or inventory slot (internalise).
   */
  interactSlot: number;
}

export const InputState = defineComponent({
  name: "inputState" as const,
  codec: buildCodec<InputStateData>({
    facing: { type: "f32" },
    movementX: { type: "f32" },
    movementY: { type: "f32" },
    actions: { type: "i32" },
    seq: { type: "i32" },
    timestamp: { type: "f64" },
    interactSlot: { type: "i32" },
  }),
  default: (): InputStateData => ({
    facing: 0,
    movementX: 0,
    movementY: 0,
    actions: 0,
    seq: 0,
    timestamp: 0,
    interactSlot: 0,
  }),
});

// ---- Health ----

export interface HealthData {
  current: number;
  max: number;
}

export const Health = defineComponent({
  name: "health" as const,
  codec: buildCodec<HealthData>({ current: { type: "f32" }, max: { type: "f32" } }),
  default: (): HealthData => ({ current: 100, max: 100 }),
});

// ---- Hunger ---- 0 (full) → 100 (starving)

export interface HungerData {
  value: number;
}

export const Hunger = defineComponent({
  name: "hunger" as const,
  codec: buildCodec<HungerData>({ value: { type: "f32" } }),
  default: (): HungerData => ({ value: 0 }),
});

// ---- Thirst ---- 0 (sated) → 100 (parched)

export interface ThirstData {
  value: number;
}

export const Thirst = defineComponent({
  name: "thirst" as const,
  codec: buildCodec<ThirstData>({ value: { type: "f32" } }),
  default: (): ThirstData => ({ value: 0 }),
});

// ---- Stamina ---- 0 (exhausted) → max (full)

export const Stamina = defineComponent({
  name: "stamina" as const,
  codec: staminaCodec,
  default: (): StaminaData => ({ current: 100, max: 100, regenPerSecond: 8, exhausted: false }),
});

// ---- SkillInProgress ---- present while an action (windup→active→winddown) is executing

export interface SkillInProgressData {
  weaponActionId: string;
  phase: "windup" | "active" | "winddown";
  ticksInPhase: number;
  hitEntities: string[];
  inputTimestamp: number;
  pendingSkillVerb: string;
}

const skillInProgressCodec: Serialiser<SkillInProgressData> = {
  encode(v: SkillInProgressData): Uint8Array {
    const w = new WireWriter();
    w.writeStr(v.weaponActionId);
    w.writeStr(v.phase);
    w.writeU16(v.ticksInPhase);
    w.writeU16(v.hitEntities.length);
    for (const id of v.hitEntities) w.writeStr(id);
    w.writeF64(v.inputTimestamp);
    w.writeStr(v.pendingSkillVerb);
    return w.toBytes();
  },
  decode(bytes: Uint8Array): SkillInProgressData {
    const r = new WireReader(bytes);
    const weaponActionId = r.readStr();
    const phase = r.readStr() as SkillInProgressData["phase"];
    const ticksInPhase = r.readU16();
    const count = r.readU16();
    const hitEntities: string[] = [];
    for (let i = 0; i < count; i++) hitEntities.push(r.readStr());
    const inputTimestamp = r.readF64();
    const pendingSkillVerb = r.readStr();
    return { weaponActionId, phase, ticksInPhase, hitEntities, inputTimestamp, pendingSkillVerb };
  },
};

export const SkillInProgress = defineComponent({
  name: "skillInProgress" as const,
  codec: skillInProgressCodec,
  networked: false,
  default: (): SkillInProgressData => ({
    weaponActionId: "unarmed",
    phase: "windup",
    ticksInPhase: 0,
    hitEntities: [],
    inputTimestamp: 0,
    pendingSkillVerb: "",
  }),
});

// ---- CombatState ---- per-entity combat lifecycle counters

export const CombatState = defineComponent({
  name: "combatState" as const,
  codec: combatStateCodec,
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
  codec: buildCodec<LifetimeData>({ ticks: { type: "i32" } }),
  default: (): LifetimeData => ({ ticks: 0 }),
});

// ---- ModelRef ---- which model template this entity renders as (client-side only)

export const ModelRef = defineComponent({
  name: "modelRef" as const,
  codec: modelRefCodec,
  default: (): ModelRefData => ({ modelId: "human_base", scaleX: 0.35, scaleY: 0.35, scaleZ: 0.35, seed: 0 }),
});

// ---- AnimationState ---- current animation mode; written by AnimationSystem each tick

export const AnimationState = defineComponent({
  name: "animationState" as const,
  codec: animationStateCodec,
  default: (): AnimationStateData => ({
    mode: "idle", attackStyle: "", windupTicks: 0, activeTicks: 0, winddownTicks: 0, ticksIntoAction: 0,
  }),
});
