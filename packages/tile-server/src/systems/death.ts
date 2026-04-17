/**
 * DeathSystem — the single place entities die from health loss.
 *
 * Runs last in the tick chain. Other systems publish `RequestDeath` via the
 * `DeathRequestPort` (not a deferred event — direct port, processed same tick).
 *
 * Per request:
 *   1. Skip if entity was already destroyed earlier this tick (dedupe).
 *   2. Run all registered `DeathHook`s. Hooks can read entity state before
 *      destruction (loot drops, heir spawning, corpse placement).
 *   3. Publish `TileEvents.EntityDied` on the deferred queue.
 *   4. Destroy the entity.
 */
import type { World, EntityId, Registry } from "@voxim/engine";
import { TileEvents } from "@voxim/protocol";
import type { System, EventEmitter } from "../system.ts";
import type {
  DeathCause,
  DeathRequestPort,
  RequestDeathPayload,
} from "../events/death.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("DeathSystem");

export interface DeathHookContext {
  readonly world: World;
  readonly events: EventEmitter;
  readonly entityId: EntityId;
  readonly killerId?: EntityId;
  readonly cause: DeathCause;
}

export interface DeathHook {
  readonly id: string;
  onDeath(ctx: DeathHookContext): void;
}

export class DeathSystem implements System, DeathRequestPort {
  private pending: RequestDeathPayload[] = [];

  constructor(private readonly hooks: Registry<DeathHook>) {}

  request(payload: RequestDeathPayload): void {
    this.pending.push(payload);
  }

  run(world: World, events: EventEmitter, _dt: number): void {
    if (this.pending.length === 0) return;

    const pending = this.pending;
    this.pending = [];

    const seen = new Set<EntityId>();
    for (const p of pending) {
      if (seen.has(p.entityId)) continue;
      if (!world.isAlive(p.entityId)) continue;
      seen.add(p.entityId);

      for (const hookId of this.hooks.ids()) {
        this.hooks.get(hookId).onDeath({
          world,
          events,
          entityId: p.entityId,
          killerId: p.killerId,
          cause: p.cause,
        });
      }

      events.publish(TileEvents.EntityDied, { entityId: p.entityId, killerId: p.killerId });
      log.debug("death: entity=%s killer=%s cause=%s", p.entityId, p.killerId ?? "none", p.cause);

      world.destroy(p.entityId);
    }
  }
}
