/**
 * ItemPhysicsSystem — advances ejected ground items each tick.
 *
 * Processes any entity with ItemData + Position + Velocity.  Spawned drops
 * that should fly out of the source (resource node yields, future "thrown
 * away" stacks) get an initial Velocity at spawn time; this system steps
 * them under gravity until they hit the terrain, then settles them on the
 * nearest free cell and removes the Velocity component so the entity
 * drops out of the query forever after.  Resting items have no Velocity
 * and are not touched.
 *
 * Uses the shared physics substrate (buildTerrainLookup + ballisticStep)
 * — same kinematics math as ProjectileSystem; this system just encodes
 * the "settle" policy on terrain contact instead of "destroy".
 */
import type { World, EntityId } from "@voxim/engine";
import type { ContentService } from "@voxim/content";
import type { System, EventEmitter } from "../system.ts";
import { Position, Velocity } from "../components/game.ts";
import { ItemData } from "../components/items.ts";
import { buildTerrainLookup } from "../physics/terrain_lookup.ts";
import { ballisticStep } from "../physics/ballistic.ts";
import { findFreeDropCell } from "../spawner.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("ItemPhysicsSystem");

export class ItemPhysicsSystem implements System {
  constructor(private readonly content: ContentService) {}

  run(world: World, _events: EventEmitter, dt: number): void {
    const gravity = this.content.getGameConfig().physics.gravity;
    const getTerrainHeight = buildTerrainLookup(world);

    const settled: Array<{ entityId: EntityId; pos: { x: number; y: number; z: number } }> = [];
    const inFlight: Array<{ entityId: EntityId; pos: { x: number; y: number; z: number }; vel: { x: number; y: number; z: number } }> = [];

    for (const { entityId, position, velocity } of world.query(ItemData, Position, Velocity)) {
      const stepped = ballisticStep(
        { pos: position, vel: velocity },
        gravity,
        1.0,
        dt,
      );

      const terrainZ = getTerrainHeight(stepped.pos.x, stepped.pos.y);
      if (stepped.pos.z <= terrainZ && stepped.vel.z <= 0) {
        // Landed — defer the world write so we can run findFreeDropCell after
        // the query completes (it issues its own world.query and would reuse
        // the iterator otherwise).
        settled.push({
          entityId,
          pos: { x: stepped.pos.x, y: stepped.pos.y, z: terrainZ },
        });
      } else {
        inFlight.push({ entityId, pos: stepped.pos, vel: stepped.vel });
      }
    }

    for (const { entityId, pos, vel } of inFlight) {
      world.set(entityId, Position, pos);
      world.set(entityId, Velocity, vel);
    }

    for (const { entityId, pos } of settled) {
      const free = findFreeDropCell(world, pos.x, pos.y, pos.z);
      world.set(entityId, Position, free);
      world.remove(entityId, Velocity);
      log.debug("item settled: entity=%s at (%.1f,%.1f)", entityId, free.x, free.y);
    }
  }
}
