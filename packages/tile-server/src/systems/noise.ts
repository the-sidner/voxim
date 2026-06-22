/**
 * NoiseSystem (T-014) — derives each actor's `NoiseLevel` from its movement.
 *
 * `level = min(1, |horizontal velocity| / maxGroundSpeed)`, scaled by
 * `stealth.crouchNoiseMultiplier` while the `Crouched` tag is set. So a sprint
 * is loud (→1), a crouch-walk is quiet, and standing still is silent (0).
 * Generic over every actor (anything with Velocity + InputState — players and
 * NPCs alike); the value feeds NPC perception (T-015), not the wire.
 */
import type { World } from "@voxim/engine";
import type { ContentService } from "@voxim/content";
import { TileEvents } from "@voxim/protocol";
import type { System, EventEmitter } from "../system.ts";
import { Velocity, InputState, Position } from "../components/game.ts";
import { Crouched } from "../components/tags.ts";
import { NoiseLevel } from "../components/noise.ts";

export class NoiseSystem implements System {
  constructor(private readonly content: ContentService) {}

  run(world: World, events: EventEmitter, _dt: number): void {
    const cfg = this.content.getGameConfig();
    const maxSpeed = cfg.physics.maxGroundSpeed;
    const crouchMul = cfg.stealth.crouchNoiseMultiplier;
    const loudThreshold = cfg.npcAiDefaults.loudNoiseThreshold;

    for (const { entityId, velocity } of world.query(Velocity, InputState)) {
      const speed = Math.hypot(velocity.x, velocity.y);
      const moving = Math.min(1, speed / maxSpeed);
      const level = world.has(entityId, Crouched) ? moving * crouchMul : moving;
      world.set(entityId, NoiseLevel, { level });

      // A loud actor broadcasts a LoudNoise so nearby NPCs can investigate
      // even outside their visual cone (T-040). The NPC sensory system
      // consumes it; it never reaches the wire.
      if (level >= loudThreshold) {
        const pos = world.get(entityId, Position);
        if (pos) {
          events.publish(TileEvents.LoudNoise, {
            x: pos.x, y: pos.y, sourceId: entityId, intensity: level,
          });
        }
      }
    }
  }
}
