/**
 * Resource component (T-238) — every tick-scalar an entity carries.
 *
 * One component holds all of an entity's resources (`values[id] =
 * { value, max }`), matching `ActiveActions`' multi-slot shape so the
 * query + delta stay cheap. `ResourceSystem` is the only writer:
 * integrates each `ResourceDef.rate`, clamps to `[def.bounds.min, max]`
 * (max is per-entity — seeded at spawn, e.g. heritage-scaled stamina),
 * and dispatches threshold effects.
 *
 * Server-only: there is no resource-bar UI yet (same call `ActiveActions`
 * made at first). Networking is a later add if/when a bar needs it.
 * Nothing installs this yet — the substrate is inert until T-238b seeds
 * stamina at spawn.
 */

import { defineComponent } from "@voxim/engine";
import type { Serialiser } from "@voxim/engine";
import { WireWriter, WireReader } from "@voxim/codecs";

export interface ResourceValue {
  value: number;
  max: number;
}

export interface ResourceData {
  values: Record<string, ResourceValue>;
}

const resourceCodec: Serialiser<ResourceData> = {
  encode(v: ResourceData): Uint8Array {
    const w = new WireWriter();
    const entries = Object.entries(v.values);
    w.writeU8(entries.length);
    for (const [id, rv] of entries) {
      w.writeStr(id);
      w.writeF32(rv.value);
      w.writeF32(rv.max);
    }
    return w.toBytes();
  },
  decode(b: Uint8Array): ResourceData {
    const r = new WireReader(b);
    const n = r.readU8();
    const values: Record<string, ResourceValue> = {};
    for (let i = 0; i < n; i++) {
      const id = r.readStr();
      values[id] = { value: r.readF32(), max: r.readF32() };
    }
    return { values };
  },
};

export const Resource = defineComponent({
  name: "resource" as const,
  networked: false,
  codec: resourceCodec,
  default: (): ResourceData => ({ values: {} }),
});
