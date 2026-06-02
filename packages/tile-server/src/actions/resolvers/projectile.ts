/**
 * projectile_trace effect resolver (T-243) — projectile flight on the
 * action substrate.
 *
 * The `hold:tick` of the `projectile_flight` ambient action. Replaces the
 * bespoke `ProjectileSystem`: a projectile is a real world entity with
 * physicality, so its per-tick flight is an effect the dispatcher fires
 * (the buff-child precedent, T-239), not a parallel System.
 *
 * Per tick, for the projectile `ctx.entityId`:
 *   - Ballistic step (gravity + integration, shared `ballisticStep`)
 *   - Terrain collision: destroy if z ≤ heightmap height at (x, y)
 *   - Entity collision: broad-phase over `query(Hitbox, Position)` + XY
 *     distance cull (the same candidate-loop shape as weapon_trace; no
 *     spatial-grid threading into the effect layer), capsule test, dedup
 *     via `ProjectileData.hitEntities`, dispatch to the shared
 *     `HitHandler[]` chain (identical to melee)
 *   - Destroy when maxHits reached; lifetime expiry stays the `lifetime`
 *     Resource (cross@0 → destroy_self, T-241)
 *
 * Projectile hits pass `parryAllowed: false` — the attacker is far away
 * and cannot be staggered regardless of the defender's block timing.
 * Projectiles use current world state (no lag-comp rewind): they are
 * server-authoritative, born on the server, not predicted by the client.
 */

import type { Vec3 } from "@voxim/content";
import { Position, Velocity, Facing, InputState } from "../../components/game.ts";
import { Hitbox } from "../../components/hitbox.ts";
import { ProjectileData } from "../../components/projectile.ts";
import type { HitHandler, HitContext } from "../../hit_handler.ts";
import { dispatchSweepHit } from "../../combat/sweep.ts";
import { buildTerrainLookup } from "../../physics/terrain_lookup.ts";
import { ballisticStep } from "../../physics/ballistic.ts";
import type { EffectResolver, ResolveContext } from "../effect.ts";
import { createLogger } from "../../logger.ts";

const log = createLogger("projectile_trace");

// Fixed 20 Hz tick — same convention as AnimationSystem's tick-derived math.
const TICK_DT = 1 / 20;

export class ProjectileTraceResolver implements EffectResolver {
  readonly id = "projectile_trace";

  constructor(private readonly handlers: readonly HitHandler[]) {}

  resolve(ctx: ResolveContext): void {
    const { world, events, entityId, content } = ctx;

    const projectileData = world.get(entityId, ProjectileData);
    const position = world.get(entityId, Position);
    const velocity = world.get(entityId, Velocity);
    if (!projectileData || !position || !velocity) return;

    const gravity = content.getGameConfig().physics.gravity;
    const getTerrainHeight = buildTerrainLookup(world);

    const prevPos: Vec3 = { x: position.x, y: position.y, z: position.z };

    // ── Physics step ────────────────────────────────────────────────────────
    const stepped = ballisticStep(
      { pos: prevPos, vel: { x: velocity.x, y: velocity.y, z: velocity.z } },
      gravity,
      projectileData.gravityScale,
      TICK_DT,
    );
    const newPos = stepped.pos;
    const newVel = stepped.vel;

    // ── Terrain collision ────────────────────────────────────────────────────
    const terrainZ = getTerrainHeight(newPos.x, newPos.y);
    if (newPos.z <= terrainZ) {
      log.info("projectile terrain hit: entity=%s pos=(%.1f,%.1f,%.1f) terrain=%.2f",
        entityId, newPos.x, newPos.y, newPos.z, terrainZ);
      world.destroy(entityId);
      return;
    }

    // ── Entity collision ─────────────────────────────────────────────────────
    // Broad-phase: every entity with a hitbox, culled by XY distance to the
    // projectile this tick (the same candidate-set shape weapon_trace uses
    // over its rewind snapshot; projectile/hitbox counts are bounded).
    const broadRadius = projectileData.radius + 2.0;
    const broadRadiusSq = broadRadius * broadRadius;

    let hitEntities = projectileData.hitEntities;
    let hitCount = hitEntities.length;
    let destroyed = false;

    for (const { entityId: candidateId, position: targetPos, hitbox } of world.query(Hitbox, Position)) {
      if (candidateId === entityId) continue;
      if (candidateId === projectileData.ownerId) continue;
      if (hitEntities.includes(candidateId)) continue;
      if (projectileData.maxHits > 0 && hitCount >= projectileData.maxHits) break;
      if (hitbox.parts.length === 0) continue;

      const dx = targetPos.x - newPos.x;
      const dy = targetPos.y - newPos.y;
      if (dx * dx + dy * dy > broadRadiusSq) continue;

      // Use current world state — projectiles are server-authoritative, no lag comp needed
      const targetFacing = world.get(candidateId, Facing)?.angle
        ?? world.get(candidateId, InputState)?.facing
        ?? 0;

      // Projectile trajectory for this tick: prevPos → newPos.
      // Single segment (no swept prev/curr) — projectiles are small and fast,
      // but the tick dt is short enough that a single segment is faithful.
      const tPos: Vec3 = { x: targetPos.x, y: targetPos.y, z: targetPos.z };

      // Shared dispatch tail with weapon_trace: test → HitSpark → handlers.
      const hit = dispatchSweepHit(
        world, events, this.handlers, hitbox, tPos, targetFacing, projectileData.radius,
        [{ from: prevPos, to: { x: newPos.x, y: newPos.y, z: newPos.z } }],
        (h): HitContext => ({
          attackerId: projectileData.ownerId,
          targetId: candidateId,
          // Reconstruct DerivedItemStats from the flat fields on ProjectileData
          weaponStats: {
            damage: projectileData.damage,
            toolType: projectileData.toolType || undefined,
            harvestPower: projectileData.harvestPower,
            buildPower: projectileData.buildPower,
            armorReduction: projectileData.armorReduction,
            weight: 0,
          },
          bodyPart: h.partId,
          // Projectiles always strike with their point — the "tip" attacker
          // part conceptually matches an arrowhead / bolt-tip impact and
          // picks up the tip damage multiplier from game_config.
          attackerPart: "tip",
          // Projectiles use current world state — no lag rewind needed.
          // HitSpark fires at the trajectory end (newPos), as before.
          targetSnapshotFacing: targetFacing,
          attackerX: prevPos.x,
          attackerY: prevPos.y,
          targetX: targetPos.x,
          targetY: targetPos.y,
          hitX: newPos.x,
          hitY: newPos.y,
          hitZ: newPos.z,
          parryAllowed: false,
        }),
      );
      if (!hit) continue;

      log.info("projectile hit: entity=%s owner=%s target=%s part=%s",
        entityId, projectileData.ownerId, candidateId, hit.partId);

      hitEntities = [...hitEntities, candidateId];
      hitCount = hitEntities.length;

      // Check if max hits reached after this hit
      if (projectileData.maxHits > 0 && hitCount >= projectileData.maxHits) {
        world.destroy(entityId);
        destroyed = true;
        break;
      }
    }

    if (destroyed) return;

    // ── Commit physics + updated hitEntities ─────────────────────────────────
    world.set(entityId, Position, newPos);
    world.set(entityId, Velocity, newVel);
    if (hitEntities !== projectileData.hitEntities) {
      world.set(entityId, ProjectileData, { ...projectileData, hitEntities });
    }
  }
}
