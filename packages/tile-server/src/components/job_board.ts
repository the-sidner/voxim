/**
 * JobBoard + AssignedJobBoard — the "management" surface the SPEC describes
 * collapses into two components:
 *
 *   JobBoard        : overlays a workbench-type prefab, holds a queue of jobs.
 *                     Networked (T-076) so the job-board panel can list each
 *                     pending job; its codec lives in @voxim/codecs.
 *   AssignedJobBoard: marker on an NPC that says "pull work from this board."
 *                     Server-only.
 *
 * Jobs are small tuples (id, goal, itemType, priority, claimedBy). An NPC
 * with an AssignedJobBoard walks up the BT, finds the board, claims the
 * highest-priority unclaimed job, and runs the goal through the existing
 * planner / sub-job machinery.
 *
 * Goal taxonomy is intentionally minimal — just "produce" for MVP. New goal
 * verbs land as new discriminants on JobBoardEntry (@voxim/codecs) + a
 * dispatch arm in the BT node.
 */
import { defineComponent } from "@voxim/engine";
import { WireWriter, WireReader, jobBoardCodec } from "@voxim/codecs";
import { ComponentType } from "@voxim/protocol";
import type { JobBoardData } from "@voxim/codecs";

// Re-export the shared wire types so existing consumers (the
// execute_assigned_job BT node) keep importing them from the component module.
export type { JobBoardData, JobBoardEntry } from "@voxim/codecs";

export const JobBoard = defineComponent({
  name: "jobBoard" as const,
  wireId: ComponentType.jobBoard,
  requires: ["workstationTag"],
  codec: jobBoardCodec,
  default: (): JobBoardData => ({ pending: [] }),
});

export interface AssignedJobBoardData {
  boardId: string;
}

export const AssignedJobBoard = defineComponent({
  name: "assignedJobBoard" as const,
  networked: false,
  codec: {
    encode(v: AssignedJobBoardData): Uint8Array {
      const w = new WireWriter(); w.writeStr(v.boardId); return w.toBytes();
    },
    decode(b: Uint8Array): AssignedJobBoardData {
      const r = new WireReader(b); return { boardId: r.readStr() };
    },
  },
  default: (): AssignedJobBoardData => ({ boardId: "" }),
});
