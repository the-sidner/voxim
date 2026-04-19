/**
 * CraftAtWorkbench — walks to a workstation of a named type, places a fixed
 * input list into its WorkstationBuffer, then emits ACTION_USE_SKILL until
 * the recipe completes (buffer empties and activeRecipeId clears).
 *
 * Collapses plan Phase W2's "three BT primitives" into a single phased job.
 * The physical sequence is identical to what a player does at a workstation:
 *   approach → place → swing → recipe resolves via the existing workstation
 *   hit handler. No NPC-specific crafting code lives downstream.
 */
import type { GameConfig, ContentStore } from "@voxim/content";
import type { World, EntityId } from "@voxim/engine";
import { ACTION_USE_SKILL } from "@voxim/protocol";
import type {
  JobHandler,
  JobContext,
  JobTickAction,
  JobTickInput,
} from "../job_handler.ts";
import type { Job, NpcPlanData } from "../../components/npcs.ts";
import { Position } from "../../components/game.ts";
import { Inventory } from "../../components/items.ts";
import type { InventorySlot } from "@voxim/codecs";
import { WorkstationTag, WorkstationBuffer } from "../../components/building.ts";
import { moveSteps } from "../plan_helpers.ts";

const NO_ACTION: JobTickAction = { movementX: 0, movementY: 0, actions: 0 };

/** Default: ~30 seconds at 20 Hz. Crafting chains with travel can run long. */
const CRAFT_AT_EXPIRY_TICKS = 600;

export const craftAtWorkbenchJob: JobHandler = {
  id: "craftAtWorkbench",

  expiryTicks(_defaults: GameConfig["npcAiDefaults"]): number {
    return CRAFT_AT_EXPIRY_TICKS;
  },

  plan(ctx: JobContext, job: Job): NpcPlanData | null {
    if (job.type !== "craftAtWorkbench") return null;

    const wbId = job.workbenchId ?? findNearestWorkstation(ctx.world, ctx.content, ctx.pos.x, ctx.pos.y, job.workbenchType);
    if (!wbId) return null;
    const pos = ctx.world.get(wbId, Position);
    if (!pos) return null;

    // Stop just inside interact range so the "hit" phase can reach the capsule.
    const interactRange = ctx.content.getGameConfig().crafting.interactRange;
    const approach = interactRange * 0.8;
    const dx0 = ctx.pos.x - pos.x;
    const dy0 = ctx.pos.y - pos.y;
    const d0 = Math.sqrt(dx0 * dx0 + dy0 * dy0) || 1;
    const destX = pos.x + (dx0 / d0) * approach;
    const destY = pos.y + (dy0 / d0) * approach;

    return {
      steps: moveSteps(ctx.pos.x, ctx.pos.y, destX, destY, ctx.defaults.waypointSpacing),
      stepIdx: 0,
      expiresAt: ctx.currentTick + ctx.defaults.planExpiryTicks,
      lastKnownTargetX: pos.x,
      lastKnownTargetY: pos.y,
    };
  },

  tick(input: JobTickInput): JobTickAction {
    const { ctx, job } = input;
    if (job.type !== "craftAtWorkbench") return NO_ACTION;

    // Resolve a workbench on the first tick if the job was set without one.
    if (!job.workbenchId) {
      const resolved = findNearestWorkstation(ctx.world, ctx.content, ctx.pos.x, ctx.pos.y, job.workbenchType);
      if (!resolved) return { ...NO_ACTION, clearJob: true };
      return { ...NO_ACTION, replaceJob: { ...job, workbenchId: resolved } };
    }

    if (!ctx.world.isAlive(job.workbenchId)) return { ...NO_ACTION, clearJob: true };
    const wbPos = ctx.world.get(job.workbenchId, Position);
    if (!wbPos) return { ...NO_ACTION, clearJob: true };

    const dx = wbPos.x - ctx.pos.x;
    const dy = wbPos.y - ctx.pos.y;
    const distSq = dx * dx + dy * dy;
    const interactRange = ctx.content.getGameConfig().crafting.interactRange;
    const inRange = distSq <= interactRange * interactRange;
    const face = Math.atan2(dy, dx);

    if (job.phase === "approach") {
      if (inRange) {
        return { movementX: 0, movementY: 0, actions: 0, facing: face, replaceJob: { ...job, phase: "place" } };
      }
      return { movementX: input.planDirX, movementY: input.planDirY, actions: 0 };
    }

    if (job.phase === "place") {
      if (!inRange) {
        // Drifted out of range — re-approach.
        return { movementX: input.planDirX, movementY: input.planDirY, actions: 0, replaceJob: { ...job, phase: "approach" } };
      }
      const ok = transferInputsToBuffer(ctx.world, ctx.entityId, job.workbenchId, job.inputs);
      if (!ok) return { ...NO_ACTION, clearJob: true };
      return { movementX: 0, movementY: 0, actions: 0, facing: face, replaceJob: { ...job, phase: "hit" } };
    }

    if (job.phase === "hit") {
      const buffer = ctx.world.get(job.workbenchId, WorkstationBuffer);
      if (!buffer) return { ...NO_ACTION, clearJob: true };
      // Recipe completed → buffer empty and no active recipe timer.
      const occupied = buffer.slots.filter((s) => s !== null).length;
      if (occupied === 0 && buffer.activeRecipeId === null && buffer.progressTicks === null) {
        return { ...NO_ACTION, clearJob: true };
      }
      if (!inRange) {
        return { movementX: input.planDirX, movementY: input.planDirY, actions: 0, replaceJob: { ...job, phase: "approach" } };
      }
      return { movementX: 0, movementY: 0, actions: ACTION_USE_SKILL, facing: face };
    }

    return NO_ACTION;
  },
};

