/**
 * TrainingDummy (T-327) — server-only marker + timing state for the
 * combat-feel tuning pipeline's practice target. Presence means "this
 * entity is a training dummy"; `TrainingDummySystem` is the sole reader
 * AND the sole writer of the two tracking fields below (a stimulus-style
 * component, like `NpcJobQueue` — no other system touches it).
 *
 * The dummy is made unkillable at the damage-application site
 * (`health_hit_handler.ts` floors its Health at 1 instead of 0 for any
 * entity carrying this component — DeathSystem's composed-lethal sweep
 * queries committed `Health.current <= 0`, so the floor has to happen
 * where damage is written, not after). `TrainingDummySystem` then heals it
 * back to full `healDelayTicks` ticks after the last observed hit, so a
 * fresh practice session doesn't need a respawn between swings.
 */
import { defineComponent } from "@voxim/engine";
import type { Serialiser } from "@voxim/engine";

export interface TrainingDummyData {
  /** Ticks after the last observed hit before Health snaps back to max. */
  healDelayTicks: number;
  /** Absolute server tick of the last observed decrease in Health.current. */
  lastHitTick: number;
  /** Health.current value TrainingDummySystem last observed — a tick-over-tick
   *  decrease is how it detects "a hit just landed" without subscribing to
   *  the DamageDealt event (which fires from inside the hit handler, a
   *  different system than this one advances in). */
  lastObservedHealth: number;
}

const trainingDummyCodec: Serialiser<TrainingDummyData> = {
  encode(v: TrainingDummyData): Uint8Array {
    const buf = new ArrayBuffer(12);
    const dv = new DataView(buf);
    dv.setUint32(0, v.healDelayTicks >>> 0, true);
    dv.setUint32(4, v.lastHitTick >>> 0, true);
    dv.setFloat32(8, v.lastObservedHealth, true);
    return new Uint8Array(buf);
  },
  decode(bytes: Uint8Array): TrainingDummyData {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return {
      healDelayTicks: dv.getUint32(0, true),
      lastHitTick: dv.getUint32(4, true),
      lastObservedHealth: dv.getFloat32(8, true),
    };
  },
};

export const TrainingDummy = defineComponent({
  name: "trainingDummy" as const,
  networked: false,
  codec: trainingDummyCodec,
  default: (): TrainingDummyData => ({ healDelayTicks: 100, lastHitTick: 0, lastObservedHealth: 0 }),
});
