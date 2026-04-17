/**
 * Flee effect — area aura that forces NPC job queues into a flee job.
 *
 * Does not use the ActiveEffects component at all; the effect is expressed
 * entirely through NpcJobQueue.current on each affected NPC.
 */
import type { EffectApplyContext, EffectApplyHandler } from "./effect_handler.ts";
import { NpcJobQueue } from "../components/npcs.ts";
import { Position } from "../components/game.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("FleeEffect");

export const fleeEffectApply: EffectApplyHandler = {
  id: "flee",
  apply(ctx: EffectApplyContext): void {
    const { world, casterId, casterX, casterY, entry, currentTick, spatial } = ctx;
    const fleeTicks = entry.durationTicks > 0 ? entry.durationTicks : 60;
    const rangeSq = entry.range * entry.range;
    let affected = 0;

    const candidates = spatial
      ? spatial.nearby(casterX, casterY, entry.range)
      : world.query(NpcJobQueue).map((r) => r.entityId);

    for (const targetId of candidates) {
      const npcJobQueue = world.get(targetId, NpcJobQueue);
      if (!npcJobQueue) continue;
      const pos = world.get(targetId, Position);
      if (!pos) continue;
      const dx = pos.x - casterX;
      const dy = pos.y - casterY;
      if (dx * dx + dy * dy > rangeSq) continue;
      world.set(targetId, NpcJobQueue, {
        ...npcJobQueue,
        current: {
          type: "flee",
          fromX: casterX,
          fromY: casterY,
          expiresAt: currentTick + fleeTicks,
        },
      });
      affected++;
    }
    log.debug("fear aura: caster=%s affected=%d npcs for %d ticks", casterId, affected, fleeTicks);
  },
};
