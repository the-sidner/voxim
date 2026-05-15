/**
 * set_tag / clear_tag effect resolvers (T-226b).
 *
 * An action installs a presence-flag tag for the duration of a phase:
 * `set_tag` on the phase's `:enter`, `clear_tag` on its `:exit`. The tag
 * name is resolved against the closed `TAG_COMPONENTS` vocabulary.
 *
 * Writes are deferred (`world.set` / `world.remove`) — committed at
 * end-of-tick like every system write. Readers (e.g. the `posture` CSM
 * scope contributor) therefore observe the tag on the *next* tick, which
 * matches the one-tick lag the retired CSM posture layer already had
 * (AnimationSystem read the CSM's deferred layerState a tick late too).
 */

import type { EffectResolver } from "../effect.ts";
import { TAG_COMPONENTS } from "../../components/tags.ts";

function tagDef(name: unknown) {
  if (typeof name !== "string" || !(name in TAG_COMPONENTS)) {
    throw new Error(`set_tag/clear_tag: unknown tag '${String(name)}'`);
  }
  return TAG_COMPONENTS[name];
}

export const setTagResolver: EffectResolver = {
  id: "set_tag",
  resolve(ctx) {
    ctx.world.set(ctx.entityId, tagDef(ctx.params.tag), {});
  },
};

export const clearTagResolver: EffectResolver = {
  id: "clear_tag",
  resolve(ctx) {
    ctx.world.remove(ctx.entityId, tagDef(ctx.params.tag));
  },
};
