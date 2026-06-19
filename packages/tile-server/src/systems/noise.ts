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
import type { System, EventEmitter } from "../system.ts";
import { Velocity, InputState } from "../components/game.ts";
import { Crouched } from "../components/tags.ts";
import { NoiseLevel } from "../components/noise.ts";

export class NoiseSystem implements System {
  constructor(private readonly content: ContentService) {}

  run(world: World, _events: EventEmitter, _dt: number): void {
    const cfg = this.content.getGameConfig();
    const maxSpeed = cfg.physics.maxGroundSpeed;
    const crouchMul = cfg.stealth.crouchNoiseMultiplier;

    for (const { entityId, velocity } of world.query(Velocity, InputState)) {
      const speed = Math.hypot(velocity.x, velocity.y);
      const moving = Math.min(1, speed / maxSpeed);
      const level = world.has(entityId, Crouched) ? moving * crouchMul : moving;
      world.set(entityId, NoiseLevel, { level });
    }
  }
}
