/**
 * WorkstationHitHandler — resolves attack-step and assembly-step recipes.
 *
 * Fires when a player swings at an entity that has WorkstationTag + WorkstationBuffer.
 * Checks:
 *   1. Entity has both WorkstationTag and WorkstationBuffer.
 *   2. For "attack" step: weapon toolType matches recipe.requiredTool (null = any).
 *   3. Buffer contents match a recipe for this station.
 *   4. For "assembly" step: recipe must be explicitly selected (buffer.activeRecipeId).
 *
 * On success: consumes buffer inputs, spawns output item near the workstation.
 */
import type { World } from "@voxim/engine";
import { TileEvents } from "@voxim/protocol";
import type { ContentStore, Recipe } from "@voxim/content";
import type { EventEmitter } from "../system.ts";
import type { HitHandler, HitContext } from "../hit_handler.ts";
import { WorkstationTag, WorkstationBuffer } from "../components/building.ts";
import type { WorkstationBufferData } from "../components/building.ts";
import {
  findMatchingRecipe,
  recipeInputsMatch,
  consumeFromBuffer,
  spawnOutputNear,
} from "../systems/crafting.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("WorkstationHitHandler");

export class WorkstationHitHandler implements HitHandler {
  constructor(private readonly content: ContentStore) {}

  onHit(world: World, events: EventEmitter, ctx: HitContext): void {
    const tag = world.get(ctx.targetId, WorkstationTag);
    if (!tag) return;

    const buffer = world.get(ctx.targetId, WorkstationBuffer);
    if (!buffer || buffer.slots.length === 0) return;

    const bufferMap = new Map<string, number>();
    for (const s of buffer.slots) {
      if (s !== null) bufferMap.set(s.itemType, (bufferMap.get(s.itemType) ?? 0) + s.quantity);
    }

    // ── Try assembly step first (explicit recipe selection) ──────────────
    if (buffer.activeRecipeId) {
      const candidate = this.content.getRecipe(buffer.activeRecipeId);
      if (
        candidate &&
        (candidate.stepType ?? "time") === "assembly" &&
        candidate.stationType === tag.stationType &&
        toolMatches(ctx, candidate.requiredTool) &&
        recipeInputsMatch(candidate.inputs, bufferMap)
      ) {
        this.resolve(world, events, ctx, buffer, candidate);
        return;
      }
    }

    // ── Try attack step ──────────────────────────────────────────────────
    const recipe = findMatchingRecipe(this.content, tag.stationType, "attack", buffer.slots);
    if (!recipe) return;
    if (!toolMatches(ctx, recipe.requiredTool)) {
      log.debug("attack: attacker=%s station=%s wrong tool=%s needs=%s",
        ctx.attackerId, ctx.targetId, ctx.weaponStats.toolType ?? "none", recipe.requiredTool ?? "any");
      return;
    }

    this.resolve(world, events, ctx, buffer, recipe);
  }

  private resolve(
    world: World,
    events: EventEmitter,
    ctx: HitContext,
    buffer: WorkstationBufferData,
    recipe: Recipe,
  ): void {

    const newSlots = consumeFromBuffer(buffer.slots, recipe.inputs);
    world.set(ctx.targetId, WorkstationBuffer, {
      ...buffer,
      slots: newSlots,
      activeRecipeId: null,
      progressTicks: null,
    });

    spawnOutputNear(world, ctx.targetId, recipe.outputType, recipe.outputQuantity);
    events.publish(TileEvents.CraftingCompleted, {
      crafterId: ctx.attackerId,
      recipeId: recipe.id,
    });
    log.info("crafted: attacker=%s station=%s recipe=%s output=%sx%d",
      ctx.attackerId, ctx.targetId, recipe.id, recipe.outputType, recipe.outputQuantity);
  }
}

function toolMatches(ctx: HitContext, requiredTool: string | null | undefined): boolean {
  if (!requiredTool) return true;
  return ctx.weaponStats.toolType === requiredTool;
}
