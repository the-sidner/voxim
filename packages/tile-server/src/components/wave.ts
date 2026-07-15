/**
 * Wave-POI runtime components (T-212 v2).
 *
 * `wave` activities cycle through `PoiDef.activity.waves` in order, each
 * wave's NPCs tagged `WaveMember` so `PoiSystem` can count survivors
 * without a bespoke aggregate. `WaveState` lives on the SAME `PoiTrigger`
 * entity (joined by `poiInstanceId`, matching how `Stair`/`PoiTrigger`
 * already key off narrative instance ids) and tracks which wave index has
 * been dispatched so far. The inter-wave delay is a `wave_timer` Resource
 * (T-238 primitive) on that same trigger entity — no hand-rolled countdown.
 *
 * Server-only: the player never queries wave state directly, only sees its
 * effects (NPCs spawning, dying).
 */

import { defineComponent } from "@voxim/engine";
import { WireReader, WireWriter } from "@voxim/codecs";

export interface WaveMemberData {
  /** Correlates back to the wave POI's `PoiTrigger.poiInstanceId`. */
  poiInstanceId: string;
}

export const WaveMember = defineComponent({
  name: "waveMember" as const,
  networked: false,
  codec: {
    encode(v: WaveMemberData): Uint8Array {
      const w = new WireWriter();
      w.writeStr(v.poiInstanceId);
      return w.toBytes();
    },
    decode(b: Uint8Array): WaveMemberData {
      const r = new WireReader(b);
      return { poiInstanceId: r.readStr() };
    },
  },
  default: (): WaveMemberData => ({ poiInstanceId: "" }),
});

export interface WaveStateData {
  poiInstanceId: string;
  /** Index of the next wave to dispatch (0-based). Equal to
   * `waves.length` once every wave has been dispatched. */
  waveIndex: number;
  totalWaves: number;
}

export const WaveState = defineComponent({
  name: "waveState" as const,
  networked: false,
  codec: {
    encode(v: WaveStateData): Uint8Array {
      const w = new WireWriter();
      w.writeStr(v.poiInstanceId);
      w.writeU16(v.waveIndex);
      w.writeU16(v.totalWaves);
      return w.toBytes();
    },
    decode(b: Uint8Array): WaveStateData {
      const r = new WireReader(b);
      return {
        poiInstanceId: r.readStr(),
        waveIndex:     r.readU16(),
        totalWaves:    r.readU16(),
      };
    },
  },
  default: (): WaveStateData => ({ poiInstanceId: "", waveIndex: 0, totalWaves: 0 }),
});
