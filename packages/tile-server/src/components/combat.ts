/**
 * Combat components — per-entity state that only exists while an entity is
 * in a specific combat condition.
 *
 * All components in this file follow the "component presence as flag" rule:
 * the component exists iff the state is active. Absence is the zero state.
 * Never written at spawn.
 *
 *   CounterReady     — parried an attack and has a bonus-damage window open
 *                      (networked: future UI indicator).
 *   BlockHeld        — counts ticks since ACTION_BLOCK became held
 *                      (server-only: parry-window detection).
 *
 * Stagger is no longer a component here — it's the `stagger_light` /
 * `stagger_heavy` reaction actions (phase duration = stagger window) plus
 * the `staggered` tag (components/tags.ts) for the action-lockout; the
 * client renders it from the networked reaction-slot AnimationState (T-232).
 *
 * Dodge invulnerability is the `iframe` tag installed by the `dodge_roll`
 * action's dash phase (see components/tags.ts); the retired IFrameActive /
 * DodgeCooldown countdowns are gone with the dodge migration (T-229).
 */
import { defineComponent } from "@voxim/engine";
import { buildCodec } from "@voxim/codecs";
import type { Serialiser } from "@voxim/engine";
import { ComponentType } from "@voxim/protocol";
import {
  WireWriter, WireReader,
  counterReadyCodec,
} from "@voxim/codecs";
import type { CounterReadyData } from "@voxim/codecs";

// ---- CounterReady (networked, zero-payload marker) ------------------------

export const CounterReady = defineComponent({
  name: "counterReady" as const,
  wireId: ComponentType.counterReady,
  codec: counterReadyCodec,
  default: (): CounterReadyData => ({}),
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
