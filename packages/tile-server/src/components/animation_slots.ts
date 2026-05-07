/**
 * AnimationSlots component — server-only, not networked.
 *
 * Maps animation slot names ("idle", "walk", "walk_limp", ...) to clip ids on
 * the entity's skeleton.  Written by `Spawner` from `prefab.animationSlots`.
 * Read by `AnimationSystem` to pick which clip to play for each slot, so two
 * prefabs sharing the same skeleton can have different walks (zombie vs
 * player) without forking the skeleton or hard-coding clip ids in the system.
 *
 * Absent component or absent slot → AnimationSystem falls back to the slot
 * name as the clip id (back-compat with skeletons authored before the
 * indirection landed).
 */
import { defineComponent } from "@voxim/engine";
import type { Serialiser } from "@voxim/engine";
import { WireWriter, WireReader } from "@voxim/codecs";

export interface AnimationSlotsData {
  /** slot name → clip id on the skeleton.  Empty by default. */
  slots: Record<string, string>;
}

const animationSlotsCodec: Serialiser<AnimationSlotsData> = {
  encode(v: AnimationSlotsData): Uint8Array {
    const w = new WireWriter();
    const entries = Object.entries(v.slots);
    w.writeU16(entries.length);
    for (const [k, val] of entries) {
      w.writeStr(k);
      w.writeStr(val);
    }
    return w.toBytes();
  },
  decode(bytes: Uint8Array): AnimationSlotsData {
    const r = new WireReader(bytes);
    const n = r.readU16();
    const slots: Record<string, string> = {};
    for (let i = 0; i < n; i++) {
      const k = r.readStr();
      slots[k] = r.readStr();
    }
    return { slots };
  },
};

export const AnimationSlots = defineComponent({
  name: "animationSlots" as const,
  codec: animationSlotsCodec,
  networked: false,
  default: (): AnimationSlotsData => ({ slots: {} }),
});
