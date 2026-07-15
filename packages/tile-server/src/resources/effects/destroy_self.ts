/**
 * destroy_self resource effect (T-241) — a transient entity's `lifetime`
 * Resource hits 0 (`cross@0`, the buff_timer / crafting_timer shape) and
 * the entity is destroyed. Projectile / effect expiry is not a "death"
 * (no EntityDied, no DeathRequestPort) — same stance the retired
 * LifetimeSystem took.
 *
 * destroySubtree, not destroy (T-219 fix): this is also the ONLY teardown
 * path for a `shed_dissolve`-lingering corpse (`dissolve_timer`'s own
 * `cross@0 -> destroy_self`, `data/resources/dissolve_timer.json`) —
 * DeathSystem skips its own destroySubtree for a `{ linger: true }` death,
 * so a dissolving skeletal NPC's bone-entity subtree (and any equipment
 * still parented to a bone — the equip_cleanup hook only clears Equipment/
 * Inventory slots, not the skeleton itself) stayed alive, orphaned forever,
 * once this fired a bare `destroy()` on just the corpse root. Degrades to
 * exactly `destroy()` for a leaf entity (a `lifetime`-timed projectile has
 * no scene-graph children), so this is behaviour-preserving for every
 * other `destroy_self` consumer — same reasoning as every other
 * destroy->destroySubtree conversion in this arc.
 */

import type { ResourceEffect } from "../effect.ts";

export const destroySelfEffect: ResourceEffect = {
  id: "destroy_self",
  resolve(ctx) {
    ctx.world.destroySubtree(ctx.entityId);
  },
};
