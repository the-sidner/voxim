import type { World } from "@voxim/engine";
import type { System, EventEmitter } from "../system.ts";
import { Lifetime } from "../components/game.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("LifetimeSystem");

/**
 * Decrement the Lifetime counter each tick.
 * When it reaches zero, queue the entity for destruction.
 * No EntityDied event — projectile/effect expiry is not a "death".
 */
export class LifetimeSystem implements System {
  run(world: World, _events: EventEmitter, _dt: number): void {
    for (const { entityId, lifetime } of world.query(Lifetime)) {
      if (lifetime.ticks <= 0) {
        log.debug("lifetime expired: entity=%s", entityId);
        world.destroy(entityId);
      } else {
        world.set(entityId, Lifetime, { ticks: lifetime.ticks - 1 });
      }
    }
  }
}
