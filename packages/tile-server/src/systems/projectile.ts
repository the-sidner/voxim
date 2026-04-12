/**
 * ProjectileSystem — advances projectile entities each tick.
 *
 * Responsibilities:
 *   - Apply velocity (position += velocity × dt)
 *   - Apply gravity (velocity.z -= gravity × gravityScale × dt)
 *   - Terrain collision: destroy if z ≤ heightmap height at (x, y)
 *   - Entity collision via SpatialGrid + Hitbox capsule sweep test
 *   - On entity hit: dispatch to the same HitHandler[] chain as melee
 *   - Destroy when maxHits reached or Lifetime expires (Lifetime handled by LifetimeSystem)
 *
 * Projectile hits pass parryAllowed: false — the attacker is far away and
 * cannot be staggered regardless of the defender's block timing.
 *
 * Runs after ActionSystem so projectiles spawned this tick are advanced next tick
 * (spawn via world.write() → already committed when systems run; but ordering still
 * ensures ActionSystem sees clean state before we process new projectiles).
 */
import type { World, EntityId } from "@voxim/engine";
import { Heightmap, CHUNK_SIZE } from "@voxim/world";
import { localToWorld, segSegDistSq } from "@voxim/content";
import type { ContentStore } from "@voxim/content";
import type { Vec3 } from "@voxim/content";
import { TileEvents } from "@voxim/protocol";
import type { System, EventEmitter, TickContext } from "../system.ts";
import { Position, Velocity, Facing, InputState } from "../components/game.ts";
import type { PositionData, VelocityData } from "../components/game.ts";
import { Hitbox } from "../components/hitbox.ts";
import { ProjectileData } from "../components/projectile.ts";
import type { HitHandler, HitContext } from "../hit_handler.ts";
import type { SpatialGrid } from "../spatial_grid.ts";
import type { DerivedItemStats } from "@voxim/content";
import { createLogger } from "../logger.ts";

const log = createLogger("ProjectileSystem");

export class ProjectileSystem implements System {
  private spatial: SpatialGrid | null = null;

  constructor(
    private readonly content: ContentStore,
    private readonly handlers: HitHandler[],
  ) {}

  prepare(_tick: number, ctx: TickContext): void {
    this.spatial = ctx.spatial;
  }

