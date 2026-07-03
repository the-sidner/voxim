/**
 * boss_arena_unlock DeathHook (T-212 v2) — fires when a `BossArenaLink`-
 * tagged entity dies. Runs synchronously inside `DeathSystem.run()`
 * BEFORE `world.destroy()`, so it can still read the dying boss's
 * components — the property `entity_died` Trigger content can't offer
 * (see `components/boss_arena.ts`'s header for why).
 *
 * Component presence gates it, not an `isBoss` branch: any entity carrying
 * `BossArenaLink` is "a tracked boss" per doctrine. v1 scope: log the
 * clear (verification hook); `arenaRules.lockEntry` isn't enforced (no
 * blocker entities exist to destroy — see `bossfight.ts`'s header).
 */

import type { DeathHook } from "../systems/death.ts";
import { BossArenaLink } from "../components/boss_arena.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("poi:bossfight");

export const bossArenaUnlockHook: DeathHook = {
  id: "boss_arena_unlock",
  onDeath(ctx) {
    const link = ctx.world.get(ctx.entityId, BossArenaLink);
    if (!link) return;
    log.info("POI %s: boss cleared (entity=%s killer=%s)", link.poiInstanceId, ctx.entityId, ctx.killerId ?? "none");
  },
};
