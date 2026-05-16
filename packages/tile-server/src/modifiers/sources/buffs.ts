/**
 * `buffs` ModifierSource (T-239) — every buff scene-graph child of the
 * entity contributes its `BuffSpec` as one `StatModifier`. The buff's
 * lifetime is its `buff_timer` Resource (`expire_buff` → `destroySubtree`
 * removes the child, and with it this contribution) — there is no
 * `ActiveEffects` list and no `BuffSystem` decrement loop.
 */

import { BuffSpec } from "../../components/buff.ts";
import type { ModifierSource, StatModifier } from "../modifier.ts";

export const buffsSource: ModifierSource = {
  id: "buffs",
  contribute(ctx): StatModifier[] {
    const out: StatModifier[] = [];
    for (const childId of ctx.world.getChildren(ctx.entityId)) {
      const spec = ctx.world.get(childId, BuffSpec);
      if (!spec || spec.stat === "") continue;
      out.push({ stat: spec.stat, op: spec.op, value: spec.value });
    }
    return out;
  },
};
