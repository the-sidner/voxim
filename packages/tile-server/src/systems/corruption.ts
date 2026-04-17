import type { World } from "@voxim/engine";
import type { ContentStore } from "@voxim/content";
import type { System, EventEmitter } from "../system.ts";
import { Health } from "../components/game.ts";
import { WorldClock, TileCorruption, CorruptionExposure, isDay } from "../components/world.ts";
import type { DeathRequestPort } from "../events/death.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("CorruptionSystem");

export class CorruptionSystem implements System {
  constructor(
    private readonly content: ContentStore,
    private readonly deaths: DeathRequestPort,
  ) {}

  run(world: World, _events: EventEmitter, dt: number): void {
    const cfg = this.content.getGameConfig().corruption;

    let tileLevel = 0;

    for (const { entityId, worldClock, tileCorruption } of world.query(WorldClock, TileCorruption)) {
      const day = isDay(worldClock);
      const delta = day ? -cfg.dayDecayRatePerTick : cfg.nightGainRatePerTick;
      const newLevel = Math.max(0, Math.min(100, tileCorruption.level + delta));
      world.set(entityId, TileCorruption, { level: newLevel });
      tileLevel = newLevel;

      // Log when crossing 0 or significant thresholds
      const prev = tileCorruption.level;
      if ((prev === 0 && newLevel > 0) || (prev > 0 && newLevel === 0)) {
        log.info("tile corruption %s: level=%.3f", newLevel > 0 ? "onset" : "cleared", newLevel);
      } else if (Math.floor(prev / 25) !== Math.floor(newLevel / 25)) {
        log.debug("tile corruption level=%.1f (%s)", newLevel, day ? "decaying" : "rising");
      }
    }

    for (const { entityId, corruptionExposure } of world.query(CorruptionExposure)) {
      let newExposure: number;
      if (tileLevel > 0) {
        newExposure = Math.min(100, corruptionExposure.level + tileLevel * cfg.exposureGainRatePerTick);
      } else {
        newExposure = Math.max(0, corruptionExposure.level - cfg.exposureDecayRatePerTick);
      }
      world.set(entityId, CorruptionExposure, { level: newExposure });

      const wasBelow = corruptionExposure.level < cfg.healthDamageThreshold;
      const nowAbove = newExposure >= cfg.healthDamageThreshold;
      if (wasBelow && nowAbove) {
        log.info("corruption damage onset: entity=%s exposure=%.1f", entityId, newExposure);
      }

      if (newExposure >= cfg.healthDamageThreshold) {
        const health = world.get(entityId, Health);
        if (health && health.current > 0) {
          const dmg = cfg.healthDps * dt;
          const newHp = Math.max(0, health.current - dmg);
          log.debug("corruption damage: entity=%s dmg=%.3f hp=%.1f", entityId, dmg, newHp);
          world.set(entityId, Health, { ...health, current: newHp });
          if (newHp <= 0) {
            log.info("corruption kill: entity=%s", entityId);
            this.deaths.request({ entityId, cause: "corruption" });
          }
        }
      }
    }
  }
}
