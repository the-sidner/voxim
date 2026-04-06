import type { World } from "@voxim/engine";
import { ACTION_BLOCK, ACTION_DODGE, hasAction } from "@voxim/protocol";
import type { ContentStore } from "@voxim/content";
import type { System, EventEmitter } from "../system.ts";
import { InputState, Velocity, Stamina, CombatState } from "../components/game.ts";
import type { CombatStateData } from "../components/game.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("DodgeSystem");

export class DodgeSystem implements System {
  constructor(private readonly content: ContentStore) {}

  run(world: World, _events: EventEmitter, _dt: number): void {
    const cfg = this.content.getGameConfig().dodge;

    for (const { entityId, inputState, combatState } of world.query(InputState, CombatState)) {
      const stagger = Math.max(0, combatState.staggerTicksRemaining - 1);
      const iFrames = Math.max(0, combatState.iFrameTicksRemaining - 1);
      const dodgeCd = Math.max(0, combatState.dodgeCooldownTicks - 1);

      const blocking = hasAction(inputState.actions, ACTION_BLOCK);
      const blockHeld = blocking ? combatState.blockHeldTicks + 1 : 0;

      let newState: CombatStateData = {
        blockHeldTicks: blockHeld,
        staggerTicksRemaining: stagger,
        counterReady: combatState.counterReady,
        iFrameTicksRemaining: iFrames,
        dodgeCooldownTicks: dodgeCd,
      };

      const canDodge = dodgeCd === 0 &&
        stagger === 0 &&
        hasAction(inputState.actions, ACTION_DODGE);

      if (canDodge) {
        const stamina = world.get(entityId, Stamina);
        if (stamina && stamina.current >= cfg.staminaCost && !stamina.exhausted) {
          let dx: number, dy: number;
          const mx = inputState.movementX;
          const my = inputState.movementY;
          const moveLen = Math.sqrt(mx * mx + my * my);
          if (moveLen > 0.1) {
            dx = mx / moveLen;
            dy = my / moveLen;
          } else {
            dx = Math.cos(inputState.facing);
            dy = Math.sin(inputState.facing);
          }

          world.set(entityId, Velocity, {
            x: dx * cfg.speed,
            y: dy * cfg.speed,
            z: world.get(entityId, Velocity)?.z ?? 0,
          });

          const newStamina = Math.max(0, stamina.current - cfg.staminaCost);
          world.set(entityId, Stamina, { ...stamina, current: newStamina, exhausted: newStamina <= 0 });

          newState = {
            ...newState,
            iFrameTicksRemaining: cfg.iFrameTicks,
            dodgeCooldownTicks: cfg.cooldownTicks,
          };

          log.info("dodge roll: entity=%s dir=(%.2f,%.2f) stamina=%.1f→%.1f",
            entityId, dx, dy, stamina.current, newStamina);
        } else if (stamina) {
          log.debug("dodge blocked: entity=%s stamina=%.1f exhausted=%s",
            entityId, stamina.current, stamina.exhausted);
        }
      }

      if (stagger === 0 && combatState.staggerTicksRemaining > 0) {
        log.debug("stagger cleared: entity=%s", entityId);
      }

      world.set(entityId, CombatState, newState);
    }
  }
}
