/**
 * T-076 — the job board is on the wire so the client's job-board panel can list
 * a hiring workbench's pending jobs. Three guards, all against real content
 * (JsonSource.load) and the real registry:
 *
 *   1. Registry: JobBoard is registered as a networked def, keyed by its
 *      ComponentType wire id — the 3-step "add a networked component" landed.
 *   2. Codec: the shared jobBoardCodec round-trips an entry list, preserving
 *      the unclaimed (claimedBy: null) ↔ empty-string convention exactly.
 *   3. Spawn → wire: spawning the `job_board` prefab yields an entity carrying
 *      a `jobBoard` component whose encoded bytes decode back through the same
 *      codec the client uses — proving it rides the AoI spawn/delta path.
 */
import { assert, assertEquals } from "jsr:@std/assert";
import { World } from "@voxim/engine";
import { ComponentType } from "@voxim/protocol";
import { JsonSource } from "@voxim/content";
import { jobBoardCodec } from "@voxim/codecs";
import type { JobBoardData } from "@voxim/codecs";
import { NETWORKED_DEFS, DEF_BY_TYPE_ID } from "./component_registry.ts";
import { JobBoard } from "./components/job_board.ts";
import { spawnPrefab } from "./spawner.ts";

const content = await JsonSource.load();

Deno.test("T-076: JobBoard is a networked def keyed by its wire id", () => {
  assertEquals(JobBoard.networked, true, "JobBoard is networked now");
  assertEquals(JobBoard.wireId, ComponentType.jobBoard);
  assert(NETWORKED_DEFS.includes(JobBoard), "JobBoard is in NETWORKED_DEFS");
  assertEquals(
    DEF_BY_TYPE_ID.get(ComponentType.jobBoard),
    JobBoard,
    "the wire-id → def map resolves JobBoard",
  );
});

Deno.test("T-076: jobBoardCodec round-trips entries, preserving claimedBy null", () => {
  const data: JobBoardData = {
    pending: [
      { id: "job-1", goal: "produce", itemType: "bread", priority: 5, claimedBy: null },
      { id: "job-2", goal: "produce", itemType: "iron_ingot", priority: 2, claimedBy: "npc-abc" },
    ],
  };
  const decoded = jobBoardCodec.decode(jobBoardCodec.encode(data));
  assertEquals(decoded, data, "encode → decode is lossless, null claim stays null");
});

Deno.test("T-076: spawning a job_board yields a wire-encodable jobBoard component", () => {
  const world = new World();
  const board = spawnPrefab(world, content, "job_board", { x: 10, y: 10 });

  const jb = world.get(board, JobBoard);
  assert(jb, "the spawned job_board carries a JobBoard component");

  // The component the AoI builder will encode round-trips through the client's
  // codec — the panel can read pending jobs off the wire.
  const wire = jobBoardCodec.encode(jb!);
  assertEquals(jobBoardCodec.decode(wire), jb, "spawned board encodes/decodes cleanly");
});
