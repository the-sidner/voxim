/**
 * NoiseLevel (T-014) — how loud an actor currently is, in [0,1], derived each
 * tick from its horizontal speed and crouch state by `NoiseSystem`. Running is
 * loud (→1), standing still is silent (→0), crouching scales it down sharply.
 *
 * Server-only: it is an input to NPC perception (T-015 detection gradient), not
 * something the client renders. Transient — never saved; recomputed every tick.
 */
import { defineComponent } from "@voxim/engine";
import type { Serialiser } from "@voxim/engine";

export interface NoiseLevelData {
  /** Current loudness in [0,1]. 0 = silent (still), 1 = full sprint. */
  level: number;
}

const noiseLevelCodec: Serialiser<NoiseLevelData> = {
  encode(v) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setFloat32(0, v.level, true);
    return b;
  },
  decode(b) {
    return { level: new DataView(b.buffer, b.byteOffset, b.byteLength).getFloat32(0, true) };
  },
};

export const NoiseLevel = defineComponent({
  name: "noiseLevel" as const,
  networked: false,
  codec: noiseLevelCodec,
  default: (): NoiseLevelData => ({ level: 0 }),
});
