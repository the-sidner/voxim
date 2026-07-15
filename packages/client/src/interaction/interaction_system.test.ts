/**
 * Pins the one-position-source contract: activateNearest() re-checks range
 * against the SAME player position the last update() selected with — so an
 * entity whose prompt lit up can never silently refuse activation because a
 * second position source (predicted vs networked) straddled the range line.
 */
import { assertEquals } from "jsr:@std/assert";
import { ComponentType } from "@voxim/protocol";
import { itemDataCodec, positionCodec } from "@voxim/codecs";
import { ClientWorld } from "../state/client_world.ts";
import { InteractionSystem } from "./interaction_system.ts";
import { makeGroundItemHandler } from "./interactable_handlers.ts";

function worldWithGroundItem(x: number, y: number): ClientWorld {
  const world = new ClientWorld();
  world.applySpawn({
    entityId: "item1",
    components: [
      { componentType: ComponentType.itemData, data: itemDataCodec.encode({ prefabId: "apple", quantity: 1 }) },
      { componentType: ComponentType.position, data: positionCodec.encode({ x, y, z: 0 }) },
    ],
  });
  return world;
}

Deno.test("InteractionSystem: activateNearest fires against the position update() selected with", () => {
  const world = worldWithGroundItem(2, 0);
  const sys = new InteractionSystem(world);
  const picked: string[] = [];
  sys.register(makeGroundItemHandler((id) => picked.push(id), 2.5));

  sys.update(0, 0);                     // item at distance 2 < 2.5 → selected
  assertEquals(sys.selected, "item1");
  assertEquals(sys.activateNearest(), true);
  assertEquals(picked, ["item1"]);
});

Deno.test("InteractionSystem: activateNearest refuses once update()'s position drifted out of range", () => {
  const world = worldWithGroundItem(2, 0);
  const sys = new InteractionSystem(world);
  const picked: string[] = [];
  sys.register(makeGroundItemHandler((id) => picked.push(id), 2.5));

  sys.update(0, 0);                     // in range → selected
  assertEquals(sys.selected, "item1");
  sys.update(10, 0);                    // walked away; selection cleared, range gate must agree
  assertEquals(sys.activateNearest(), false);
  assertEquals(picked, []);
});
