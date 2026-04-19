/**
 * Combat components — per-entity state that only exists while an entity is
 * in a specific combat condition.
 *
 * All components in this file follow the "component presence as flag" rule:
 * the component exists iff the state is active. Absence is the zero state.
 * Never written at spawn.
 *
 *   SkillInProgress  — windup/active/winddown of a swing (server-only).
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
 */
import { defineComponent } from "@voxim/engine";
import type { Serialiser } from "@voxim/engine";
import { ComponentType } from "@voxim/protocol";
import {
  WireWriter, WireReader, WIRE_LIMITS,
  staggeredCodec, counterReadyCodec,
} from "@voxim/codecs";
import type { StaggeredData, CounterReadyData } from "@voxim/codecs";

/** A single hit record from a sweep — stores which entity and which body part was struck. */
export interface HitRecord {
  entityId: string;
  bodyPart: string;
}

export interface SkillInProgressData {
  weaponActionId: string;
  phase: "windup" | "active" | "winddown";
  ticksInPhase: number;
  hitEntities: HitRecord[];
  /**
   * Server tick to rewind to for lag-compensated hit detection.
   * -1 = not yet computed (set on first active tick from InputState.rttMs).
   * Stable across all ticks of the active phase so every hit in a multi-tick
   * active window is evaluated against the same historical snapshot.
   */
  rewindTick: number;
  pendingSkillVerb: string;
  /**
   * Weapon the swing was initiated with. Captured at swing-start so every
   * downstream phase (hit resolution, projectile spawn) derives stats from
   * the same weapon — a mid-swing equipment swap doesn't corrupt damage or
   * blade geometry. Empty string = unarmed.
   */
  weaponPrefabId: string;
  /** Quality (0–1) stamped on the weapon entity at swing start. 1 = unarmed. */
  weaponQuality: number;
}

const skillInProgressCodec: Serialiser<SkillInProgressData> = {
  encode(v: SkillInProgressData): Uint8Array {
    if (v.hitEntities.length > WIRE_LIMITS.hitRecordsPerSwing) {
      throw new Error(`[codec] SkillInProgress.hitEntities length ${v.hitEntities.length} exceeds wire cap ${WIRE_LIMITS.hitRecordsPerSwing}`);
    }
    const w = new WireWriter();
    w.writeStr(v.weaponActionId);
    w.writeStr(v.phase);
    w.writeU16(v.ticksInPhase);
    w.writeU16(v.hitEntities.length);
    for (const h of v.hitEntities) { w.writeStr(h.entityId); w.writeStr(h.bodyPart); }
    w.writeI32(v.rewindTick);
    w.writeStr(v.pendingSkillVerb);
    w.writeStr(v.weaponPrefabId);
    w.writeF32(v.weaponQuality);
    return w.toBytes();
  },
  decode(bytes: Uint8Array): SkillInProgressData {
    const r = new WireReader(bytes);
    const weaponActionId = r.readStr();
    const phase = r.readStr() as SkillInProgressData["phase"];
    const ticksInPhase = r.readU16();
    const count = r.readU16();
    const hitEntities: HitRecord[] = [];
    for (let i = 0; i < count; i++) hitEntities.push({ entityId: r.readStr(), bodyPart: r.readStr() });
    const rewindTick = r.readI32();
    const pendingSkillVerb = r.readStr();
    const weaponPrefabId = r.readStr();
    const weaponQuality = r.readF32();
    return { weaponActionId, phase, ticksInPhase, hitEntities, rewindTick, pendingSkillVerb, weaponPrefabId, weaponQuality };
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
    hitEntities: [] as HitRecord[],
    rewindTick: -1,
    pendingSkillVerb: "",
    weaponPrefabId: "",
    weaponQuality: 1,
  }),
});

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
