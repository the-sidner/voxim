/**
 * Maneuver component (server-only) — T-185.
 *
 * Per-actor payload for an in-progress maneuver. Present iff the entity is
 * committed to a ManeuverDef timeline. The CSM `right_hand` / `left_hand`
 * layers transition to their `in_maneuver` state when this is installed
 * and exit when it's removed.
 *
 * Lifetime:
 *   - Created by ActionSystem when input dispatches a skill slot bound to
 *     a ManeuverDef. event.maneuver_started fires the same tick.
 *   - Updated by ManeuverScheduler each tick: advances `elapsed`, derives
 *     the active per-hand clip, locomotion impulse, and hit-effect tag list
 *     from the ManeuverDef tracks.
 *   - Removed by ManeuverScheduler when `elapsed >= duration` or an
 *     interrupt window grants exit. event.maneuver_ended fires that tick.
 *
 * Server-only because (a) gameplay reads it directly via component handles
 * and (b) the AnimationSystem already encodes the resolved per-layer clipId
 * onto AnimationState — so the client doesn't need a separate Maneuver
 * decode path. Maneuver state therefore rides through the normal
 * AnimationLayer projection.
 */
import { defineComponent } from "@voxim/engine";
import type { Serialiser } from "@voxim/engine";
import { WireWriter, WireReader } from "@voxim/codecs";

export interface ManeuverHitTag {
  tag: string;
  magnitude: number;
}

export interface ManeuverData {
  /** ManeuverDef id this entity is executing. */
  maneuverId: string;
  /** Seconds since the maneuver began. */
  elapsed: number;
  /**
   * Resolved clip id for each hand layer at the current `elapsed`. Empty
   * string ⇒ no clip on that hand this frame (e.g. before the first hand
   * track triggers). AnimationSystem reads these into the right_hand /
   * left_hand layer projections when the SM node is `in_maneuver`.
   */
  rightClipId: string;
  leftClipId: string;
  /**
   * Hit-effect tags currently in window. Hit handlers iterate this list
   * when a hit lands and apply each tag's effect. The first cut is a
   * placeholder — only the tag names matter for now (logged when applied);
   * the real effect resolver is intentionally deferred.
   */
  activeHitTags: ManeuverHitTag[];
}

const codec: Serialiser<ManeuverData> = {
  encode(v: ManeuverData): Uint8Array {
    const w = new WireWriter();
    w.writeStr(v.maneuverId);
    w.writeF32(v.elapsed);
    w.writeStr(v.rightClipId);
    w.writeStr(v.leftClipId);
    w.writeU8(v.activeHitTags.length);
    for (const t of v.activeHitTags) {
      w.writeStr(t.tag);
      w.writeF32(t.magnitude);
    }
    return w.toBytes();
  },
  decode(bytes: Uint8Array): ManeuverData {
    const r = new WireReader(bytes);
    const maneuverId = r.readStr();
    const elapsed = r.readF32();
    const rightClipId = r.readStr();
    const leftClipId = r.readStr();
    const tagCount = r.readU8();
    const activeHitTags: ManeuverHitTag[] = [];
    for (let i = 0; i < tagCount; i++) {
      activeHitTags.push({ tag: r.readStr(), magnitude: r.readF32() });
    }
    return { maneuverId, elapsed, rightClipId, leftClipId, activeHitTags };
  },
};

export const Maneuver = defineComponent({
  name: "maneuver" as const,
  networked: false,
  codec,
  default: (): ManeuverData => ({
    maneuverId: "",
    elapsed: 0,
    rightClipId: "",
    leftClipId: "",
    activeHitTags: [],
  }),
});
