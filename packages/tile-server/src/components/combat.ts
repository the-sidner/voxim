/**
 * Combat components — per-entity state that only exists while an entity is
 * in a specific combat condition.
 *
 * All components in this file follow the "component presence as flag" rule:
 * the component exists iff the state is active. Absence is the zero state.
 * Never written at spawn.
 *
 *   Staggered        — interrupted after a successful parry (networked: the
 *                      client wants to render stagger animation).
 *   CounterReady     — parried an attack and has a bonus-damage window open
 *                      (networked: future UI indicator).
 *   IFrameActive     — invulnerable during a dodge (server-only: hit-reg
 *                      is server-authoritative).
 *   BlockHeld        — counts ticks since ACTION_BLOCK became held
 *                      (server-only: parry-window detection).
 *   DodgeCooldown    — dodge unavailable for N more ticks (server-only: the
 *                      client doesn't gate dodge input today).
 *
 * The retired SkillInProgress component is split between the CSM combat
 * layer (mode + timing) and the SwingContext component (gameplay payload).
 * See `swing_context.ts` and `character_state_machine.ts`.
 */
import { defineComponent } from "@voxim/engine";
import { buildCodec } from "@voxim/codecs";
import type { Serialiser } from "@voxim/engine";
import { ComponentType } from "@voxim/protocol";
import {
  WireWriter, WireReader,
  staggeredCodec, counterReadyCodec,
} from "@voxim/codecs";
import type { StaggeredData, CounterReadyData } from "@voxim/codecs";

// ---- Staggered (networked) ------------------------------------------------

export const Staggered = defineComponent({
  name: "staggered" as const,
  wireId: ComponentType.staggered,
  codec: staggeredCodec,
  default: (): StaggeredData => ({ ticksRemaining: 0 }),
});

// ---- CounterReady (networked, zero-payload marker) ------------------------

export const CounterReady = defineComponent({
  name: "counterReady" as const,
  wireId: ComponentType.counterReady,
  codec: counterReadyCodec,
  default: (): CounterReadyData => ({}),
});

// ---- IFrameActive (server-only) -------------------------------------------

export interface IFrameActiveData { ticksRemaining: number; }

const iFrameActiveCodec: Serialiser<IFrameActiveData> = {
  encode(v: IFrameActiveData): Uint8Array {
    const w = new WireWriter();
    w.writeU8(v.ticksRemaining);
    return w.toBytes();
  },
  decode(bytes: Uint8Array): IFrameActiveData {
    const r = new WireReader(bytes);
    return { ticksRemaining: r.readU8() };
  },
};

export const IFrameActive = defineComponent({
  name: "iFrameActive" as const,
  networked: false,
  codec: iFrameActiveCodec,
  default: (): IFrameActiveData => ({ ticksRemaining: 0 }),
});

// ---- BlockHeld (server-only) ----------------------------------------------

export interface BlockHeldData { ticks: number; }

const blockHeldCodec: Serialiser<BlockHeldData> = {
  encode(v: BlockHeldData): Uint8Array {
    const w = new WireWriter();
    w.writeU16(v.ticks);
    return w.toBytes();
  },
  decode(bytes: Uint8Array): BlockHeldData {
    const r = new WireReader(bytes);
    return { ticks: r.readU16() };
  },
};

export const BlockHeld = defineComponent({
  name: "blockHeld" as const,
  networked: false,
  codec: blockHeldCodec,
  default: (): BlockHeldData => ({ ticks: 0 }),
});

// ---- DodgeCooldown (server-only) ------------------------------------------

export interface DodgeCooldownData { ticksRemaining: number; }

const dodgeCooldownCodec: Serialiser<DodgeCooldownData> = {
  encode(v: DodgeCooldownData): Uint8Array {
    const w = new WireWriter();
    w.writeU8(v.ticksRemaining);
    return w.toBytes();
  },
  decode(bytes: Uint8Array): DodgeCooldownData {
    const r = new WireReader(bytes);
    return { ticksRemaining: r.readU8() };
  },
};

export const DodgeCooldown = defineComponent({
  name: "dodgeCooldown" as const,
  networked: false,
  codec: dodgeCooldownCodec,
  default: (): DodgeCooldownData => ({ ticksRemaining: 0 }),
});

// ---- Sidestep (server-only) -----------------------------------------------
//
// Present for the duration of a sidestep / short dash. Locks horizontal
// velocity to (vx, vy), bypasses input-driven physics so the dash plays
// out at its committed direction + speed, and signals the CSM locomotion
// layer to play the sidestep clip. Replaces the previous "dodge roll"
// mechanic (Rolling + sprinting_forward_roll); the new flow is a quick
// Vermintide-style hop with i-frames, not a long forward tumble.

export interface SidestepData {
  vx: number;
  vy: number;
  ticksRemaining: number;
}

const sidestepCodec: Serialiser<SidestepData> = {
  encode(v: SidestepData): Uint8Array {
    const w = new WireWriter();
    w.writeF32(v.vx);
    w.writeF32(v.vy);
    w.writeU8(v.ticksRemaining);
    return w.toBytes();
  },
  decode(bytes: Uint8Array): SidestepData {
    const r = new WireReader(bytes);
    return { vx: r.readF32(), vy: r.readF32(), ticksRemaining: r.readU8() };
  },
};

export const Sidestep = defineComponent({
  name: "sidestep" as const,
  networked: false,
  codec: sidestepCodec,
  default: (): SidestepData => ({ vx: 0, vy: 0, ticksRemaining: 0 }),
});

// ---- Airborne (server-only marker) ----------------------------------------
//
// Present iff the entity's feet are off the ground this tick. PhysicsSystem
// is the sole writer (computes from post-integration position vs terrain) and
// uses world.write so the same-tick CSM tick reads it without a one-frame
// lag. Empty payload — presence is the flag.

const emptyCodec: Serialiser<Record<string, never>> = {
  encode: () => new Uint8Array(),
  decode: () => ({}),
};

export const Airborne = defineComponent({
  name: "airborne" as const,
  networked: false,
  codec: emptyCodec,
  default: (): Record<string, never> => ({}),
});

// ---- Poise (server-only) --------------------------------------------------
//
// Stagger resource (T-197). Damage reduces `current`; when current ≤ 0 the
// hit handler fires `event.stagger.light` or `event.stagger.heavy` (chosen
// by damage overshoot) on the victim, resets current to max, and sets
// `regenDisabledTicks` so recovery is briefly suppressed before regen
// resumes.
//
// PoiseSystem ticks the regen and the disable countdown. Hit handlers are
// the only damage source. Server-only — the client renders the staggered
// state via the CSM reaction layer transition, so it doesn't need the raw
// poise value (until a poise bar UI lands; then this becomes networked).

export interface PoiseData {
  current: number;
  max: number;
  /** Ticks of regen suppression remaining. 0 = regen active. */
  regenDisabledTicks: number;
}

const poiseCodec: Serialiser<PoiseData> = buildCodec<PoiseData>({
  current:            { type: "f32" },
  max:                { type: "f32" },
  regenDisabledTicks: { type: "i32" },
});

export const Poise = defineComponent({
  name: "poise" as const,
  networked: false,
  codec: poiseCodec,
  default: (): PoiseData => ({ current: 50, max: 50, regenDisabledTicks: 0 }),
});
