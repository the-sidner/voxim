/**
 * executeAssignedJob — the top-level BT node that an NPC with an
 * `AssignedJobBoard` component uses to pull work from a job board and drive
 * it to completion.
 *
 * Flow each tick:
 *   1. If no AssignedJobBoard → failure (next selector branch handles idle).
 *   2. If the board entity is gone or has no JobBoard component → remove
 *      the AssignedJobBoard marker and return failure.
 *   3. If we already have a claim on this board, dispatch the goal via
 *      produce_dispatch. On "alreadyHave" the claim is considered fulfilled:
 *      the job is removed from the board and success returned (so the next
 *      BT tick can pull another).
 *   4. Otherwise, pick the highest-priority unclaimed pending job, mark it
 *      claimedBy=self, and return success (next tick executes it).
 *
 * Only the "produce" goal verb is wired in this phase. New goal verbs plug
 * in as additional arms in the dispatch switch.
 */
import type { BTNode, BTNodeFactory, BTContext, BTOutput, NodeResult } from "../behavior_tree.ts";
import type { World, EntityId } from "@voxim/engine";
import { JobBoard, AssignedJobBoard } from "../../../components/job_board.ts";
import type { JobBoardData, JobBoardEntry } from "../../../components/job_board.ts";
import { dispatchProduce } from "../../produce_dispatch.ts";

interface ExecuteAssignedJobSpec {
  type: "execute_assigned_job";
  /** Optional override for the gather scan radius when producing. */
  gatherScanRadius?: number;
}

const DEFAULT_SCAN_RADIUS = 64;

export const executeAssignedJobFactory: BTNodeFactory = {
  id: "execute_assigned_job",
  build(spec: unknown): BTNode {
    const s = spec as ExecuteAssignedJobSpec;
    const scanRadius = s.gatherScanRadius ?? DEFAULT_SCAN_RADIUS;

    return {
      tick(ctx: BTContext, out: BTOutput): NodeResult {
        const assigned = ctx.world.get(ctx.entityId, AssignedJobBoard);
        if (!assigned || !assigned.boardId) return "failure";

        const boardId = assigned.boardId;
        const board = ctx.world.get(boardId, JobBoard);
        if (!board || !ctx.world.isAlive(boardId)) {
          ctx.world.remove(ctx.entityId, AssignedJobBoard);
          return "failure";
        }

        const existing = findClaim(board, ctx.entityId);
        if (existing) {
          if (existing.goal === "produce") {
            const outcome = dispatchProduce(
              ctx.world, ctx.content, ctx.entityId,
              ctx.pos.x, ctx.pos.y, ctx.queue.current,
              existing.itemType, 1,
              scanRadius, ctx.currentTick,
            );
            switch (outcome.kind) {
              case "alreadyHave":
                // Job done — remove it from the board, let next tick pull again.
                writeBoard(ctx.world, boardId, removeEntry(board, existing.id));
                return "success";
              case "unreachable":
                return "failure";
              case "sameAsCurrent":
                return "success";
              case "emit":
                out.replaceCurrent = outcome.job;
                return "success";
            }
          }
          return "failure";
        }

        // No claim yet — pick the highest-priority unclaimed job and mark it ours.
        const pick = highestPriorityUnclaimed(board);
        if (!pick) return "failure";
        writeBoard(ctx.world, boardId, claimEntry(board, pick.id, ctx.entityId));
        return "success";
      },
    };
  },
};

// ---- helpers ----

function findClaim(board: JobBoardData, npcId: EntityId): JobBoardEntry | null {
  for (const e of board.pending) if (e.claimedBy === npcId) return e;
  return null;
}

function highestPriorityUnclaimed(board: JobBoardData): JobBoardEntry | null {
  let best: JobBoardEntry | null = null;
  for (const e of board.pending) {
    if (e.claimedBy !== null) continue;
    if (!best || e.priority > best.priority) best = e;
  }
  return best;
}

function claimEntry(board: JobBoardData, jobId: string, npcId: EntityId): JobBoardData {
  return {
    pending: board.pending.map((e) => e.id === jobId ? { ...e, claimedBy: npcId } : e),
  };
}

function removeEntry(board: JobBoardData, jobId: string): JobBoardData {
  return { pending: board.pending.filter((e) => e.id !== jobId) };
}

function writeBoard(world: World, boardId: EntityId, next: JobBoardData): void {
  world.set(boardId, JobBoard, next);
}
