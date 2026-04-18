import { defineComponent } from "@voxim/engine";
import { hitboxCodec } from "@voxim/codecs";
import type { HitboxData } from "@voxim/codecs";

export type { HitboxData };

/**
 * Collision geometry for hit detection. Server-only — clients never receive it.
 * All coordinates are entity-local (right=X, fwd=Y, up=Z).
 *
 * `derive` is the single switch that routes authorship:
 *   true  → HitboxSystem repopulates `parts` each tick from the live skeleton
 *   false → `parts` is static; HitboxSystem skips the entity
 *
 * Default is { derive: true, parts: [] } so a prefab that declares nothing
 * inherits the animated contract. Static props override with derive: false
 * and hand-authored or spawn-derived parts.
 *
 * An entity without this component (or with an empty parts array) is invisible
 * to ActionSystem's hit detection. This is the single gate for hittability.
 */
export const Hitbox = defineComponent({
  name: "hitbox" as const,
  codec: hitboxCodec,
  networked: false,
  default: (): HitboxData => ({ derive: true, parts: [] }),
});
