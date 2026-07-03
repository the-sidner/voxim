/**
 * action POI activity + CommandType.UseEntity tests (T-212 v2).
 *
 * Real content — `ancient_chalice` (interactionPrefab "chalice_pedestal",
 * verb "drink", consumable true; reward.extras has one "lore" 100% and one
 * "stack" 100%). Covers: activation spawns + tags PoiInteractable; use
 * out-of-range is a no-op; use in-range grants the reward and (consumable)
 * destroys the prop.
 */

import { assert, assertEquals } from "jsr:@std/assert";
import { World, EventBus, newEntityId } from "@voxim/engine";
import { CommandType } from "@voxim/protocol";
import type { CommandPayload } from "@voxim/protocol";
import { JsonSource } from "@voxim/content";
import { TileEvents } from "@voxim/protocol";
import { Position } from "../../components/game.ts";
import { PoiTrigger, PoiInteractable } from "../../components/poi.ts";
import { ItemData } from "../../components/items.ts";
import { PoiSystem } from "../../systems/poi.ts";
import { newPoiActivityRegistry } from "../mod.ts";
import type { TickContext } from "../../system.ts";

const activities = newPoiActivityRegistry();
const content = await JsonSource.load();
const DT = 1 / 20;

function placeTrigger(world: World, poiDefId: string, poiInstanceId: string) {
  const pid = newEntityId();
  world.create(pid);
  world.write(pid, Position, { x: 100, y: 100, z: 0 });

  const tid = newEntityId();
  world.create(tid);
  world.write(tid, Position, { x: 100, y: 100, z: 0 });
  world.write(tid, PoiTrigger, { poiInstanceId, poiDefId, triggerRadius: 5, fired: false });
  return { pid, tid };
}

function runWithCommand(sys: PoiSystem, world: World, events: EventEmitter_, playerId: string, entityId: string) {
  const cmd: CommandPayload = { cmd: CommandType.UseEntity, entityId };
  const ctx: TickContext = {
    spatial: null as unknown as TickContext["spatial"],
    pendingCommands: new Map([[playerId, [cmd]]]),
  };
  sys.prepare(0, ctx);
  sys.run(world, events, DT);
  world.applyChangeset();
}
type EventEmitter_ = import("../../system.ts").EventEmitter;

Deno.test("action: activation spawns the interactable and tags PoiInteractable", () => {
  const world = new World();
  const events = new EventBus();
  const { pid, tid } = placeTrigger(world, "ancient_chalice", "ancient_chalice_z1");

  const sys = new PoiSystem(content, activities, () => [pid].values());
  sys.run(world, events, DT);
  world.applyChangeset();

  assertEquals(world.get(tid, PoiTrigger)?.fired, true);
  const props = world.query(PoiInteractable);
  assertEquals(props.length, 1);
  assertEquals(props[0].poiInteractable.poiInstanceId, "ancient_chalice_z1");
  assertEquals(props[0].poiInteractable.verb, "drink");
  assertEquals(props[0].poiInteractable.consumable, true);
});

Deno.test("action: UseEntity out of range does nothing", () => {
  const world = new World();
  const events = new EventBus();
  const { pid } = placeTrigger(world, "ancient_chalice", "ancient_chalice_z1");

  const sys = new PoiSystem(content, activities, () => [pid].values());
  sys.run(world, events, DT);
  world.applyChangeset();

  const propId = world.query(PoiInteractable)[0].entityId;
  // Move the player far away.
  world.set(pid, Position, { x: 100, y: 100, z: 0 });
  world.set(propId, Position, { x: 500, y: 500, z: 0 });
  world.applyChangeset();

  let lorePublished = false;
  events.subscribe(TileEvents.LoreInternalised, () => { lorePublished = true; });

  runWithCommand(sys, world, events, pid, propId);
  assertEquals(lorePublished, false);
  assert(world.isAlive(propId), "out-of-range use must not consume the prop");
});

Deno.test("action: UseEntity in range grants the reward and destroys a consumable prop", () => {
  const world = new World();
  const events = new EventBus();
  const { pid } = placeTrigger(world, "ancient_chalice", "ancient_chalice_z1");

  const sys = new PoiSystem(content, activities, () => [pid].values());
  sys.run(world, events, DT);
  world.applyChangeset();

  const propId = world.query(PoiInteractable)[0].entityId;

  let lore: string[] = [];
  events.subscribe(TileEvents.LoreInternalised, (p: { fragmentId: string }) => { lore.push(p.fragmentId); });

  runWithCommand(sys, world, events, pid, propId);

  assertEquals(lore, ["lore_chalice_libation"]); // ancient_chalice.json reward.extras[0], chance 1.0
  assertEquals(world.isAlive(propId), false, "consumable prop is destroyed after use");

  // reward.extras[1] is a 100%-chance stack drop (chalice_residue x1) —
  // spawnGroundStack should have created an ItemData entity near the prop.
  const drops = world.query(ItemData).filter((e) => e.itemData.prefabId === "chalice_residue");
  assertEquals(drops.length, 1);
});
