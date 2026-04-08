import { defineComponent } from "@voxim/engine";
import { hitboxCodec } from "@voxim/codecs";
import type { HitboxData } from "@voxim/codecs";

export type { HitboxData };

/**
 * Collision geometry for hit detection.
 *
 * Networked — sent to clients so they can visualise hitboxes in debug mode.
 * The arm capsule parts (boneId set) update every tick during attacks via IK;
 * the rest are written once at spawn and are effectively static.
 *
 * Parts with boneId set have their coordinates managed by AnimationSystem each tick
 * (bone-local → entity-local recomputation). Parts without boneId are entity-local
 * and written once at spawn.
 *
 * An entity without this component (or with an empty parts array) is invisible to
 * ActionSystem's hit detection. This is the single gate for hittability.
 */
export const Hitbox = defineComponent({
  name: "hitbox" as const,
  codec: hitboxCodec,
  default: (): HitboxData => ({ parts: [] }),
});
