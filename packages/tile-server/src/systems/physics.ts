import type { World } from "@voxim/engine";
import { stepPhysics, vec2Normalize } from "@voxim/engine";
import type { PhysicsConfig } from "@voxim/engine";
import { ACTION_JUMP, ACTION_CROUCH, hasAction } from "@voxim/protocol";
import type { ContentStore } from "@voxim/content";
import type { System, EventEmitter } from "../system.ts";
import { createLogger } from "../logger.ts";
import { Position, Velocity, Facing, InputState } from "../components/game.ts";
import { Rolling } from "../components/combat.ts";
import { SpeedModifier } from "../components/world.ts";
import { buildTerrainLookup, buildOpennessLookup } from "../physics/terrain_lookup.ts";

const log = createLogger("PhysicsSystem");

/**
 * Physics system — runs every tick for all entities with Position + Velocity + InputState.
 *
 * Physics tuning values come from GameConfig.physics — no hardcoded constants.
 */
export class PhysicsSystem implements System {
  /** NpcAi writes NPC InputState via world.write() (immediate); must precede. */
  readonly dependsOn = ["NpcAiSystem"];

  constructor(private readonly content: ContentStore) {}

  run(world: World, _events: EventEmitter, dt: number): void {
    const gameCfg = this.content.getGameConfig();
    const cfgRaw = gameCfg.physics;
    const crouchSpeedMultiplier = gameCfg.crouch.speedMultiplier;
    const collisionRadius = cfgRaw.entityCollisionRadius;
    const baseConfig: PhysicsConfig = {
      gravity: cfgRaw.gravity,
      maxGroundSpeed: cfgRaw.maxGroundSpeed,
      groundAccel: cfgRaw.groundAccel,
      airControlMult: cfgRaw.airControlMult,
      dragRetainPerSec: cfgRaw.dragRetainPerSec,
      jumpImpulse: cfgRaw.jumpImpulse,
      stepHeight: cfgRaw.stepHeight,
    };

    const getHeight = buildTerrainLookup(world);
    const isOpen    = buildOpennessLookup(world);

    // Pass 1 — integrate every moving entity into a local map. We defer
    // writes so the post-integration entity-vs-entity separation pass can
    // mutate next positions before they land in the changeset.
    type Step = {
      entityId: string;
      position: { x: number; y: number; z: number };
      velocity: { x: number; y: number; z: number };
      facing:   number;
    };
    const steps: Step[] = [];
    for (const { entityId, position, velocity, inputState } of world.query(
      Position,
      Velocity,
      InputState,
    )) {
      const groundZ = getHeight(position.x, position.y);
      const onGround = position.z <= groundZ + 0.01;

      // Rolling locks horizontal velocity to the dodge vector. We synthesise
      // an input matching the roll direction and override maxGroundSpeed so
      // stepPhysics's "snap velocity to input × speed" branch produces exactly
      // (vx, vy). Passing movement=(0,0) instead would trigger the on-ground
      // "instant stop" drag and zero the dodge before integration.
      const rolling = world.get(entityId, Rolling);
      const jump = !rolling && hasAction(inputState.actions, ACTION_JUMP);

      if (jump && onGround) {
        log.debug("jump: entity=%s pos=(%.1f,%.1f,%.1f)", entityId, position.x, position.y, position.z);
      }

      const speedMod = world.get(entityId, SpeedModifier);
      const crouching = !rolling && hasAction(inputState.actions, ACTION_CROUCH);
      let speedMultiplier = speedMod?.multiplier ?? 1.0;
      if (crouching) speedMultiplier *= crouchSpeedMultiplier;

      let movement: { x: number; y: number };
      let physicsConfig = baseConfig;
      if (rolling) {
        const rollSpeed = Math.sqrt(rolling.vx * rolling.vx + rolling.vy * rolling.vy);
        movement = rollSpeed > 0
          ? { x: rolling.vx / rollSpeed, y: rolling.vy / rollSpeed }
          : { x: 0, y: 0 };
        physicsConfig = { ...baseConfig, maxGroundSpeed: rollSpeed };
      } else {
        movement = vec2Normalize({ x: inputState.movementX, y: inputState.movementY });
        if (speedMultiplier !== 1.0) {
          physicsConfig = { ...baseConfig, maxGroundSpeed: baseConfig.maxGroundSpeed * speedMultiplier };
        }
      }

      const next = stepPhysics(
        { position, velocity, onGround },
        { movement, jump },
        getHeight,
        dt,
        physicsConfig,
        isOpen,
      );

      steps.push({
        entityId,
        position: { ...next.position },
        velocity: { ...next.velocity },
        facing:   inputState.facing,
      });
    }

    // Pass 2 — pairwise XY soft separation. O(N²) is fine: physics-active
    // entities are players + NPCs in the live tile, typically < 100 in AoI.
    // Using SpatialGrid would only pay off at much higher densities.
    if (collisionRadius > 0) {
      const minSep = collisionRadius * 2;
      const minSepSq = minSep * minSep;
      for (let i = 0; i < steps.length; i++) {
        const a = steps[i];
        for (let j = i + 1; j < steps.length; j++) {
          const b = steps[j];
          const dx = b.position.x - a.position.x;
          const dy = b.position.y - a.position.y;
          const distSq = dx * dx + dy * dy;
          if (distSq >= minSepSq) continue;

          // Degenerate overlap (two entities at the exact same XY): nudge
          // along an arbitrary fixed axis so the next iteration separates
          // them properly. Picks +X for determinism — players spawning on
          // top of each other after reconnect end up side-by-side, not
          // randomly scattered.
          let nx: number, ny: number, dist: number;
          if (distSq < 1e-6) {
            nx = 1; ny = 0; dist = 0;
          } else {
            dist = Math.sqrt(distSq);
            nx = dx / dist;
            ny = dy / dist;
          }
          const overlap = (minSep - dist) * 0.5;
          a.position.x -= nx * overlap;
          a.position.y -= ny * overlap;
          b.position.x += nx * overlap;
          b.position.y += ny * overlap;
        }
      }
    }

    // Pass 3 — commit. Position/Velocity/Facing as deferred sets so the
    // changeset owns the final state.
    for (const s of steps) {
      world.set(s.entityId, Position, s.position);
      world.set(s.entityId, Velocity, s.velocity);
      world.set(s.entityId, Facing, { angle: s.facing });
    }
  }
}

