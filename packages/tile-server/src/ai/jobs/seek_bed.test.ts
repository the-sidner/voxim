/**
 * SeekBed (T-039): a tired NPC walks toward the nearest placed bed, rests
 * (draining the `sleep` tiredness gauge) once in range, and transitions to
 * idle once fully rested. v1 is stateless — first-come proximity, no claim.
 */
import { assert, assertEquals } from "jsr:@std/assert";
import { World, newEntityId } from "@voxim/engine";
import { JsonSource } from "@voxim/content";
import { Position } from "../../components/game.ts";
import { Resource } from "../../components/resource.ts";
import { SpawnedFrom } from "../../components/spawned_from.ts";
import { seekBedJob } from "./seek_bed.ts";
import type { JobContext, JobTickInput } from "../job_handler.ts";
import type { Job } from "../../components/npcs.ts";

const content = await JsonSource.load();
const defaults = content.getGameConfig().npcAiDefaults;

function ctxFor(world: World, entityId: string, x: number, y: number): JobContext {
  return {
    world,
    entityId,
    pos: { x, y },
    spatial: null as unknown as JobContext["spatial"],
    content,
    currentTick: 0,
    tuning: {
      seekBedTicks: defaults.seekBedTicks,
      bedSleepRestore: defaults.bedSleepRestore,
    } as unknown as JobContext["tuning"],
    defaults,
  };
}

const SEEK_BED_JOB: Job = { type: "seekBed", expiresAt: 1000 };

function input(ctx: JobContext, planDirX = 0, planDirY = 0): JobTickInput {
  return { ctx, job: SEEK_BED_JOB, plan: null, planDirX, planDirY };
}

function placeBed(w: World, x: number, y: number): string {
  const bed = newEntityId();
  w.create(bed);
  w.write(bed, Position, { x, y, z: 0 });
  w.write(bed, SpawnedFrom, { prefabId: "bed" });
  return bed;
}

function tiredNpc(w: World, x: number, y: number, sleep: number): string {
  const npc = newEntityId();
  w.create(npc);
  w.write(npc, Position, { x, y, z: 0 });
  w.write(npc, Resource, { values: { sleep: { value: sleep, max: 100 } } });
  return npc;
}

Deno.test("seekBed: plan steers toward the nearest placed bed", () => {
  const w = new World();
  placeBed(w, 30, 0);
  const npc = tiredNpc(w, 0, 0, 95);

  const plan = seekBedJob.plan(ctxFor(w, npc, 0, 0), SEEK_BED_JOB);
  assert(plan, "expected a movement plan toward the bed");
  const last = plan!.steps[plan!.steps.length - 1];
  assertEquals(last.kind, "moveTo");
  if (last.kind === "moveTo") {
    assertEquals(last.x, 30);
    assertEquals(last.y, 0);
  }
});

Deno.test("seekBed: far from any bed, follows the plan direction (no rest)", () => {
  const w = new World();
  placeBed(w, 30, 0);
  const npc = tiredNpc(w, 0, 0, 95);

  const action = seekBedJob.tick(input(ctxFor(w, npc, 0, 0), 1, 0));
  assertEquals(action.movementX, 1);
  assertEquals(action.movementY, 0);
  assertEquals(action.replaceJob, undefined);

  // Still tired — no drain happened yet.
  w.applyChangeset();
  assertEquals(w.get(npc, Resource)!.values.sleep!.value, 95);
});

Deno.test("seekBed: within bed range, rests by draining the sleep gauge", () => {
  const w = new World();
  placeBed(w, 0, 0);
  const npc = tiredNpc(w, 0.5, 0, 95);

  const action = seekBedJob.tick(input(ctxFor(w, npc, 0.5, 0)));
  // Stands still while resting.
  assertEquals(action.movementX, 0);
  assertEquals(action.movementY, 0);
  // Still tired after one tick — keeps the seekBed job (no transition).
  assertEquals(action.replaceJob, undefined);

  w.applyChangeset();
  assertEquals(w.get(npc, Resource)!.values.sleep!.value, 95 - defaults.bedSleepRestore);
});

Deno.test("seekBed: once rested, transitions to idle", () => {
  const w = new World();
  placeBed(w, 0, 0);
  // sleep already at/below the per-tick restore → next drain empties it.
  const npc = tiredNpc(w, 0.5, 0, defaults.bedSleepRestore);

  const action = seekBedJob.tick(input(ctxFor(w, npc, 0.5, 0)));
  assert(action.replaceJob, "expected a transition once rested");
  assertEquals(action.replaceJob!.type, "idle");

  w.applyChangeset();
  assertEquals(w.get(npc, Resource)!.values.sleep!.value, 0);
});
