import { defineComponent } from "@voxim/engine";
import type { Serialiser } from "@voxim/engine";
import type { BodyPartVolume } from "@voxim/content";

export interface HitboxData {
  parts: BodyPartVolume[];
}

// Server-only — never sent over the wire. The codec is a no-op stub required
// by defineComponent's type signature; it will never be called.
const hitboxCodec: Serialiser<HitboxData> = {
  encode: (_v) => new Uint8Array(0),
  decode: (_b) => ({ parts: [] }),
};

/**
 * Collision geometry for hit detection.
 *
 * Server-only (networked: false) — not sent to clients.
 *
 * Parts with boneId set have their coordinates managed by AnimationSystem each tick
 * (bone-local → world-space recomputation). Parts without boneId are entity-local
 * and written once at spawn.
 *
 * An entity without this component (or with an empty parts array) is invisible to
 * ActionSystem's hit detection. This is the single gate for hittability.
 */
export const Hitbox = defineComponent({
  name: "hitbox" as const,
  codec: hitboxCodec,
  networked: false,
  default: (): HitboxData => ({ parts: [] }),
});
