/**
 * ActionCooldowns component — server-only, not networked.
 *
 * Per-actor cooldown state for the action runtime (T-260): `remaining[id]`
 * = ticks before action `id` may start again; `gcd` = the global cooldown
 * any `triggersGcd` action raises (and is blocked by). The dispatcher is
 * the single writer: decrements at the top of its run, stamps in `start()`
 * — both via composing mutates (T-249). Cooldowns are per-ACTION, not
 * per-bar-slot (the WoW model: the spell is on cooldown, wherever bound).
 *
 * Same honest stance as `TriggerCooldowns`: per-instance N-counters don't
 * fit the single-named-scalar Resource primitive (recorded at T-248).
 */

import { defineComponent } from "@voxim/engine";
import type { Serialiser } from "@voxim/engine";
import { WireWriter, WireReader } from "@voxim/codecs";

export interface ActionCooldownsData {
  gcd: number;
  remaining: Record<string, number>;
}

const actionCooldownsCodec: Serialiser<ActionCooldownsData> = {
  encode(v: ActionCooldownsData): Uint8Array {
    const w = new WireWriter();
    w.writeU32(v.gcd);
    const entries = Object.entries(v.remaining);
    w.writeU16(entries.length);
    for (const [id, ticks] of entries) {
      w.writeStr(id);
      w.writeU32(ticks);
    }
    return w.toBytes();
  },
  decode(bytes: Uint8Array): ActionCooldownsData {
    const r = new WireReader(bytes);
    const gcd = r.readU32();
    const count = r.readU16();
    const remaining: Record<string, number> = {};
    for (let i = 0; i < count; i++) {
      const id = r.readStr();
      remaining[id] = r.readU32();
    }
    return { gcd, remaining };
  },
};

export const ActionCooldowns = defineComponent({
  name: "actionCooldowns" as const,
  networked: false,
  codec: actionCooldownsCodec,
  default: (): ActionCooldownsData => ({ gcd: 0, remaining: {} }),
});
