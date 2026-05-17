/**
 * respawn_node resource effect (T-242) — a depleted resource node's
 * `respawn_timer` Resource hits 0 (`cross@0`, the lifetime/buff_timer
 * shape) and the node is restored: hitPoints back to the prefab default,
 * `depleted` cleared.
 *
 * This is all `ResourceNodeSystem` ever did — the node respawn countdown
 * is the Resource primitive, not a bespoke system. Node *hitPoints* stay
 * on `ResourceNode` (hit-driven, not a tick scalar).
 *
 * The spent `respawn_timer` is deliberately left in place at 0: unlike
 * expire_buff/destroy_self the node entity lives on, and `ResourceSystem`
 * is the single writer of `Resource` — it commits its own post-integration
 * `Resource` write *after* this effect in the same tick, so a delete here
 * would be clobbered (the deferred-write reality). A value pinned at 0 is
 * inert (clamped at bounds.min; `cross@0` never re-fires since prev is
 * already in-zone); `ResourceNodeHitHandler` overwrites it with a fresh
 * countdown on the next depletion. No leak, no bespoke cleanup.
 */

import type { PrefabResourceNodeData } from "@voxim/content";
import type { ResourceEffect } from "../effect.ts";
import { ResourceNode } from "../../components/resource_node.ts";

export const respawnNodeEffect: ResourceEffect = {
  id: "respawn_node",
  resolve(ctx) {
    const rn = ctx.world.get(ctx.entityId, ResourceNode);
    if (!rn) return;

    const prefab = ctx.content.prefabs.get(rn.nodeTypeId);
    const tmpl = prefab?.components.resourceNode as PrefabResourceNodeData | undefined;
    ctx.world.set(ctx.entityId, ResourceNode, {
      ...rn,
      hitPoints: tmpl?.hitPoints ?? 1,
      depleted: false,
    });
    // respawn_timer is left at 0 (inert) — see the file header on why it
    // can't be deleted from here. ResourceNodeHitHandler re-arms it.
  },
};
