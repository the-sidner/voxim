/**
 * CaravanEscort (T-048): a caravan lead walks toward the edge gate whose
 * destinationTileId matches its manifest, and on arrival logs the (TODO)
 * handoff + clears the job. Also covers the Caravan component codec round-trip.
 */
import { assert, assertEquals } from "jsr:@std/assert";
import { World, newEntityId } from "@voxim/engine";
import { JsonSource } from "@voxim/content";
import { Position } from "../../components/game.ts";
import { GateLink } from "../../components/gate.ts";
import { Caravan, type CaravanData } from "../../components/caravan.ts";
import { caravanEscortJob } from "./caravan_escort.ts";
import type { JobContext, JobTickInput } from "../job_handler.ts";
import type { Job } from "../../components/npcs.ts";
import { npcJobQueueCodec } from "@voxim/codecs";

const content = await JsonSource.load();

function ctxFor(world: World, entityId: string, x: number, y: number): JobContext {
  return {
    world,
    entityId,
    pos: { x, y },
    spatial: null as unknown as JobContext["spatial"],
    content,
    currentTick: 0,
    tuning: {} as unknown as JobContext["tuning"],
    defaults: content.getGameConfig().npcAiDefaults,
  };
}

function escortJob(destinationTileId: string): Job {
  return { type: "caravanEscort", destinationTileId, expiresAt: 10000 };
}

function input(ctx: JobContext, job: Job): JobTickInput {
  return { ctx, job, plan: null, planDirX: 0, planDirY: 0 };
}

/** Spawn a gate entity bound for `dest` at (x, y). */
function spawnGate(w: World, dest: string, x: number, y: number): void {
  const id = newEntityId();
  w.create(id);
  w.write(id, Position, { x, y, z: 0 });
  w.write(id, GateLink, { destinationTileId: dest, edge: "north", radius: 6 });
}

Deno.test("caravanEscort: plan picks the gate matching the manifest destination", () => {
  const w = new World();
  // Two gates in different directions; only one is bound for our tile.
  spawnGate(w, "tile_north", 256, 8);   // north edge
  spawnGate(w, "tile_east", 504, 256);  // east edge

  const lead = newEntityId();
  w.create(lead);
  w.write(lead, Position, { x: 256, y: 256, z: 0 });
  w.write(lead, Caravan, { destinationTileId: "tile_east", goods: [] });

  const ctx = ctxFor(w, lead, 256, 256);
  const plan = caravanEscortJob.plan(ctx, escortJob("tile_east"));
  assert(plan, "expected a plan toward the east gate");
  const last = plan.steps[plan.steps.length - 1];
  assertEquals(last.kind, "moveTo");
  // The path should terminate at the east gate (504, 256), not the north one.
  assertEquals((last as { kind: "moveTo"; x: number; y: number }).x, 504);
  assertEquals((last as { kind: "moveTo"; x: number; y: number }).y, 256);
});

Deno.test("caravanEscort: walks toward the gate while distant", () => {
  const w = new World();
  spawnGate(w, "tile_east", 504, 256);

  const lead = newEntityId();
  w.create(lead);
  w.write(lead, Position, { x: 256, y: 256, z: 0 });
  w.write(lead, Caravan, { destinationTileId: "tile_east", goods: [] });

  const ctx = ctxFor(w, lead, 256, 256);
  // Direction toward the east gate (+x).
  const out = caravanEscortJob.tick({ ...input(ctx, escortJob("tile_east")), planDirX: 1, planDirY: 0 });
  assertEquals(out.movementX, 1);
  assertEquals(out.movementY, 0);
  assert(!out.clearJob, "should not clear while still travelling");
});

Deno.test("caravanEscort: clears the job on arrival at the gate", () => {
  const w = new World();
  spawnGate(w, "tile_east", 504, 256);

  const lead = newEntityId();
  w.create(lead);
  w.write(lead, Position, { x: 503, y: 256, z: 0 }); // within ARRIVAL_DIST
  w.write(lead, Caravan, {
    destinationTileId: "tile_east",
    goods: [{ itemType: "grain", quantity: 12 }],
  });

  const ctx = ctxFor(w, lead, 503, 256);
  const out = caravanEscortJob.tick(input(ctx, escortJob("tile_east")));
  assertEquals(out.clearJob, true);
  assertEquals(out.movementX, 0);
  assertEquals(out.movementY, 0);
});

Deno.test("caravanEscort: clears the job when no gate to the destination exists", () => {
  const w = new World();
  spawnGate(w, "tile_north", 256, 8);

  const lead = newEntityId();
  w.create(lead);
  w.write(lead, Position, { x: 256, y: 256, z: 0 });
  w.write(lead, Caravan, { destinationTileId: "tile_unreachable", goods: [] });

  const ctx = ctxFor(w, lead, 256, 256);
  assertEquals(caravanEscortJob.plan(ctx, escortJob("tile_unreachable")), null);
  const out = caravanEscortJob.tick(input(ctx, escortJob("tile_unreachable")));
  assertEquals(out.clearJob, true);
});

Deno.test("caravanEscort: manifest on the entity overrides the job snapshot", () => {
  const w = new World();
  spawnGate(w, "tile_real", 504, 256);

  const lead = newEntityId();
  w.create(lead);
  w.write(lead, Position, { x: 256, y: 256, z: 0 });
  // Component says tile_real; the job's stale snapshot says tile_stale.
  w.write(lead, Caravan, { destinationTileId: "tile_real", goods: [] });

  const ctx = ctxFor(w, lead, 256, 256);
  const plan = caravanEscortJob.plan(ctx, escortJob("tile_stale"));
  assert(plan, "manifest destination should resolve a gate");
  const last = plan.steps[plan.steps.length - 1] as { kind: "moveTo"; x: number; y: number };
  assertEquals(last.x, 504);
});

Deno.test("Caravan codec: round-trips destination + goods", () => {
  const original: CaravanData = {
    destinationTileId: "tile_east",
    goods: [
      { itemType: "grain", quantity: 12 },
      { itemType: "iron_ingot", quantity: 3 },
    ],
  };
  const decoded = Caravan.codec.decode(Caravan.codec.encode(original));
  assertEquals(decoded, original);
});

Deno.test("Job codec: round-trips a caravanEscort job through the queue codec", () => {
  const job: Job = { type: "caravanEscort", destinationTileId: "tile_west", expiresAt: 4242 };
  const decoded = npcJobQueueCodec.decode(
    npcJobQueueCodec.encode({ current: job, scheduled: [job], plan: null }),
  );
  assertEquals(decoded.current, job);
  assertEquals(decoded.scheduled[0], job);
});
