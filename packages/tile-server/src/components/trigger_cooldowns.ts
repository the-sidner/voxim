/**
 * TriggerCooldowns component — server-only, not networked.
 *
 * Per-owner internal-cooldown (ICD) state for the trigger primitive
 * (T-259): `remaining[triggerId]` = ticks the trigger stays dormant after
 * firing. TriggerSystem is the single writer (decrements each tick,
 * dropping spent keys; stamps on fire). Same honest stance as
 * `skillCooldowns`: per-instance N-counters don't fit the
 * single-named-scalar Resource primitive (recorded at T-248).
 */

import { defineComponent } from "@voxim/engine";
import type { Serialiser } from "@voxim/engine";
import { WireWriter, WireReader } from "@voxim/codecs";

export interface TriggerCooldownsData {
  remaining: Record<string, number>;
}

const triggerCooldownsCodec: Serialiser<TriggerCooldownsData> = {
  encode(v: TriggerCooldownsData): Uint8Array {
    const w = new WireWriter();
    const entries = Object.entries(v.remaining);
    w.writeU16(entries.length);
    for (const [id, ticks] of entries) {
      w.writeStr(id);
      w.writeU32(ticks);
    }
    return w.toBytes();
  },
  decode(bytes: Uint8Array): TriggerCooldownsData {
    const r = new WireReader(bytes);
    const count = r.readU16();
    const remaining: Record<string, number> = {};
    for (let i = 0; i < count; i++) {
      const id = r.readStr();
      remaining[id] = r.readU32();
    }
    return { remaining };
  },
};

export const TriggerCooldowns = defineComponent({
  name: "triggerCooldowns" as const,
  networked: false,
  codec: triggerCooldownsCodec,
  default: (): TriggerCooldownsData => ({ remaining: {} }),
});
