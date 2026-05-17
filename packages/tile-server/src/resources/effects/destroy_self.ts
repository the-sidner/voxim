/**
 * destroy_self resource effect (T-241) — a transient entity's `lifetime`
 * Resource hits 0 (`cross@0`, the buff_timer / crafting_timer shape) and
 * the entity is destroyed. Projectile / effect expiry is not a "death"
 * (no EntityDied, no DeathRequestPort) — same stance the retired
 * LifetimeSystem took. Distinct from `expire_buff`'s `destroySubtree`: a
 * projectile is a leaf, not a buff scene-graph parent.
 */

import type { ResourceEffect } from "../effect.ts";

export const destroySelfEffect: ResourceEffect = {
  id: "destroy_self",
  resolve(ctx) {
    ctx.world.destroy(ctx.entityId);
  },
};
