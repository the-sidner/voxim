/**
 * expire_buff resource effect (T-239) — a buff child's `buff_timer`
 * Resource hits 0 (`cross@0`, the T-238f crafting_timer shape) and the
 * child tears itself down. One line: the buff vanishes, its `BuffSpec`
 * contribution with it. Buff lifetime needs zero bespoke code — it is the
 * Resource primitive.
 */

import type { ResourceEffect } from "../effect.ts";

export const expireBuffEffect: ResourceEffect = {
  id: "expire_buff",
  resolve(ctx) {
    ctx.world.destroySubtree(ctx.entityId);
  },
};
