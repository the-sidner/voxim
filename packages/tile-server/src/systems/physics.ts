import type { World } from "@voxim/engine";
import { stepPhysics, vec2Normalize } from "@voxim/engine";
import type { PhysicsConfig } from "@voxim/engine";
import { ACTION_JUMP, ACTION_CROUCH, hasAction } from "@voxim/protocol";
import type { ContentStore } from "@voxim/content";
import type { System, EventEmitter } from "../system.ts";
import { createLogger } from "../logger.ts";
import { Position, Velocity, Facing, InputState } from "../components/game.ts";
import { SpeedModifier } from "../components/world.ts";
import { buildTerrainLookup } from "../physics/terrain_lookup.ts";

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

    for (const { entityId, position, velocity, inputState } of world.query(
      Position,
      Velocity,
      InputState,
    )) {
      const groundZ = getHeight(position.x, position.y);
      const onGround = position.z <= groundZ + 0.01;

      const movement = vec2Normalize({ x: inputState.movementX, y: inputState.movementY });
      const jump = hasAction(inputState.actions, ACTION_JUMP);

      if (jump && onGround) {
        log.debug("jump: entity=%s pos=(%.1f,%.1f,%.1f)", entityId, position.x, position.y, position.z);
      }

      const speedMod = world.get(entityId, SpeedModifier);
      const crouching = hasAction(inputState.actions, ACTION_CROUCH);
      let speedMultiplier = speedMod?.multiplier ?? 1.0;
      if (crouching) speedMultiplier *= crouchSpeedMultiplier;
      const physicsConfig = speedMultiplier !== 1.0
        ? { ...baseConfig, maxGroundSpeed: baseConfig.maxGroundSpeed * speedMultiplier }
        : baseConfig;

      const next = stepPhysics(
        { position, velocity, onGround },
        { movement, jump },
        getHeight,
        dt,
        physicsConfig,
      );

      world.set(entityId, Position, next.position);
      world.set(entityId, Velocity, next.velocity);
      world.set(entityId, Facing, { angle: inputState.facing });
    }
  }
}

