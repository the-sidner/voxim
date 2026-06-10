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
 * Deferred absolute write of one resource key (seed / reset a timer or
 * gauge), preserving sibling keys whatever earlier ops did. Creates the
 * `Resource` component when the entity doesn't carry one yet (committed
 * view) — the node respawn-timer / crafting-timer install path.
 */
export function upsertResourceKey(
  world: World,
  entityId: EntityId,
  key: string,
  value: number,
  max: number,
): void {
  if (world.has(entityId, Resource)) {
    world.mutate(entityId, Resource, (r) => ({
      values: { ...r.values, [key]: { value, max } },
    }));
  } else {
    world.set(entityId, Resource, { values: { [key]: { value, max } } });
  }
}
