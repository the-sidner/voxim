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
  /**
   * Corpses a hook voted `{ linger: true }` for (T-311 P5c dissolving
   * corpses). A lingering corpse keeps `Health.current = 0`, so without this
   * set the composed-lethal sweep below would re-request its death EVERY
   * tick — re-running the hooks, whose `world.set` re-seeded `dissolve_timer`
   * back to full after ResourceSystem's same-tick decrement in the op-log.
   * Net effect: the timer sat pinned at max and no corpse ever dissolved
   * (found live via the I3b measurement; regression-pinned in
   * shed_dissolve.test.ts). An entity dies through the hook pipeline exactly
   * ONCE; its world removal is the dissolve timer's `destroy_self`. The set
   * is swept of destroyed ids each run so it can't grow unbounded.
   */
  private readonly lingering = new Set<EntityId>();

  constructor(private readonly hooks: Registry<DeathHook>) {}

  request(payload: RequestDeathPayload): void {
    this.pending.push(payload);
  }

  run(world: World, events: EventEmitter, _dt: number): void {
    // Purge lingering ids whose corpse has since been destroyed
    // (dissolve_timer's destroy_self, tile transitions, …).
    for (const id of this.lingering) {
      if (!world.isAlive(id)) this.lingering.delete(id);
    }

    // Composed-lethal sweep (T-249): each damage writer's own death check
    // sees only committed state, so two individually-survivable hits whose
    // mutates compose to ≤0 kill nobody at hit time. Catch them here — one
    // tick after the composed total commits. Lingering corpses stay at
    // health 0 by design — they already died; skip them.
    for (const { entityId, health } of world.query(Health)) {
      if (health.current <= 0 && !this.lingering.has(entityId)) {
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
      // A direct request() against an already-lingering corpse (e.g. a DoT
      // still ticking on it) must not re-run the death pipeline either.
      if (this.lingering.has(p.entityId)) continue;
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

      if (linger) this.lingering.add(p.entityId);
      // T-219: destroySubtree, not destroy -- every skeletal death now has
      // a real bone-entity subtree (and any still-attached scene-graph
      // children, e.g. buffs) that would otherwise leak forever. Degrades
      // to exactly destroy() for an entity with no children (unchanged
      // behaviour for non-skeletal deaths). destroyCarriedItemEntities (the
      // equip_cleanup DeathHook, already run above) is the ONLY thing that
      // cleans up plain never-parented unique inventory items -- kept as
      // is, harmless overlap with the subtree walk for equipped items.
      else world.destroySubtree(p.entityId);
    }
  }
}
