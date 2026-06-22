/**
 * T-038 — hiring workbench as a craftable deployable + ownership stamping.
 *
 * Two halves, both against real content (JsonSource.load):
 *
 *   1. Content: the `job_board_assemble` recipe outputs the stackable
 *      `job_board_kit`, and that kit deploys into the `job_board` prefab.
 *      This is the crafting path that lets a player produce a board at all.
 *
 *   2. Behaviour: when a `job_board` is deployed, the placer's dynasty is
 *      stamped onto the spawned entity as `WorkbenchOwner`. The test wires the
 *      same EntityDeployed subscriber the server installs (server.ts) onto a
 *      real EventBus, then drives the real PlacementSystem end-to-end:
 *      deploy a kit from inventory → EntityDeployed fires → board carries the
 *      owner. A non-board deployable (workbench_kit) is left unstamped — the
 *      subscriber is prefab-scoped, not a blanket placement hook.
 */
import { assert, assertEquals } from "jsr:@std/assert";
import { World, EventBus, newEntityId } from "@voxim/engine";
import { CommandType, TileEvents } from "@voxim/protocol";
import type { CommandPayload, EntityDeployedPayload } from "@voxim/protocol";
import { JsonSource } from "@voxim/content";
import { Position, InputState } from "../components/game.ts";
import { Heritage } from "../components/heritage.ts";
import { Inventory } from "../components/items.ts";
import { WorkbenchOwner } from "../components/workbench.ts";
import { SpawnedFrom } from "../components/spawned_from.ts";
import { PlacementSystem } from "./placement.ts";
import type { TickContext } from "../system.ts";

const content = await JsonSource.load();

/** Mirror of the EntityDeployed → WorkbenchOwner subscriber wired in server.ts. */
function installOwnershipSubscriber(bus: EventBus, world: World): void {
  bus.subscribe(TileEvents.EntityDeployed, (p: EntityDeployedPayload) => {
    if (p.prefabId !== "job_board") return;
    const dynastyId = world.get(p.placerId, Heritage)?.dynastyId ?? "";
    world.write(p.entityId, WorkbenchOwner, { dynastyId });
  });
}

/** Deploy inventory slot 0 from `placer` facing +Y; returns the new entity id (or null). */
function deploySlot0(world: World, bus: EventBus, placer: string): string | null {
  let spawned: string | null = null;
  bus.subscribe(TileEvents.EntityDeployed, (p: EntityDeployedPayload) => {
    if (p.placerId === placer) spawned = p.entityId;
  });

  const sys = new PlacementSystem(content);
  const cmd: CommandPayload = { cmd: CommandType.Place, source: "inventory", fromInventorySlot: 0, worldX: 0, worldY: 0 };
  const ctx: TickContext = {
    spatial: null as unknown as TickContext["spatial"],
    pendingCommands: new Map([[placer, [cmd]]]),
  };
  sys.prepare(0, ctx);
  sys.run(world, bus, 1 / 20);
  world.applyChangeset();
  return spawned;
}

Deno.test("T-038 content: job_board_assemble outputs the deployable job_board_kit", () => {
  const recipe = content.recipes.get("job_board_assemble");
  assert(recipe, "job_board_assemble recipe must load");
  assertEquals(recipe!.stationType, "workbench", "assembled at the workbench");
  assertEquals(recipe!.stepType, "assembly");
  assertEquals(recipe!.outputs.map((o) => o.itemType), ["job_board_kit"]);
  // A kit is interchangeable — the output must stay stackable, so no `stats`.
  assert(!recipe!.outputs[0].stats, "kit output declares no stat formulas (keeps it stackable)");

  const kit = content.prefabs.get("job_board_kit");
  assert(kit, "job_board_kit prefab must load");
  assert(kit!.components["stackable"], "kit is a stack slot, not a unique entity");
  const deployable = kit!.components["deployable"] as { prefabId?: string };
  assertEquals(deployable.prefabId, "job_board", "deploying the kit spawns a job_board");
});

Deno.test("T-038: deploying a job_board stamps the placer's dynasty as WorkbenchOwner", () => {
  const world = new World();
  const bus = new EventBus();
  installOwnershipSubscriber(bus, world);

  const placer = newEntityId();
  world.create(placer);
  world.write(placer, Position, { x: 0, y: 0, z: 0 });
  world.write(placer, InputState, { facing: 0, movementX: 0, movementY: 0, actions: 0, chargeMs: 0, seq: 0, timestamp: 0, rttMs: 0 });
  world.write(placer, Heritage, { dynastyId: "dynasty-alpha", generation: 0, traits: [] });
  world.write(placer, Inventory, { slots: [{ kind: "stack", prefabId: "job_board_kit", quantity: 1 }], capacity: 20 });

  const board = deploySlot0(world, bus, placer);
  assert(board, "a job_board entity was deployed");

  // It really is a job_board (spawnPrefab stamps SpawnedFrom with the prefab id).
  assertEquals(world.get(board!, SpawnedFrom)?.prefabId, "job_board");
  const owner = world.get(board!, WorkbenchOwner);
  assert(owner, "deployed job_board carries a WorkbenchOwner");
  assertEquals(owner!.dynastyId, "dynasty-alpha", "owner is the placer's dynasty");
});

Deno.test("T-038: deploying a non-board deployable leaves no WorkbenchOwner", () => {
  const world = new World();
  const bus = new EventBus();
  installOwnershipSubscriber(bus, world);

  const placer = newEntityId();
  world.create(placer);
  world.write(placer, Position, { x: 0, y: 0, z: 0 });
  world.write(placer, InputState, { facing: 0, movementX: 0, movementY: 0, actions: 0, chargeMs: 0, seq: 0, timestamp: 0, rttMs: 0 });
  world.write(placer, Heritage, { dynastyId: "dynasty-alpha", generation: 0, traits: [] });
  world.write(placer, Inventory, { slots: [{ kind: "stack", prefabId: "workbench_kit", quantity: 1 }], capacity: 20 });

  const bench = deploySlot0(world, bus, placer);
  assert(bench, "a workbench entity was deployed");
  assert(!world.has(bench!, WorkbenchOwner), "a plain workbench is not ownership-stamped");
});
