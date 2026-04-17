/**
 * WorkstationHitHandler — generic dispatcher to the RecipeStepHandler registry.
 *
 * When a hit lands on an entity with WorkstationTag + WorkstationBuffer,
 * iterate every registered step handler's `onHit`. Each handler checks
 * whether it applies and resolves internally. Order of registration
 * controls priority (assembly runs before attack so explicit selection
 * wins over auto-match).
 */
import type { World, Registry } from "@voxim/engine";
import type { ContentStore } from "@voxim/content";
import type { EventEmitter } from "../system.ts";
import type { HitHandler, HitContext } from "../hit_handler.ts";
import { WorkstationTag, WorkstationBuffer } from "../components/building.ts";
import type { RecipeStepHandler } from "../crafting/step_handler.ts";

export class WorkstationHitHandler implements HitHandler {
  constructor(
    private readonly content: ContentStore,
    private readonly steps: Registry<RecipeStepHandler>,
  ) {}

  onHit(world: World, events: EventEmitter, ctx: HitContext): void {
    const tag = world.get(ctx.targetId, WorkstationTag);
    if (!tag) return;

    for (const id of this.steps.ids()) {
      const handler = this.steps.get(id);
      if (!handler.onHit) continue;

      // Re-read buffer every iteration — a previous handler may have mutated it.
      const buffer = world.get(ctx.targetId, WorkstationBuffer);
      if (!buffer || buffer.slots.length === 0) return;

      handler.onHit({
        world, events,
        content: this.content,
        stationId: ctx.targetId,
        stationType: tag.stationType,
        buffer,
        hit: ctx,
      });
    }
  }
}