  run(world: World, events: EventEmitter, dt: number): void {
    if (!this.spatial) return;

    const gravity = this.content.getGameConfig().physics.gravity;

    // Collect projectiles to destroy after the entity loop (no world.destroy inside inner loop)
    const toDestroy = new Set<EntityId>();

    for (const { entityId, projectileData, position, velocity } of world.query(ProjectileData, Position, Velocity)) {
      if (toDestroy.has(entityId)) continue;

      const prevPos: Vec3 = { x: position.x, y: position.y, z: position.z };

      // ── Physics step ────────────────────────────────────────────────────────
      const newVelZ = velocity.z - gravity * projectileData.gravityScale * dt;
      const newPos: PositionData = {
        x: position.x + velocity.x * dt,
        y: position.y + velocity.y * dt,
        z: position.z + velocity.z * dt,
      };
      const newVel: VelocityData = { x: velocity.x, y: velocity.y, z: newVelZ };

      // ── Terrain collision ────────────────────────────────────────────────────
      const terrainZ = this.getTerrainHeight(world, newPos.x, newPos.y);
      if (newPos.z <= terrainZ) {
        log.info("projectile terrain hit: entity=%s pos=(%.1f,%.1f,%.1f) terrain=%.2f",
          entityId, newPos.x, newPos.y, newPos.z, terrainZ);
        toDestroy.add(entityId);
        continue;
      }

      // ── Entity collision ─────────────────────────────────────────────────────
      // Broad-phase: spatial grid candidates within radius + generous margin
      const broadRadius = projectileData.radius + 2.0;
      const candidates = this.spatial.nearby(newPos.x, newPos.y, broadRadius);

      let hitEntities = projectileData.hitEntities;
      let hitCount = hitEntities.length;

      for (const candidateId of candidates) {
        if (candidateId === entityId) continue;
        if (candidateId === projectileData.ownerId) continue;
        if (!world.isAlive(candidateId)) continue;
        if (hitEntities.includes(candidateId)) continue;
        if (projectileData.maxHits > 0 && hitCount >= projectileData.maxHits) break;

        const hitbox = world.get(candidateId, Hitbox);
        if (!hitbox || hitbox.parts.length === 0) continue;

        const targetPos = world.get(candidateId, Position);
        if (!targetPos) continue;

        // Use current world state — projectiles are server-authoritative, no lag comp needed
        const targetFacing = world.get(candidateId, Facing)?.angle
          ?? world.get(candidateId, InputState)?.facing
          ?? 0;
        const targetActions = world.get(candidateId, InputState)?.actions ?? 0;

        // Segment from prevPos → newPos (projectile trajectory this tick)
        const p0: Vec3 = prevPos;
        const p1: Vec3 = { x: newPos.x, y: newPos.y, z: newPos.z };
        const tPos: Vec3 = { x: targetPos.x, y: targetPos.y, z: targetPos.z };

        let hitBodyPart = "";
        for (const part of hitbox.parts) {
          const partFrom = localToWorld(part.fromFwd, part.fromRight, part.fromUp, tPos, targetFacing);
          const partTo   = localToWorld(part.toFwd,   part.toRight,   part.toUp,   tPos, targetFacing);

          const combinedRadiusSq = (projectileData.radius + part.radius) ** 2;
          const distSq = segSegDistSq(p0, p1, partFrom, partTo);
          if (distSq <= combinedRadiusSq) {
            hitBodyPart = part.id;
            break;
          }
        }

        if (!hitBodyPart) continue;

        log.info("projectile hit: entity=%s owner=%s target=%s part=%s",
          entityId, projectileData.ownerId, candidateId, hitBodyPart);

        hitEntities = [...hitEntities, candidateId];
        hitCount = hitEntities.length;

        // Reconstruct DerivedItemStats from the flat fields stored in ProjectileData
        const weaponStats: DerivedItemStats = {
          damage: projectileData.damage,
          toolType: projectileData.toolType || undefined,
          harvestPower: projectileData.harvestPower,
          buildPower: projectileData.buildPower,
          armorReduction: projectileData.armorReduction,
          weight: 0,
        };

        const ctx: HitContext = {
          attackerId: projectileData.ownerId,
          targetId: candidateId,
          weaponStats,
          bodyPart: hitBodyPart,
          // Projectiles use current world state — no lag rewind needed
          targetSnapshotFacing: targetFacing,
          targetSnapshotActions: targetActions,
          attackerX: prevPos.x,
          attackerY: prevPos.y,
          targetX: targetPos.x,
          targetY: targetPos.y,
          hitX: newPos.x,
          hitY: newPos.y,
          hitZ: newPos.z,
          parryAllowed: false,
        };

        events.publish(TileEvents.HitSpark, { x: newPos.x, y: newPos.y, z: newPos.z });

        for (const handler of this.handlers) {
          handler.onHit(world, events, ctx);
        }

        // Check if max hits reached after this hit
        if (projectileData.maxHits > 0 && hitCount >= projectileData.maxHits) {
          toDestroy.add(entityId);
          break;
        }
      }

      if (toDestroy.has(entityId)) continue;

      // ── Commit physics + updated hitEntities ─────────────────────────────────
      world.set(entityId, Position, newPos);
      world.set(entityId, Velocity, newVel);
      if (hitEntities !== projectileData.hitEntities) {
        world.set(entityId, ProjectileData, { ...projectileData, hitEntities });
      }
    }

    // Destroy spent projectiles outside the entity loop
    for (const id of toDestroy) {
      world.destroy(id);
    }
  }

  /** Returns the terrain heightmap value at (x, y), or 0 if no heightmap covers that cell. */
  private getTerrainHeight(world: World, x: number, y: number): number {
    const cellX = Math.floor(x);
    const cellY = Math.floor(y);
    const chunkX = Math.floor(cellX / CHUNK_SIZE);
    const chunkY = Math.floor(cellY / CHUNK_SIZE);
    const localX = ((cellX % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
    const localY = ((cellY % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
    const idx = localX + localY * CHUNK_SIZE;
    for (const { heightmap } of world.query(Heightmap)) {
      if (heightmap.chunkX !== chunkX || heightmap.chunkY !== chunkY) continue;
      return heightmap.data[idx];
    }
    return 0; // fallback
  }
}
