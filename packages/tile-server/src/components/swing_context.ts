/**
 * SwingContext component (server-only).
 *
 * Payload component bound to the right_hand layer's action states (those
 * carrying the `carries_swing_context` tag). Replaces the mode+payload
 * mash-up of the retired SkillInProgress component.
 *
 * The CSM owns mode and timing (state.elapsed gives ticks-into-phase via the
 * dt accumulator; the layer node names the phase). This component holds only
 * the gameplay payload the SM data model can't represent: the weapon details,
 * lag-comp snapshot, hit dedup set, and pending skill verb.
 *
 * Lifetime: installed by ActionSystem when firing event.swing_started; removed
 * by ActionSystem in pass 1c once the right_hand layer exits the tagged states
 * (and no chain continuation is queued). The CSM never touches this component.
 */

import { defineComponent } from "@voxim/engine";
import type { Serialiser } from "@voxim/engine";
import { WireWriter, WireReader, WIRE_LIMITS } from "@voxim/codecs";

/** A single hit record from a sweep — stores which entity and which body part was struck. */
export interface HitRecord {
  entityId: string;
  bodyPart: string;
}

export interface SwingContextData {
  /** WeaponActionDef id this swing is animating + resolving. */
  weaponActionId: string;
  /**
   * Tick to rewind to for lag-compensated hit detection.
   * -1 = not yet computed (set on first active tick from InputState.rttMs).
   * Stable across all ticks of the active phase.
   */
  rewindTick: number;
  /** Entities already struck this swing — dedup so multi-tick active windows don't double-hit. */
  hitEntities: HitRecord[];
  /**
   * Skill verb to fire on melee connect (e.g. "strike:0"). Empty when the
   * swinger has no skill loadout slot bound to "strike".
   */
  pendingSkillVerb: string;
  /**
   * Weapon prefab id captured at swing-start. Stats / blade geometry derive
   * from this for the lifetime of the swing — a mid-swing equipment swap
   * does not corrupt damage or hit detection. Empty string = unarmed.
   */
  weaponPrefabId: string;
  /** Quality (0–1) stamped on the weapon entity at swing start. 1 = unarmed. */
  weaponQuality: number;
  /**
   * Set by ActionSystem each tick the actor holds ACTION_USE_SKILL while
   * already in swing.active or swing.winddown. Read at swing.winddown→
   * idle: if true, the swing chain advances to the next index and a new
   * SwingContext is installed immediately; if false, the chain ends.
   * "No grace window" — the queue intent must be expressed during the
   * current swing or the chain is gone.
   */
  queued: boolean;
}

const codec: Serialiser<SwingContextData> = {
  encode(v: SwingContextData): Uint8Array {
    if (v.hitEntities.length > WIRE_LIMITS.hitRecordsPerSwing) {
      throw new Error(`[codec] SwingContext.hitEntities length ${v.hitEntities.length} exceeds wire cap ${WIRE_LIMITS.hitRecordsPerSwing}`);
    }
    const w = new WireWriter();
    w.writeStr(v.weaponActionId);
    w.writeI32(v.rewindTick);
    w.writeU16(v.hitEntities.length);
    for (const h of v.hitEntities) { w.writeStr(h.entityId); w.writeStr(h.bodyPart); }
    w.writeStr(v.pendingSkillVerb);
    w.writeStr(v.weaponPrefabId);
    w.writeF32(v.weaponQuality);
    w.writeU8(v.queued ? 1 : 0);
    return w.toBytes();
  },
  decode(bytes: Uint8Array): SwingContextData {
    const r = new WireReader(bytes);
    const weaponActionId = r.readStr();
    const rewindTick = r.readI32();
    const count = r.readU16();
    const hitEntities: HitRecord[] = [];
    for (let i = 0; i < count; i++) hitEntities.push({ entityId: r.readStr(), bodyPart: r.readStr() });
    const pendingSkillVerb = r.readStr();
    const weaponPrefabId = r.readStr();
    const weaponQuality = r.readF32();
    const queued = r.readU8() === 1;
    return { weaponActionId, rewindTick, hitEntities, pendingSkillVerb, weaponPrefabId, weaponQuality, queued };
  },
};

export const SwingContext = defineComponent({
  name: "swingContext" as const,
  networked: false,
  codec,
  default: (): SwingContextData => ({
    weaponActionId: "unarmed",
    rewindTick: -1,
    hitEntities: [],
    pendingSkillVerb: "",
    weaponPrefabId: "",
    weaponQuality: 1,
    queued: false,
  }),
});
