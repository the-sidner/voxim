/**
 * Shared helpers used by effect apply handlers.
 *
 * `addActiveEffect` appends to the ActiveEffects component.
 * `targetsInRange` / `nearestTarget` resolve targets via spatial grid when
 * available, falling back to a full world query otherwise.
 */
import type { World, EntityId } from "@voxim/engine";
import type { SpatialGrid } from "../spatial_grid.ts";
import { ActiveEffects } from "../components/lore_loadout.ts";
import type { ActiveEffect } from "../components/lore_loadout.ts";
import { Position, Health } from "../components/game.ts";

export function addActiveEffect(world: World, entityId: EntityId, effect: ActiveEffect): void {
  const current = world.get(entityId, ActiveEffects) ?? { effects: [] };
  world.set(entityId, ActiveEffects, { effects: [...current.effects, effect] });
}

export function targetsInRange(
  world: World,
  spatial: SpatialGrid | null,
  casterId: EntityId,
  cx: number,
  cy: number,
  range: number,
): EntityId[] {
  const rangeSq = range * range;
  const result: EntityId[] = [];
  const candidates = spatial
    ? spatial.nearby(cx, cy, range)
    : world.query(Position, Health).map((r) => r.entityId);
  for (const entityId of candidates) {
    if (entityId === casterId) continue;
    if (!world.get(entityId, Health)) continue;
    const pos = world.get(entityId, Position);
    if (!pos) continue;
    const dx = pos.x - cx;
    const dy = pos.y - cy;
    if (dx * dx + dy * dy <= rangeSq) result.push(entityId);
  }
  return result;
}

export function nearestTarget(
  world: World,
  spatial: SpatialGrid | null,
  casterId: EntityId,
  cx: number,
  cy: number,
  range: number,
): EntityId | null {
  const rangeSq = range * range;
  let nearestId: EntityId | null = null;
  let nearestDist = Infinity;
  const candidates = spatial
    ? spatial.nearby(cx, cy, range)
    : world.query(Position, Health).map((r) => r.entityId);
  for (const entityId of candidates) {
    if (entityId === casterId) continue;
    if (!world.get(entityId, Health)) continue;
    const pos = world.get(entityId, Position);
    if (!pos) continue;
    const dx = pos.x - cx;
    const dy = pos.y - cy;
    const d = dx * dx + dy * dy;
    if (d <= rangeSq && d < nearestDist) { nearestDist = d; nearestId = entityId; }
  }
  return nearestId;
}
