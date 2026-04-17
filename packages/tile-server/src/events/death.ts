/**
 * Death request — internal, server-only channel for entity destruction
 * triggered by health loss.
 *
 * Systems publish into `DeathRequestPort` instead of calling `world.destroy`.
 * `DeathSystem` collects requests during a tick, dedupes, runs registered
 * `DeathHook`s, emits `TileEvents.EntityDied`, and destroys.
 *
 * Non-death destroys (item pickup consumption, projectile expiry, blueprint
 * completion, resource node depletion, player disconnect) stay as direct
 * `world.destroy` calls — those aren't deaths.
 */
import type { EntityId } from "@voxim/engine";

export type DeathCause = "damage" | "starvation" | "corruption" | "effect";

export interface RequestDeathPayload {
  readonly entityId: EntityId;
  readonly killerId?: EntityId;
  readonly cause: DeathCause;
}

/** Port systems hold to request entity deaths; DeathSystem owns the queue. */
export interface DeathRequestPort {
  request(payload: RequestDeathPayload): void;
}
