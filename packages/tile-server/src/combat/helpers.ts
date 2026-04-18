/**
 * Combat / action helpers shared across systems.
 *
 * Factored out because the same arithmetic was repeated in 4+ places:
 *   - ActionSystem, SkillSystem, DodgeSystem: stamina deduction + exhausted flag
 *   - ActionSystem, SkillSystem, DodgeSystem, StaminaSystem: cooldown decrement
 *
 * These helpers only do arithmetic — they never publish events. Callers stay in
 * charge of logging / event emission.
 */
import type { World, EntityId } from "@voxim/engine";
import { Stamina } from "../components/game.ts";
import type { StaminaData } from "../components/game.ts";

/**
 * Ticks a cooldown down by one, clamped at zero. Use inside a system's tick
 * loop when an integer counter represents "ticks remaining until ready".
 */
export function decrementCooldown(value: number): number {
  return value > 0 ? value - 1 : 0;
}

/**
 * Deduct stamina cost via a deferred write, recomputing the `exhausted` flag.
 *
 * Returns true if the cost was paid (stamina was available), false otherwise.
 * A cost of 0 is always paid. Missing Stamina component returns false unless
 * the cost is zero.
 *
 * The current stamina value is threaded as a parameter so callers that already
 * read it (most do — they gate on it first) don't pay for the read twice.
 */
export function deductStamina(
  world: World,
  entityId: EntityId,
  stamina: StaminaData | null,
  cost: number,
): boolean {
  if (cost <= 0) return true;
  if (!stamina) return false;
  if (stamina.current < cost) return false;
  const next = Math.max(0, stamina.current - cost);
  world.set(entityId, Stamina, { ...stamina, current: next, exhausted: next <= 0 });
  return true;
}
