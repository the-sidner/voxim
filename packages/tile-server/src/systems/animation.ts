/**
 * AnimationSystem — derives AnimationState from observable entity state each tick.
 *
 * Rules (highest priority first):
 *   death   — Health.current <= 0
 *   attack  — SkillInProgress.active
 *   walk    — velocity magnitude > WALK_THRESHOLD
 *   idle    — otherwise
 *
 * For attack mode the phase data from SkillInProgress is forwarded to AnimationStateData
 * so the client skeleton evaluator can render the correct pose and progress without
 * knowing anything about server-side timing constants.
 */
import type { World } from "@voxim/engine";
import type { DeferredEventQueue } from "../deferred_events.ts";
import type { System } from "../system.ts";
import type { ContentStore } from "@voxim/content";
import { Velocity, Health, SkillInProgress, AnimationState } from "../components/game.ts";
import type { AnimationMode, AnimationStateData } from "@voxim/content";

const WALK_THRESHOLD_SQ = 0.01;

export class AnimationSystem implements System {
  constructor(private readonly content: ContentStore) {}

  prepare(_tick: number): void {}

  run(world: World, _events: DeferredEventQueue, _dt: number): void {
    for (const { entityId, velocity } of world.query(Velocity, AnimationState)) {
      const health = world.get(entityId, Health);
      if (health && health.current <= 0) {
        this.set(world, entityId, "death", null);
        continue;
      }

      const sip = world.get(entityId, SkillInProgress);
      if (sip) {
        this.set(world, entityId, "attack", sip);
        continue;
      }

      const vxSq = velocity.x * velocity.x + velocity.y * velocity.y;
      this.set(world, entityId, vxSq > WALK_THRESHOLD_SQ ? "walk" : "idle", null);
    }
  }

  private set(
    world: World,
    entityId: string,
    mode: AnimationMode,
    sip: import("../components/game.ts").SkillInProgressData | null,
  ): void {
    let attackStyle = "";
    let windupTicks = 0;
    let activeTicks = 0;
    let winddownTicks = 0;
    let ticksIntoAction = 0;

    if (mode === "attack" && sip) {
      const action = this.content.getWeaponAction(sip.weaponActionId);
      if (action) {
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

    const next: AnimationStateData = { mode, attackStyle, windupTicks, activeTicks, winddownTicks, ticksIntoAction };

    const current = world.get(entityId, AnimationState);
    // Skip update if nothing changed
    if (
      current?.mode === next.mode &&
      current.attackStyle === next.attackStyle &&
      current.ticksIntoAction === next.ticksIntoAction
    ) return;

    world.set(entityId, AnimationState, next);
  }
}
