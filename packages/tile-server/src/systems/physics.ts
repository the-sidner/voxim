import type { World } from "@voxim/engine";
import { stepPhysics, vec2Normalize } from "@voxim/engine";
import type { PhysicsConfig } from "@voxim/engine";
import { ACTION_JUMP, ACTION_CROUCH, hasAction } from "@voxim/protocol";
import type { ContentService } from "@voxim/content";
import type { System, EventEmitter } from "../system.ts";
import { createLogger } from "../logger.ts";
import { Position, Velocity, Facing, InputState } from "../components/game.ts";
import { Sidestep, Airborne, ActionImpulse } from "../components/combat.ts";
import type { TickEventBuffer } from "../tick_events.ts";
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

  /**
   * Per-entity counter of consecutive ticks the entity's feet have been off
   * ground. Used to suppress single-frame false airborne reports caused by
   * tiny terrain ridges, slope micro-bumps, and integration jitter — only
   * commit Airborne / fire event.left_ground once the entity has actually
   * been clear of the ground for COYOTE_TICKS in a row.
   */
  private offGroundTicks = new Map<string, number>();

  constructor(
    private readonly content: ContentService,
    private readonly tickEvents: TickEventBuffer,
  ) {}

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

      // Sidestep locks horizontal velocity to the committed dash vector.
      // We synthesise an input matching that direction and override
      // maxGroundSpeed so stepPhysics's "snap velocity to input × speed"
      // branch produces exactly (vx, vy). Passing movement=(0,0) instead
      // would trigger the on-ground "instant stop" drag and zero the dash
      // before integration.
      const sidestep = world.get(entityId, Sidestep);
      const jump = !sidestep && hasAction(inputState.actions, ACTION_JUMP);

      if (jump && onGround) {
        log.debug("jump: entity=%s pos=(%.1f,%.1f,%.1f)", entityId, position.x, position.y, position.z);
      }

      const speedMod = world.get(entityId, SpeedModifier);
      const crouching = !sidestep && hasAction(inputState.actions, ACTION_CROUCH);
      let speedMultiplier = speedMod?.multiplier ?? 1.0;
      if (crouching) speedMultiplier *= crouchSpeedMultiplier;

      let movement: { x: number; y: number };
      let physicsConfig = baseConfig;
      // ActionImpulse (T-199): swing root-motion push. Same override
      // mechanism as Sidestep — synthesise a movement vector in the impulse
      // direction at the impulse magnitude. Sidestep wins over ActionImpulse
      // when both are present (sidestep is an explicit player commit).
      // SpeedModifier scales the impulse so slow debuffs suppress the push.
      const impulse = !sidestep ? world.get(entityId, ActionImpulse) : null;
      if (sidestep) {
        const dashSpeed = Math.sqrt(sidestep.vx * sidestep.vx + sidestep.vy * sidestep.vy);
        movement = dashSpeed > 0
          ? { x: sidestep.vx / dashSpeed, y: sidestep.vy / dashSpeed }
          : { x: 0, y: 0 };
        physicsConfig = { ...baseConfig, maxGroundSpeed: dashSpeed };
      } else if (impulse) {
        const impulseSpeed = Math.sqrt(impulse.vx * impulse.vx + impulse.vy * impulse.vy) * speedMultiplier;
        movement = impulseSpeed > 0
          ? { x: impulse.vx / Math.sqrt(impulse.vx * impulse.vx + impulse.vy * impulse.vy),
              y: impulse.vy / Math.sqrt(impulse.vx * impulse.vx + impulse.vy * impulse.vy) }
          : { x: 0, y: 0 };
        physicsConfig = { ...baseConfig, maxGroundSpeed: impulseSpeed };
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

      // Tick down (or remove) any active ActionImpulse — one tick = one
      // physics integration. PhysicsSystem is the single point of
      // bookkeeping since it's the one place that consumed the impulse.
      if (impulse) {
        const remaining = impulse.ticksRemaining - 1;
        if (remaining <= 0) world.remove(entityId, ActionImpulse);
        else world.set(entityId, ActionImpulse, { ...impulse, ticksRemaining: remaining });
      }
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
    // changeset owns the final state. Airborne is written/erased via
    // world.write so the same-tick CSM tick observes it without a one-frame
    // lag (CSM depends on PhysicsSystem and runs after it). Edges fire as
    // one-tick events for SM transitions that care about the moment of
    // takeoff/landing.
    for (const s of steps) {
      world.set(s.entityId, Position, s.position);
      world.set(s.entityId, Velocity, s.velocity);
      world.set(s.entityId, Facing, { angle: s.facing });

      const groundZ = getHeight(s.position.x, s.position.y);
      // Generous deadband (one stair step) plus coyote ticks so the SM never
      // sees airborne for terrain micro-bumps the player can walk through.
      const onGround = s.position.z <= groundZ + GROUND_TOLERANCE;
      const off = onGround ? 0 : (this.offGroundTicks.get(s.entityId) ?? 0) + 1;
      if (off === 0) this.offGroundTicks.delete(s.entityId);
      else this.offGroundTicks.set(s.entityId, off);

      const wasAirborne = world.has(s.entityId, Airborne);
      const shouldBeAirborne = off >= COYOTE_TICKS;
      if (shouldBeAirborne && !wasAirborne) {
        world.write(s.entityId, Airborne, {});
        this.tickEvents.fire(s.entityId, "event.left_ground");
      } else if (!shouldBeAirborne && wasAirborne) {
        world.erase(s.entityId, Airborne);
        this.tickEvents.fire(s.entityId, "event.landed");
      }
    }
  }
}

const GROUND_TOLERANCE = 0.15;
const COYOTE_TICKS = 3;

