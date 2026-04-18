/**
 * JobBoard + AssignedJobBoard — the "management" surface the SPEC describes
 * collapses into two server-only components:
 *
 *   JobBoard        : overlays a workbench-type prefab, holds a queue of jobs.
 *   AssignedJobBoard: marker on an NPC that says "pull work from this board."
 *
 * Jobs are small tuples (id, goal, itemType, priority, claimedBy). An NPC
 * with an AssignedJobBoard walks up the BT, finds the board, claims the
 * highest-priority unclaimed job, and runs the goal through the existing
 * planner / sub-job machinery.
 *
 * Goal taxonomy is intentionally minimal — just "produce" for MVP. New goal
 * verbs land as new discriminants here + a dispatch arm in the BT node.
 */
import { defineComponent } from "@voxim/engine";
import { WireWriter, WireReader } from "@voxim/codecs";

export interface JobBoardEntry {
  id: string;
  /** MVP supports `"produce"` only — see execute_assigned_job BT node. */
  goal: "produce";
  itemType: string;
  /** Higher values pull first. */
  priority: number;
  /** EntityId of the NPC that has claimed this job, or null when unclaimed. */
  claimedBy: string | null;
}

export interface JobBoardData {
  pending: JobBoardEntry[];
}

export const JobBoard = defineComponent({
  name: "jobBoard" as const,
  networked: false,
  requires: ["workstationTag"],
  codec: {
    encode(v: JobBoardData): Uint8Array {
      const w = new WireWriter();
      w.writeU16(v.pending.length);
      for (const e of v.pending) {
        w.writeStr(e.id);
        w.writeStr(e.goal);
        w.writeStr(e.itemType);
        w.writeI32(e.priority);
        w.writeStr(e.claimedBy ?? "");
      }
      return w.toBytes();
    },
    decode(b: Uint8Array): JobBoardData {
      const r = new WireReader(b);
      const n = r.readU16();
      const pending: JobBoardEntry[] = [];
      for (let i = 0; i < n; i++) {
        const id = r.readStr();
        const goal = r.readStr() as "produce";
        const itemType = r.readStr();
        const priority = r.readI32();
        const claimedByRaw = r.readStr();
        pending.push({ id, goal, itemType, priority, claimedBy: claimedByRaw === "" ? null : claimedByRaw });
      }
      return { pending };
    },
  },
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
