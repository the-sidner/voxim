import type { World } from "@voxim/engine";
import { TileEvents } from "@voxim/protocol";
import type { ContentStore } from "@voxim/content";
import type { System, EventEmitter } from "../system.ts";
import { Hunger, Thirst, Health } from "../components/game.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("HungerSystem");

export class HungerSystem implements System {
  constructor(private readonly content: ContentStore) {}

  run(world: World, events: EventEmitter, dt: number): void {
    const cfg = this.content.getGameConfig().survival;

    for (const { entityId, hunger, thirst, health } of world.query(Hunger, Thirst, Health)) {
      const newHunger = Math.min(100, hunger.value + cfg.hungerRatePerSec * dt);
      const newThirst = Math.min(100, thirst.value + cfg.thirstRatePerSec * dt);

      world.set(entityId, Hunger, { value: newHunger });
      world.set(entityId, Thirst, { value: newThirst });

      if (newHunger >= cfg.hungerCritical && hunger.value < cfg.hungerCritical) {
        log.info("hunger critical: entity=%s value=%.1f", entityId, newHunger);
        events.publish(TileEvents.HungerCritical, { entityId, value: newHunger });
      }
      if (newThirst >= cfg.thirstCritical && thirst.value < cfg.thirstCritical) {
        log.info("thirst critical: entity=%s value=%.1f", entityId, newThirst);
        events.publish(TileEvents.ThirstCritical, { entityId, value: newThirst });
      }

      let dmg = 0;
      if (newHunger >= 100) dmg += cfg.starvationDps * dt;
      if (newThirst >= 100) dmg += cfg.dehydrationDps * dt;
      if (dmg > 0) {
        log.debug("starvation/dehydration: entity=%s dmg=%.3f hp=%.1f", entityId, dmg, health.current - dmg);
        world.set(entityId, Health, { ...health, current: Math.max(0, health.current - dmg) });
      }
    }
  }
}
