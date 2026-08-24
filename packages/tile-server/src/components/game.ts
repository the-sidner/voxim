/**
 * Game component definitions for the tile server.
 *
 * All networked components resolve their codec through networkedCodec()
 * from @voxim/protocol's CODEC_BY_WIREID — the one authoring site of the
 * wireId→codec pairing (T-349) — so client and server agree on the binary
 * format by construction. This file pairs each wireId with a ComponentDef
 * (schema, default); no codec logic lives inline — except InputState, which
 * is server-only, so its codec is defined here directly (per the CLAUDE.md
 * rule: inline codecs only for `networked: false` components).
 */
import { defineComponent } from "@voxim/engine";
import type { Serialiser } from "@voxim/engine";
import { ComponentType, networkedCodec } from "@voxim/protocol";
import * as v from "valibot";
import { buildCodec } from "@voxim/codecs";
import type {
  PositionData, VelocityData, FacingData,
  HealthData,
  ModelRefData, AnimationStateData, NameData,
} from "@voxim/codecs";

// ---- re-exported shared types for convenience ----
export type {
  PositionData, VelocityData, FacingData,
  HealthData,
  NameData,
};

// Re-export content types that other files import from here
export type { ModelRefData, AnimationStateData };

// ---- shared geometric components ----

export const Position = defineComponent({
  name: "position" as const,
  wireId: ComponentType.position,
  codec: networkedCodec<PositionData>(ComponentType.position),
  default: (): PositionData => ({ x: 256, y: 256, z: 4.0 }), // tile centre, default terrain height
});

export const Velocity = defineComponent({
  name: "velocity" as const,
  wireId: ComponentType.velocity,
  codec: networkedCodec<VelocityData>(ComponentType.velocity),
  default: (): VelocityData => ({ x: 0, y: 0, z: 0 }),
});

export const Facing = defineComponent({
  name: "facing" as const,
  wireId: ComponentType.facing,
  codec: networkedCodec<FacingData>(ComponentType.facing),
  default: (): FacingData => ({ angle: 0 }),
});

// ---- InputState ----
// Written immediately at tick start from the drained input ring buffer.
// Not deferred — it is the stimulus for the tick, not an output of it.
// All other systems read this as "what the player (or NPC AI) intends this tick."
//
// Server-only (T-250): it has no client consumer. A remote player's behaviour
// reaches clients as the networked AnimationState (derived from ActiveActions);
// the local client reconciles against `ackInputSeq`, not an echoed input
// component. It was in NETWORKED_DEFS but every writer uses `world.write`
// (immediate, bypasses the changeset), so it never produced a delta anyway —
// the "delivered via the reliable delta stream" claim was a phantom path.
// wire id 5 (inputState) stays reserved in component_types.ts.

export interface InputStateData {
  facing: number;
  /**
   * Aim pitch (T-337): elevation angle above horizontal, radians, 0 = level.
   * Mirrors MovementDatagram.pitch; NPCs never set this (no ranged aim today)
   * so it stays at the component default (0).
   */
  pitch: number;
  movementX: number;
  movementY: number;
  actions: number;
  /**
   * Duration the use-skill button was held before release, in milliseconds.
   * Written when ACTION_USE_SKILL is set on this tick; otherwise 0.
   * PrimaryIntentResolver reads it to pick the matching weapon action variant
   * from the equipped weapon's `swingable.heavyChargeMs` threshold.
   */
  chargeMs: number;
  seq: number;
  timestamp: number;
  rttMs: number;
}

export const inputStateCodec: Serialiser<InputStateData> = buildCodec<InputStateData>({
  facing: { type: "f32" },
  pitch: { type: "f32" },
  movementX: { type: "f32" },
  movementY: { type: "f32" },
  actions: { type: "i32" },
  chargeMs: { type: "i32" },
  seq: { type: "i32" },
  timestamp: { type: "f64" },
  rttMs: { type: "f32" },
});