// ---- helpers ----

/**
 * Nearest-workstation scan that accepts any workstation of the requested
 * type, ignoring distance cap (the planner already ensured the type is
 * present on the tile; we want the closest instance).
 */
function findNearestWorkstation(
  world: World,
  _content: ContentStore,
  px: number,
  py: number,
  stationType: string,
): EntityId | null {
  let bestId: EntityId | null = null;
  let bestDistSq = Infinity;
  for (const { entityId, workstationTag } of world.query(WorkstationTag)) {
    if (workstationTag.stationType !== stationType) continue;
    const pos = world.get(entityId, Position);
    if (!pos) continue;
    const dx = pos.x - px;
    const dy = pos.y - py;
    const d = dx * dx + dy * dy;
    if (d < bestDistSq) { bestDistSq = d; bestId = entityId; }
  }
  return bestId;
}

/**
 * Move the requested item quantities from the NPC's Inventory into the
 * workstation's WorkstationBuffer. Returns false when the inventory lacks
 * any required input or the buffer has no room — caller should clear the
 * job and re-plan.
 */
function transferInputsToBuffer(
  world: World,
  npcId: EntityId,
  wbId: EntityId,
  inputs: ReadonlyArray<{ itemType: string; quantity: number }>,
): boolean {
  const inventory = world.get(npcId, Inventory);
  const buffer = world.get(wbId, WorkstationBuffer);
  if (!inventory || !buffer) return false;

  // Verify inventory has each required input across slots.
  for (const inp of inputs) {
    let have = 0;
    for (const s of inventory.slots) if (s.kind === "stack" && s.prefabId === inp.itemType) have += s.quantity;
    if (have < inp.quantity) return false;
  }

  // Capacity check: we're appending one buffer slot per input.
  const nonNull = buffer.slots.filter((s) => s !== null).length;
  if (nonNull + inputs.length > buffer.capacity) return false;

  // Deduct inputs from inventory (stack slots only; unique items are never crafting material)
  const newInvSlots: InventorySlot[] = inventory.slots.map((s) => ({ ...s } as InventorySlot));
  for (const inp of inputs) {
    let remaining = inp.quantity;
    for (let i = 0; i < newInvSlots.length && remaining > 0; i++) {
      const slot = newInvSlots[i];
      if (slot.kind !== "stack" || slot.prefabId !== inp.itemType) continue;
      const take = Math.min(slot.quantity, remaining);
      newInvSlots[i] = { kind: "stack", prefabId: slot.prefabId, quantity: slot.quantity - take };
      remaining -= take;
    }
  }
  const filteredInv = newInvSlots.filter((s) => s.kind !== "stack" || s.quantity > 0);

  const newBufSlots = [...buffer.slots, ...inputs.map((inp) => ({ itemType: inp.itemType, quantity: inp.quantity }))];

  world.set(npcId, Inventory, { ...inventory, slots: filteredInv });
  world.set(wbId, WorkstationBuffer, { ...buffer, slots: newBufSlots });
  return true;
}
