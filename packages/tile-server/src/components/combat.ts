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

// ---- Rolling (server-only) ------------------------------------------------
//
// Present for the duration of a dodge roll. Locks horizontal velocity to
// (vx, vy), bypasses input-driven physics, and signals AnimationSystem to
// emit a roll-style locomotion layer.

export interface RollingData {
  vx: number;
  vy: number;
  ticksRemaining: number;
}

const rollingCodec: Serialiser<RollingData> = {
  encode(v: RollingData): Uint8Array {
    const w = new WireWriter();
    w.writeF32(v.vx);
    w.writeF32(v.vy);
    w.writeU8(v.ticksRemaining);
    return w.toBytes();
  },
  decode(bytes: Uint8Array): RollingData {
    const r = new WireReader(bytes);
    return { vx: r.readF32(), vy: r.readF32(), ticksRemaining: r.readU8() };
  },
};

export const Rolling = defineComponent({
  name: "rolling" as const,
  networked: false,
  codec: rollingCodec,
  default: (): RollingData => ({ vx: 0, vy: 0, ticksRemaining: 0 }),
});
