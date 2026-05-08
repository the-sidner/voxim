import type { World } from "@voxim/engine";
import { ACTION_BLOCK, ACTION_DODGE, hasAction } from "@voxim/protocol";
import type { ContentService } from "@voxim/content";
import type { System, EventEmitter } from "../system.ts";
import { InputState, Velocity, Stamina } from "../components/game.ts";
import {
  Staggered, IFrameActive, BlockHeld, DodgeCooldown, Rolling,
} from "../components/combat.ts";
import { deductStamina } from "../combat/helpers.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("DodgeSystem");

/**
 * DodgeSystem — decrements combat counter components each tick, maintains
 * the BlockHeld counter for parry-window detection, and processes ACTION_DODGE
 * to open a dodge roll (stamina cost, impulse velocity, i-frames + cooldown).
 *
 * Each counter is its own presence-as-flag component; absence is the zero
 * state. Systems elsewhere gate behaviour with `world.has(id, Staggered)`
 * / `world.has(id, DodgeCooldown)` etc. — there is no single bag of fields
 * to look up.
 */
export class DodgeSystem implements System {
  /** Reads InputState written by NpcAi via world.write(); must precede. */
  readonly dependsOn = ["NpcAiSystem"];

  constructor(private readonly content: ContentService) {}

  run(world: World, _events: EventEmitter, _dt: number): void {
    const cfg = this.content.getGameConfig().dodge;

    for (const { entityId, inputState } of world.query(InputState)) {
      // ── Decrement Staggered ────────────────────────────────────────────
      const staggered = world.get(entityId, Staggered);
      const willStillBeStaggered = decrementOrRemove(world, entityId, Staggered, staggered?.ticksRemaining);
      if (staggered && !willStillBeStaggered) {
        log.debug("stagger cleared: entity=%s", entityId);
      }

      // ── Decrement IFrameActive ─────────────────────────────────────────
      const iFrames = world.get(entityId, IFrameActive);
      decrementOrRemove(world, entityId, IFrameActive, iFrames?.ticksRemaining);

      // ── Decrement DodgeCooldown ────────────────────────────────────────
      const dcd = world.get(entityId, DodgeCooldown);
      const willStillBeOnCooldown = decrementOrRemove(world, entityId, DodgeCooldown, dcd?.ticksRemaining);

      // ── Decrement Rolling ──────────────────────────────────────────────
      const rolling = world.get(entityId, Rolling);
      if (rolling) {
        const next = rolling.ticksRemaining - 1;
        if (next <= 0) world.remove(entityId, Rolling);
        else world.set(entityId, Rolling, { vx: rolling.vx, vy: rolling.vy, ticksRemaining: next });
      }

      // ── Maintain BlockHeld counter ─────────────────────────────────────
      const blocking = hasAction(inputState.actions, ACTION_BLOCK);
      const cur = world.get(entityId, BlockHeld);
      if (blocking) {
        world.set(entityId, BlockHeld, { ticks: (cur?.ticks ?? 0) + 1 });
      } else if (cur) {
        world.remove(entityId, BlockHeld);
      }

      // ── Dodge initiation ───────────────────────────────────────────────
      // Gate uses the post-decrement (effective) values so a dodge can fire
      // on the tick its cooldown/stagger clears.
      const canDodge = !willStillBeStaggered
                    && !willStillBeOnCooldown
                    && hasAction(inputState.actions, ACTION_DODGE);

      if (!canDodge) continue;

      const stamina = world.get(entityId, Stamina);
      const exhausted = stamina?.exhausted ?? false;
      if (exhausted || !deductStamina(world, entityId, stamina, cfg.staminaCost)) {
        if (stamina) {
          log.debug("dodge blocked: entity=%s stamina=%.1f exhausted=%s",
            entityId, stamina.current, stamina.exhausted);
        }
        continue;
      }

      let dx: number, dy: number;
      const mx = inputState.movementX;
      const my = inputState.movementY;
      const moveLen = Math.sqrt(mx * mx + my * my);
      if (moveLen > 0.1) {
        // Directional roll — direction comes from current movement input
        // (W/S/A/D + diagonals → forward / back / side / corner rolls).
        dx = mx / moveLen;
        dy = my / moveLen;
      } else {
        // No movement input → Dark-Souls-style backstep: short hop opposite
        // the facing direction.
        dx = -Math.cos(inputState.facing);
        dy = -Math.sin(inputState.facing);
      }

      const vx = dx * cfg.speed;
      const vy = dy * cfg.speed;
      world.set(entityId, Velocity, {
        x: vx,
        y: vy,
        z: world.get(entityId, Velocity)?.z ?? 0,
      });

      // These overwrite any decrement-writes made above — last write wins.
      world.set(entityId, IFrameActive, { ticksRemaining: cfg.iFrameTicks });
      world.set(entityId, DodgeCooldown, { ticksRemaining: cfg.cooldownTicks });
      // Rolling locks horizontal velocity over the full roll duration so the
      // dodge actually moves the player visibly (otherwise PhysicsSystem
      // overrides Velocity with input-driven motion next tick).
      world.set(entityId, Rolling, { vx, vy, ticksRemaining: cfg.rollTicks });

      log.info("dodge roll: entity=%s dir=(%.2f,%.2f) stamina=%.1f",
        entityId, dx, dy, (stamina?.current ?? 0) - cfg.staminaCost);
    }
  }
}

/**
 * Decrement the countdown on a component. Removes it on the tick it reaches 0.
 * Returns true if the component will still be present after this tick's
 * changeset applies (i.e. "effectively still in that state"), false if absent
 * or about to be removed.
 */
function decrementOrRemove<T extends { ticksRemaining: number }>(
  world: World,
  entityId: string,
  // deno-lint-ignore no-explicit-any
  def: any,
  current: number | undefined,
): boolean {
  if (current === undefined) return false;
  const next = current - 1;
  if (next <= 0) {
    world.remove(entityId, def);
    return false;
  }
  world.set(entityId, def, { ticksRemaining: next } as T);
  return true;
}
