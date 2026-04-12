import type { World } from "@voxim/engine";
import { stepPhysics, vec2Normalize } from "@voxim/engine";
import type { PhysicsConfig } from "@voxim/engine";
import { Heightmap, getHeight, worldToChunk, worldToLocal } from "@voxim/world";
import type { HeightmapData } from "@voxim/world";
import { ACTION_JUMP, ACTION_CROUCH, hasAction } from "@voxim/protocol";
import type { ContentStore } from "@voxim/content";
import type { System, EventEmitter } from "../system.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("PhysicsSystem");
import { Position, Velocity, Facing, InputState } from "../components/game.ts";
import { SpeedModifier } from "../components/world.ts";

/**
 * Physics system — runs every tick for all entities with Position + Velocity + InputState.
 *
 * Physics tuning values come from GameConfig.physics — no hardcoded constants.
 */
export class PhysicsSystem implements System {
  /**
   * Heightmaps are written once at world-load and never change.
   * Cache the lookup closure on first use so we never query + rebuild the Map
   * on every tick (it was the most expensive per-tick allocation in the system).
   */
  private cachedTerrainLookup: ((x: number, y: number) => number) | null = null;

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

    if (!this.cachedTerrainLookup) this.cachedTerrainLookup = buildTerrainLookup(world);
    const getHeight = this.cachedTerrainLookup;

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

function buildTerrainLookup(world: World): (x: number, y: number) => number {
  const chunks = world.query(Heightmap);
  const chunkMap = new Map<string, HeightmapData>();
  for (const { heightmap } of chunks) {
    chunkMap.set(`${heightmap.chunkX},${heightmap.chunkY}`, heightmap);
  }

  // heightmap[cx, cy] is the height of the FLAT-TOPPED CELL that covers world
  // square [offX+cx, offX+cx+1] × [offZ+cy, offZ+cy+1].  Physics must use the
  // same semantics: snap to the integer cell that contains (x,y) and return its
  // height directly — no bilinear interpolation (which was written for the old
  // vertex-height convention and produces wrong heights near step edges and zero
  // near chunk boundaries where getHeight returns 0 for out-of-range coords).
  return (x: number, y: number): number => {
    const { chunkX, chunkY } = worldToChunk(x, y);
    const { localX, localY } = worldToLocal(x, y);
    const hm = chunkMap.get(`${chunkX},${chunkY}`);
    if (!hm) {
      log.warn("no heightmap for chunk (%d,%d) — entity at (%.1f,%.1f) in void", chunkX, chunkY, x, y);
      return 0;
    }
    return getHeight(hm, Math.floor(localX), Math.floor(localY));
  };
}
