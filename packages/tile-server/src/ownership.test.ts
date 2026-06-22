/**
 * Workstation ownership + base capture (T-082).
 *
 * Deploying a workstation stamps the placer's dynasty; deploying near an
 * enemy-owned workstation re-stamps it to the new owner; same-dynasty and
 * out-of-range structures are untouched. Driven by `stampOwnershipAndCapture`,
 * the logic the EntityDeployed subscriber in server.ts calls.
 */
import { assertEquals } from "jsr:@std/assert";
import { World, newEntityId } from "@voxim/engine";
import { JsonSource } from "@voxim/content";
import type { EntityDeployedPayload } from "@voxim/protocol";
import { Heritage } from "./components/heritage.ts";
import { Position } from "./components/game.ts";
import { WorkstationTag } from "./components/building.ts";
import { BuiltBy, WorkbenchOwner } from "./components/workbench.ts";
import { stampOwnershipAndCapture } from "./ownership.ts";

const content = await JsonSource.load();
const CAPTURE_RADIUS = content.getGameConfig().building.capture.radiusWorldUnits;

/** Spawn a player carrying a dynasty. */
function spawnPlayer(world: World, dynastyId: string): string {
  const id = newEntityId();
  world.create(id);
  world.write(id, Heritage, { dynastyId, generation: 0, traits: [] });
  return id;
}

/** Spawn a bare workstation entity at (x,y); optionally pre-owned. */
function spawnWorkstation(world: World, x: number, y: number, ownerDynasty?: string): string {
  const id = newEntityId();
  world.create(id);
  world.write(id, Position, { x, y, z: 4 });
  world.write(id, WorkstationTag, { stationType: "anvil", qualityTier: 1 });
  if (ownerDynasty) world.write(id, WorkbenchOwner, { dynastyId: ownerDynasty });
  return id;
}

function deployPayload(placerId: string, entityId: string, x: number, y: number): EntityDeployedPayload {
  return { placerId, entityId, prefabId: "workbench", worldX: x, worldY: y, worldZ: 4 };
}

Deno.test("ownership: deploying a workstation stamps the placer's dynasty", () => {
  const world = new World();
  const player = spawnPlayer(world, "dynasty-A");
  const ws = spawnWorkstation(world, 100, 100);

  const result = stampOwnershipAndCapture(world, deployPayload(player, ws, 100, 100), CAPTURE_RADIUS);

  assertEquals(result?.dynastyId, "dynasty-A");
  assertEquals(result?.captured.length, 0);
  assertEquals(world.get(ws, WorkbenchOwner)?.dynastyId, "dynasty-A");
});

Deno.test("ownership: deploying near an enemy-owned workstation captures it", () => {
  const world = new World();
  const player = spawnPlayer(world, "dynasty-A");
  // Enemy structure 5 units away — well inside the capture radius.
  const enemy = spawnWorkstation(world, 105, 100, "dynasty-B");
  const ws = spawnWorkstation(world, 100, 100);

  const result = stampOwnershipAndCapture(world, deployPayload(player, ws, 100, 100), CAPTURE_RADIUS);

  assertEquals(world.get(enemy, WorkbenchOwner)?.dynastyId, "dynasty-A");
  assertEquals(result?.captured.length, 1);
  assertEquals(result?.captured[0].entityId, enemy);
  assertEquals(result?.captured[0].previousDynastyId, "dynasty-B");
});

Deno.test("ownership: same-dynasty structures are untouched", () => {
  const world = new World();
  const player = spawnPlayer(world, "dynasty-A");
  const friend = spawnWorkstation(world, 105, 100, "dynasty-A");
  const ws = spawnWorkstation(world, 100, 100);

  const result = stampOwnershipAndCapture(world, deployPayload(player, ws, 100, 100), CAPTURE_RADIUS);

  // Friendly board stays ours and is NOT reported as a capture.
  assertEquals(world.get(friend, WorkbenchOwner)?.dynastyId, "dynasty-A");
  assertEquals(result?.captured.length, 0);
});

Deno.test("ownership: enemy structures beyond the radius are untouched", () => {
  const world = new World();
  const player = spawnPlayer(world, "dynasty-A");
  const farEnemy = spawnWorkstation(world, 100 + CAPTURE_RADIUS + 1, 100, "dynasty-B");
  const ws = spawnWorkstation(world, 100, 100);

  const result = stampOwnershipAndCapture(world, deployPayload(player, ws, 100, 100), CAPTURE_RADIUS);

  assertEquals(world.get(farEnemy, WorkbenchOwner)?.dynastyId, "dynasty-B");
  assertEquals(result?.captured.length, 0);
});

Deno.test("ownership: deploying stamps the founding dynasty (BuiltBy, T-083)", () => {
  const world = new World();
  const player = spawnPlayer(world, "dynasty-A");
  const ws = spawnWorkstation(world, 100, 100);

  stampOwnershipAndCapture(world, deployPayload(player, ws, 100, 100), CAPTURE_RADIUS);

  assertEquals(world.get(ws, BuiltBy)?.dynastyId, "dynasty-A", "founder recorded at deploy");
});

Deno.test("ownership: capture re-stamps the owner but BuiltBy keeps the founder (T-083)", () => {
  const world = new World();
  // dynasty-B founds a workstation (stamp owner + builder via a deploy).
  const founder = spawnPlayer(world, "dynasty-B");
  const enemy = spawnWorkstation(world, 105, 100);
  stampOwnershipAndCapture(world, deployPayload(founder, enemy, 105, 100), CAPTURE_RADIUS);
  assertEquals(world.get(enemy, BuiltBy)?.dynastyId, "dynasty-B");

  // dynasty-A captures it by deploying next to it.
  const captor = spawnPlayer(world, "dynasty-A");
  const ws = spawnWorkstation(world, 100, 100);
  stampOwnershipAndCapture(world, deployPayload(captor, ws, 100, 100), CAPTURE_RADIUS);

  // Control transfers; provenance does not — the grievance is recorded.
  assertEquals(world.get(enemy, WorkbenchOwner)?.dynastyId, "dynasty-A", "controller is the captor");
  assertEquals(world.get(enemy, BuiltBy)?.dynastyId, "dynasty-B", "founder stays the original family");
});

Deno.test("ownership: deploying a non-workstation is a no-op", () => {
  const world = new World();
  const player = spawnPlayer(world, "dynasty-A");
  const id = newEntityId();
  world.create(id);
  world.write(id, Position, { x: 100, y: 100, z: 4 }); // no WorkstationTag

  const result = stampOwnershipAndCapture(world, deployPayload(player, id, 100, 100), CAPTURE_RADIUS);

  assertEquals(result, null);
  assertEquals(world.has(id, WorkbenchOwner), false);
});

Deno.test("ownership: a placer without a dynasty stamps nothing", () => {
  const world = new World();
  const placer = newEntityId();
  world.create(placer); // no Heritage
  const ws = spawnWorkstation(world, 100, 100);

  const result = stampOwnershipAndCapture(world, deployPayload(placer, ws, 100, 100), CAPTURE_RADIUS);

  assertEquals(result, null);
  assertEquals(world.has(ws, WorkbenchOwner), false);
});
