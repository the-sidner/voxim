import type { World } from "@voxim/engine";
import { TileEvents } from "@voxim/protocol";
import type { ContentStore } from "@voxim/content";
import type { System, EventEmitter } from "../system.ts";
import { WorldClock, timeOfDay } from "../components/world.ts";
import { createLogger } from "../logger.ts";
import type { Logger } from "../logger.ts";

const log = createLogger("DayNightSystem");

export class DayNightSystem implements System {
  constructor(private readonly content: ContentStore) {}

  run(world: World, events: EventEmitter, _dt: number): void {
    const cfg = this.content.getGameConfig().dayNight;

    for (const { entityId, worldClock } of world.query(WorldClock)) {
      const prevT = timeOfDay(worldClock);
      const nextTicks = worldClock.ticksElapsed + 1;
      const nextClock = { ...worldClock, ticksElapsed: nextTicks };
      const nextT = timeOfDay(nextClock);

      world.set(entityId, WorldClock, nextClock);

      checkPhase(prevT, nextT, cfg.dawnStart, "dawn", events, log);
      checkPhase(prevT, nextT, cfg.noonStart, "noon", events, log);
      checkPhase(prevT, nextT, cfg.duskStart, "dusk", events, log);

      if (Math.floor(worldClock.ticksElapsed / worldClock.dayLengthTicks) <
          Math.floor(nextTicks / worldClock.dayLengthTicks)) {
        log.info("phase transition: midnight (day %d)",
          Math.floor(nextTicks / worldClock.dayLengthTicks));
        events.publish(TileEvents.DayPhaseChanged, { phase: "midnight", timeOfDay: 0 });
      }
    }
  }
}

function checkPhase(
  prevT: number,
  nextT: number,
  boundary: number,
  phase: string,
  events: EventEmitter,
  logger: Logger,
): void {
  if (prevT < boundary && nextT >= boundary) {
    logger.info("phase transition: %s (t=%.4f)", phase, nextT);
    events.publish(TileEvents.DayPhaseChanged, { phase, timeOfDay: nextT });
  }
}
