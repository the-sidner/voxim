/**
 * AnimationSystem — single responsibility: derive AnimationState from
 * observable entity state each tick.
 *
 * Priority order (highest first):
 *   death  — Health.current <= 0
 *   attack — SkillInProgress present
 *   crouch_walk / crouch — crouching + moving / crouching only
 *   walk   — velocity magnitude > threshold
 *   idle   — otherwise
 *
 * Hitbox updates are handled by HitboxSystem, which runs immediately after.
 */
import type { World } from "@voxim/engine";
import type { DeferredEventQueue } from "../deferred_events.ts";
import type { System } from "../system.ts";
import type { ContentStore } from "@voxim/content";
import type { AnimationMode, AnimationStateData } from "@voxim/content";
import { ACTION_CROUCH, hasAction } from "@voxim/protocol";
import { Velocity, Health, SkillInProgress, AnimationState, InputState } from "../components/game.ts";
import type { SkillInProgressData } from "../components/game.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("AnimationSystem");

const WALK_THRESHOLD_SQ = 0.01;

export class AnimationSystem implements System {
  constructor(private readonly content: ContentStore) {}

  prepare(_tick: number): void {}

  run(world: World, _events: DeferredEventQueue, _dt: number): void {
    for (const { entityId, velocity } of world.query(Velocity, AnimationState)) {
      const health = world.get(entityId, Health);
      if (health && health.current <= 0) {
        this.setAnimState(world, entityId, "death", null);
        continue;
      }

      const sip = world.get(entityId, SkillInProgress);
      if (sip) {
        this.setAnimState(world, entityId, "attack", sip);
        continue;
      }

      const inputState = world.get(entityId, InputState);
      const crouching = inputState !== null && hasAction(inputState.actions, ACTION_CROUCH);
      const vxSq = velocity.x * velocity.x + velocity.y * velocity.y;
      const moving = vxSq > WALK_THRESHOLD_SQ;

      let mode: "idle" | "walk" | "crouch" | "crouch_walk";
      if (crouching) {
        mode = moving ? "crouch_walk" : "crouch";
      } else {
        mode = moving ? "walk" : "idle";
      }

      this.setAnimState(world, entityId, mode, null);
    }
  }

  /** Write AnimationState and return the new value. Returns null if unchanged. */
  private setAnimState(
    world: World,
    entityId: string,
    mode: AnimationMode,
    sip: SkillInProgressData | null,
  ): AnimationStateData | null {
    let attackStyle = "";
    let windupTicks = 0;
    let activeTicks = 0;
    let winddownTicks = 0;
    let ticksIntoAction = 0;
    let weaponActionId = "";

    if (mode === "attack" && sip) {
      const action = this.content.getWeaponAction(sip.weaponActionId);
      if (action) {
        weaponActionId = sip.weaponActionId;
        attackStyle = action.animationStyle;
        windupTicks = action.windupTicks;
        activeTicks = action.activeTicks;
        winddownTicks = action.winddownTicks;
        ticksIntoAction = sip.phase === "windup"
          ? sip.ticksInPhase
          : sip.phase === "active"
          ? windupTicks + sip.ticksInPhase
          : windupTicks + activeTicks + sip.ticksInPhase;
      }
    }

    const next: AnimationStateData = {
      mode,
      attackStyle,
      windupTicks,
      activeTicks,
      winddownTicks,
      ticksIntoAction,
      weaponActionId,
    };

    const current = world.get(entityId, AnimationState);
    if (
      current?.mode === next.mode &&
      current.attackStyle === next.attackStyle &&
      current.windupTicks === next.windupTicks &&
      current.activeTicks === next.activeTicks &&
      current.winddownTicks === next.winddownTicks &&
      current.ticksIntoAction === next.ticksIntoAction &&
      current.weaponActionId === next.weaponActionId
    ) return null;

    if (current?.mode !== next.mode) {
      log.debug(
        "mode: entity=%s %s→%s%s",
        entityId,
        current?.mode ?? "none",
        next.mode,
        next.mode === "attack"
          ? ` style=${next.attackStyle} ticks=${next.windupTicks}+${next.activeTicks}+${next.winddownTicks} into=${next.ticksIntoAction}`
          : "",
      );
    }
    world.set(entityId, AnimationState, next);
    return next;
  }
}
