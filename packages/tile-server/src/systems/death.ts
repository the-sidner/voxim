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
 *   4. Destroy the entity — UNLESS some hook returned `{ linger: true }`
 *      (T-311 P5c: a corpse with a death-dissolve profile stays queryable/
 *      renderable for its dissolve_timer's duration; that Resource's own
 *      terminal threshold calls world.destroy once the dissolve finishes).
 *      EntityDied still publishes on schedule either way — "this entity
 *      died" and "this entity's world slot is now free" are separate facts.
 */
import type { World, EntityId, Registry } from "@voxim/engine";
import { TileEvents } from "@voxim/protocol";
import type { System, EventEmitter } from "../system.ts";
import { Health } from "../components/game.ts";
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

/** A hook that wants the entity to keep existing past this tick's
 *  DeathSystem pass returns `{ linger: true }` (T-311 P5c — a dissolving
 *  corpse). Any hook voting linger wins; `undefined`/`void` is the default
 *  "destroy immediately" behaviour every existing hook already has. */
export interface DeathHookResult {
  linger?: boolean;
}

export interface DeathHook {
  readonly id: string;
  onDeath(ctx: DeathHookContext): DeathHookResult | void;
}

export class DeathSystem implements System, DeathRequestPort {
  private pending: RequestDeathPayload[] = [];

  constructor(private readonly hooks: Registry<DeathHook>) {}

  request(payload: RequestDeathPayload): void {
    this.pending.push(payload);
  }

  run(world: World, events: EventEmitter, _dt: number): void {
    // Composed-lethal sweep (T-249): each damage writer's own death check
    // sees only committed state, so two individually-survivable hits whose
    // mutates compose to ≤0 kill nobody at hit time. Catch them here — one
    // tick after the composed total commits.
    for (const { entityId, health } of world.query(Health)) {
      if (health.current <= 0) {
        this.pending.push({ entityId, cause: "effect" });
      }
    }

    if (this.pending.length === 0) return;

    const pending = this.pending;
    this.pending = [];

    const seen = new Set<EntityId>();
    for (const p of pending) {
      if (seen.has(p.entityId)) continue;
      if (!world.isAlive(p.entityId)) continue;
      seen.add(p.entityId);

      let linger = false;
      for (const hookId of this.hooks.ids()) {
        const result = this.hooks.get(hookId).onDeath({
          world,
          events,
          entityId: p.entityId,
          killerId: p.killerId,
          cause: p.cause,
        });
        if (result?.linger) linger = true;
      }

      events.publish(TileEvents.EntityDied, { entityId: p.entityId, killerId: p.killerId });
      log.debug("death: entity=%s killer=%s cause=%s linger=%s", p.entityId, p.killerId ?? "none", p.cause, linger);

      if (!linger) world.destroy(p.entityId);
    }
  }
}