export const InputState = defineComponent({
  name: "inputState" as const,
  networked: false,
  codec: inputStateCodec,
  default: (): InputStateData => ({
    facing: 0,
    // T-337: 0 = level aim. The honest default for both a fresh player
    // (before any MovementDatagram lands) and every NPC forever — NpcAiSystem
    // spreads the previously-read InputState on every write (never sets
    // `pitch` itself), so NPCs never aim ranged today and this default is
    // never overwritten for them.
    pitch: 0,
    movementX: 0,
    movementY: 0,
    actions: 0,
    chargeMs: 0,
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
  codec: networkedCodec<HealthData>(ComponentType.health),
  schema: healthSchema,
  default: (): HealthData => ({ current: 100, max: 100 }),
});

// (Hunger/Thirst/Stamina are Resources now — components/resource.ts,
// data/resources/{hunger,thirst,stamina}.json. Wire ids 7/8/9 retired in
// @voxim/protocol; never reuse. T-238b/c.)

// (Lifetime is a Resource now — components/resource.ts,
// data/resources/lifetime.json (cross@0 → destroy_self). Wire id 12
// retired in @voxim/protocol; never reuse. T-241.)

// ---- ModelRef ---- which model template this entity renders as (client-side only)

export const ModelRef = defineComponent({
  name: "modelRef" as const,
  wireId: ComponentType.modelRef,
  codec: networkedCodec<ModelRefData>(ComponentType.modelRef),
  default: (): ModelRefData => ({ modelId: "human_base", scaleX: 0.35, scaleY: 0.35, scaleZ: 0.35, seed: 0 }),
});

// ---- AnimationState ---- current animation mode; written by AnimationSystem each tick

/**
 * Wire-equality for AnimationState (T-363): every field is compared
 * verbatim EXCEPT a looping, fixed-rate layer's `time` — AnimationSystem
 * fully replaces this component every tick (world.set), so an idle actor's
 * breathing loop advanced its clip time by a real, non-epsilon amount every
 * single tick forever, the "clip-time advancing" churn source. The client
 * doesn't puppet a velocity-scaled or one-shot clip's `time` locally (no
 * local clock drives it — see renderer.ts), so those keep shipping exactly
 * as before; only a `loop: true` layer with a numeric `speedScale` is safe
 * to hold back, because `renderer.ts` extrapolates exactly that shape
 * locally from `mesh.lastAnimUpdateMs` (mirroring the existing
 * `ticksIntoAction`/`ticksInPhase` extrapolation pattern).
 */
function animationStateWireEqual(a: AnimationStateData, b: AnimationStateData): boolean {
  if (a.weaponActionId !== b.weaponActionId) return false;
  if (a.ticksIntoAction !== b.ticksIntoAction) return false;
  if (a.dissolutionPhase !== b.dissolutionPhase) return false;
  if (a.layers.length !== b.layers.length) return false;
  for (let i = 0; i < a.layers.length; i++) {
    const la = a.layers[i], lb = b.layers[i];
    if (la.clipId !== lb.clipId) return false;
    if (la.weight !== lb.weight) return false;
    if (la.blend !== lb.blend) return false;
    if (la.maskId !== lb.maskId) return false;
    if (la.speedScale !== lb.speedScale) return false;
    if (la.speedReference !== lb.speedReference) return false;
    if (la.loop !== lb.loop) return false;
    const clientExtrapolates = la.loop && typeof la.speedScale === "number";
    if (!clientExtrapolates && la.time !== lb.time) return false;
  }
  return true;
}

export const AnimationState = defineComponent({
  name: "animationState" as const,
  wireId: ComponentType.animationState,
  codec: networkedCodec<AnimationStateData>(ComponentType.animationState),
  default: (): AnimationStateData => ({
    layers: [],
    weaponActionId: "",
    ticksIntoAction: 0,
    dissolutionPhase: 0,
  }),
  wireEquals: animationStateWireEqual,
});

// ---- Name ---- display label rendered above the entity's head on the client.
// Players carry the login name supplied at handshake; NPCs carry their
// template's `displayName`. Empty string suppresses the label.

const nameSchema = v.object({
  value: v.string(),
});

export const Name = defineComponent({
  name: "name" as const,
  wireId: ComponentType.name,
  codec: networkedCodec<NameData>(ComponentType.name),
  schema: nameSchema,
  default: (): NameData => ({ value: "" }),
});
