import { defineComponent } from "@voxim/engine";
import { hitboxCodec } from "@voxim/codecs";
import type { HitboxData } from "@voxim/codecs";

export type { HitboxData };

/**
 * Collision geometry for hit detection. Server-only — clients never receive it.
 * All coordinates are entity-local (right=X, fwd=Y, up=Z).
 *
 * For animated entities (players, NPCs): written each tick by HitboxSystem,
 * derived from the live skeleton pose via solveSkeleton + applyHitboxTemplate.
 * For static entities (trees, resources): written once at spawn by spawner.ts
 * using the rest-pose skeleton.
 *
 * An entity without this component (or with an empty parts array) is invisible
 * to ActionSystem's hit detection. This is the single gate for hittability.
 *
 * Lives in @voxim/codecs despite being server-only because it reuses the codec
 * building blocks there; the client never imports it.
 */
export const Hitbox = defineComponent({
  name: "hitbox" as const,
  codec: hitboxCodec,
  networked: false,
  default: (): HitboxData => ({ parts: [] }),
});
