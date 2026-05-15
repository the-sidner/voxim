/**
 * modify_health resource effect (T-238) — the starvation / corruption
 * coupling. A threshold params `{ dps, cause? }`: applies `dps × dt` to the
 * entity's Health each fire (negative dps = damage), clamps to [0, max],
 * publishes DamageDealt on damage, and requests death through the port when
 * health reaches zero (cause defaults to "effect").
 *
 * Inert until a ResourceDef references it (T-238c hunger / T-238e
 * corruption); shipped now so the substrate has one real, tested effect.
 */

import { TileEvents } from "@voxim/protocol";
import type { ResourceEffect } from "../effect.ts";
import { Health } from "../../components/game.ts";
import type { DeathCause } from "../../events/death.ts";

export const modifyHealthEffect: ResourceEffect = {
  id: "modify_health",
  resolve(ctx) {
    const dps = typeof ctx.params.dps === "number" ? ctx.params.dps : 0;
    if (dps === 0) return;
    const health = ctx.world.get(ctx.entityId, Health);
    if (!health) return;

    const delta = dps * ctx.dt;
    const next = Math.max(0, Math.min(health.max, health.current + delta));
    if (next === health.current) return;
    ctx.world.set(ctx.entityId, Health, { ...health, current: next });

    if (delta < 0) {
      ctx.events.publish(TileEvents.DamageDealt, {
        targetId: ctx.entityId,
        sourceId: ctx.entityId,
        amount: -delta,
        blocked: false,
      });
    }
    if (next <= 0) {
      const cause = (typeof ctx.params.cause === "string"
        ? ctx.params.cause
        : "effect") as DeathCause;
      ctx.deaths.request({ entityId: ctx.entityId, cause });
    }
  },
};
