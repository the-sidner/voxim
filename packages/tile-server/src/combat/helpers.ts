/**
 * Combat / action helpers shared across systems.
 *
 * Stamina is a `Resource` (T-238b) — `Resource.values.stamina`. These
 * helpers read/spend it; `ResourceSystem` owns regen + clamping. There is
 * no `exhausted` flag any more — "exhausted" is exactly `value <= 0`.
 *
 * Arithmetic only — never publish events. Callers own logging / events.
 */
import type { World, EntityId } from "@voxim/engine";
import { Resource } from "../components/resource.ts";

/**
 * Ticks a cooldown down by one, clamped at zero. Use inside a system's tick
 * loop when an integer counter represents "ticks remaining until ready".
 */
export function decrementCooldown(value: number): number {
  return value > 0 ? value - 1 : 0;
}

/** Current stamina value (0 if the entity carries no stamina resource). */
export function staminaValue(world: World, entityId: EntityId): number {
  return world.get(entityId, Resource)?.values.stamina?.value ?? 0;
}

/**
 * Spend `cost` stamina via a deferred write. Returns true if it was paid
 * (enough available), false otherwise. Cost ≤ 0 always pays. Missing
 * stamina resource fails unless cost is zero.
 */
export function spendStamina(world: World, entityId: EntityId, cost: number): boolean {
  if (cost <= 0) return true;
  const res = world.get(entityId, Resource);
  const st = res?.values.stamina;
  if (!res || !st || st.value < cost) return false;
  world.set(entityId, Resource, {
    values: { ...res.values, stamina: { value: Math.max(0, st.value - cost), max: st.max } },
  });
  return true;
}
