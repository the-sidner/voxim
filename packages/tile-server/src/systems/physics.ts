import type { World } from "@voxim/engine";
import { stepPhysics, vec2Normalize } from "@voxim/engine";
import type { PhysicsConfig } from "@voxim/engine";
import { ACTION_JUMP, ACTION_CROUCH, hasAction } from "@voxim/protocol";
import type { ContentService } from "@voxim/content";
import type { System, EventEmitter } from "../system.ts";
import { createLogger } from "../logger.ts";
import { Position, Velocity, Facing, InputState } from "../components/game.ts";
import { Airborne } from "../components/combat.ts";
import { ActiveActions } from "../components/action.ts";
import { effective } from "../modifiers/modifier.ts";
import type { ModifierSourceRegistry } from "../modifiers/modifier.ts";
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
    private readonly modifierSources: ModifierSourceRegistry,
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

      // Movement enum (T-229): a slot action whose current phase declares
      // `movement: "locked"` (dodge_roll dash, swing active) holds the
      // committed velocity vector and ignores input — the generic
      // replacement for the retired bespoke Sidestep component. We
      // synthesise an input matching the current velocity direction and
      // override maxGroundSpeed so stepPhysics's "snap velocity to input ×
      // speed" branch produces exactly the impulse the effect wrote.
      // Passing movement=(0,0) instead would trigger the on-ground
      // "instant stop" drag and zero the dash before integration.
      const locked = isMovementLocked(world, this.content, entityId);
      const jump = !locked && hasAction(inputState.actions, ACTION_JUMP);

      if (jump && onGround) {
        log.debug("jump: entity=%s pos=(%.1f,%.1f,%.1f)", entityId, position.x, position.y, position.z);
      }

      const crouching = !locked && hasAction(inputState.actions, ACTION_CROUCH);
      let speedMultiplier = effective(
        this.modifierSources,
        { world, content: this.content, entityId },
        "moveSpeed",
        1.0,
      );
      if (crouching) speedMultiplier *= crouchSpeedMultiplier;

      let movement: { x: number; y: number };
      let physicsConfig = baseConfig;
      // (T-227: swing root-motion push via ActionImpulse was removed with
      // ActionSystem — root-motion is reintroduced later as an apply_force
      // action effect.)
      if (locked) {
        // Hold whatever velocity the locking action's effect committed
        // (dodge_impulse wrote the dash vector on dash:enter).
        const dashSpeed = Math.sqrt(velocity.x * velocity.x + velocity.y * velocity.y);
        movement = dashSpeed > 0
          ? { x: velocity.x / dashSpeed, y: velocity.y / dashSpeed }
          : { x: 0, y: 0 };
        physicsConfig = { ...baseConfig, maxGroundSpeed: dashSpeed };
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
      } else if (!shouldBeAirborne && wasAirborne) {
        world.erase(s.entityId, Airborne);
      }
    }

    // Prune airborne counters for entities that vanished (destroyed /
    // despawned) — the map otherwise grows for the process lifetime (T-252).
    if (this.offGroundTicks.size > steps.length) {
      const seen = new Set(steps.map((s) => s.entityId));
      for (const key of this.offGroundTicks.keys()) {
        if (!seen.has(key)) this.offGroundTicks.delete(key);
      }
    }
  }
}

const GROUND_TOLERANCE = 0.15;
const COYOTE_TICKS = 3;

/**
 * True if any occupied action slot's current phase declares
 * `movement: "locked"` — the generic "stuck executing this action" signal
 * (dodge_roll dash, swing active). `"slowed"` is currently treated as
 * `"free"` (no consumer yet — a speed-scale pass is deferred retune, per
 * the structure-over-parity pivot); only `"locked"` changes physics today.
 */
function isMovementLocked(
  world: World,
  content: ContentService,
  entityId: string,
): boolean {
  const aa = world.get(entityId, ActiveActions);
  if (!aa) return false;
  for (const st of Object.values(aa.states)) {
    if (content.actions.get(st.actionId)?.movement?.[st.phase] === "locked") {
      return true;
    }
  }
  return false;
}

