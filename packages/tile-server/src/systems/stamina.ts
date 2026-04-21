import type { World } from "@voxim/engine";
import type { ContentStore } from "@voxim/content";
import type { System, EventEmitter } from "../system.ts";
import { Stamina } from "../components/game.ts";
import { Equipment } from "../components/equipment.ts";
import { CorruptionExposure } from "../components/world.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("StaminaSystem");

export class StaminaSystem implements System {
  constructor(private readonly content: ContentStore) {}

  run(world: World, _events: EventEmitter, dt: number): void {
    const corruptionCfg = this.content.getGameConfig().corruption;

    for (const { entityId, stamina } of world.query(Stamina)) {
      if (stamina.current >= stamina.max) continue;

      const equipment = world.get(entityId, Equipment);
      const armorPenalty = equipment
        ? [equipment.head, equipment.chest, equipment.legs, equipment.feet, equipment.back]
            .reduce((sum, slot) => {
              if (!slot) return sum;
              return sum + (this.content.deriveItemStats(slot.prefabId).staminaRegenPenalty ?? 0);
            }, 0)
        : 0;

      const corruption = world.get(entityId, CorruptionExposure);
      const corruptionPenalty = (corruption && corruption.level >= corruptionCfg.staminaPenaltyThreshold)
        ? corruptionCfg.staminaPenaltyFraction
        : 0;

      const regenPenalty = Math.min(1, armorPenalty + corruptionPenalty);
      const effectiveRegen = stamina.regenPerSecond * (1 - regenPenalty);
      const newCurrent = Math.min(stamina.max, stamina.current + effectiveRegen * dt);

      if (stamina.exhausted && newCurrent > 0) {
        log.info("stamina recovered from exhaustion: entity=%s stamina=%.1f", entityId, newCurrent);
      }
      if (regenPenalty > 0) {
        log.debug("stamina regen: entity=%s %.3f/s (penalty=%.0f%%) → %.1f",
          entityId, effectiveRegen, regenPenalty * 100, newCurrent);
      }

      world.set(entityId, Stamina, { ...stamina, current: newCurrent, exhausted: newCurrent <= 0 });
    }
  }
}
