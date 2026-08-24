/**
 * Composing Resource-key writes (T-249 move 2).
 *
 * Every concurrent contributor to a `Resource` component (regen, spend,
 * poise hit, item use, NPC feeding) goes through these instead of
 * whole-component `world.set` — the mutates run at commit against the
 * value after earlier ops this tick, so a stamina spend and the regen
 * tick compose instead of last-write-wins clobbering each other.
 */

import type { World, EntityId } from "@voxim/engine";
import { Resource } from "../components/resource.ts";

/**
 * Deferred, composing delta on one resource key:
 * `value += delta`, clamped to `[min, key.max]`.
 * Missing component or key → no-op (mutate contract).
 */
export function adjustResourceKey(
  world: World,
  entityId: EntityId,
  key: string,
  delta: number,
  min = 0,
): void {
  world.mutate(entityId, Resource, (r) => {
    const rv = r.values[key];
    if (!rv) return r;
    const next = Math.max(min, Math.min(rv.max, rv.value + delta));
    if (next === rv.value) return r;
    return { values: { ...r.values, [key]: { value: next, max: rv.max } } };
  });
}

/**
 * Entities whose Resource component already got a creating `world.set`
 * queued THIS TICK, by any of `upsertResourceKey`'s call sites (T-363,
 * the stampedThisRun pattern from ce84943d). `world.has` reads the
 * COMMITTED view, so two same-tick callers seeding DIFFERENT keys on a
 * fresh entity (a POI proc and a parry's counter_window landing on the
 * same player this tick, say) would both see "absent" and both take the
 * creating `world.set` path — the second set replaces `values` wholesale
 * in the op-log, silently dropping the first caller's key. The first
 * upsert for a committed-absent entity sets; every later upsert that tick
 * mutates, composing on the creating set via the op-log (T-249) instead of
 * clobbering it. Cleared once per tick from server.ts, before any system
 * runs — callers span multiple systems/handlers, not one system's own
 * run(), so the reset can't live on a single class field the way
 * ActionDispatcher/TriggerSystem clear theirs.
 */
const stampedThisTick = new Set<EntityId>();

/** Clear the same-tick creation-stamp tracking. Call once per tick, before any system runs. */
export function resetResourceStamps(): void {
  stampedThisTick.clear();
}

/**
 * Deferred absolute write of one resource key (seed / reset a timer or
 * gauge), preserving sibling keys whatever earlier ops did. Creates the
 * `Resource` component when the entity doesn't carry one yet (committed
 * view, or already stamped this tick) — the node respawn-timer /
 * crafting-timer install path.
 */
export function upsertResourceKey(
  world: World,
  entityId: EntityId,
  key: string,
  value: number,
  max: number,
): void {
  if (world.has(entityId, Resource) || stampedThisTick.has(entityId)) {
    world.mutate(entityId, Resource, (r) => ({
      values: { ...r.values, [key]: { value, max } },
    }));
  } else {
    world.set(entityId, Resource, { values: { [key]: { value, max } } });
    stampedThisTick.add(entityId);
  }
}
