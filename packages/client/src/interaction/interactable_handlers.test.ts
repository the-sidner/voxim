/**
 * T-358 — pins the named-field dispatch path for the interaction handlers.
 *
 * Fixtures go through the REAL wire-decode path (ClientWorld.applySpawn with
 * codec-encoded bytes), not hand-rolled EntityState literals, so these tests
 * also break if client_world.ts's registry dispatch regresses (e.g. a codec
 * unregistered from CODEC_BY_WIREID would silently shunt the component into
 * `raw`) — exactly the bug class this ticket fixed: `canHandle` checked
 * `raw.has("itemData")` / `raw.has("poiInteractable")`, but both components
 * have client decoders and land as named EntityState fields, so the checks
 * were constantly false since T-284.
 *
 * resource_node is the deliberate exception (PRESENCE_ONLY_WIRE_IDS): no
 * client decoder, presence marker via `raw` — pinned here so nobody "fixes"
 * the one raw.has() call site that is supposed to stay.
 */
import { assert, assertEquals } from "jsr:@std/assert";
import { ComponentType } from "@voxim/protocol";
import { itemDataCodec, poiInteractableCodec, resourceNodeCodec } from "@voxim/codecs";
import { ClientWorld } from "../state/client_world.ts";
import type { InteractionTarget } from "./types.ts";
import {
  makeGroundItemHandler,
  makePoiInteractableHandler,
  makeResourceNodeHandler,
} from "./interactable_handlers.ts";

/** Spawn one entity with the given wire components; return an InteractionTarget for it. */
function spawnTarget(
  components: Array<{ componentType: number; data: Uint8Array }>,
): { world: ClientWorld; target: InteractionTarget } {
  const world = new ClientWorld();
  world.applySpawn({ entityId: "e1", components });
  const entityState = world.get("e1");
  assert(entityState !== undefined);
  return { world, target: { entityId: "e1", entityState, worldX: 0, worldY: 0 } };
}

const noop = () => {};

Deno.test("ground-item handler: itemData decodes to the named field (never raw) and canHandle sees it", () => {
  const { world, target } = spawnTarget([
    {
      componentType: ComponentType.itemData,
      data: itemDataCodec.encode({ prefabId: "wooden_sword", quantity: 1 }),
    },
  ]);
  const state = world.get("e1")!;
  assertEquals(state.itemData, { prefabId: "wooden_sword", quantity: 1 });
  assertEquals(state.raw.has("itemData"), false, "decoded components must never land in raw");
  assertEquals(makeGroundItemHandler(noop, 2.5).canHandle(target), true);
  assertEquals(makePoiInteractableHandler(noop, 3).canHandle(target), false);
});

Deno.test("interaction range is threaded from content at construction, never a module constant", () => {
  // The factories carry whatever range the caller (game.ts, post-bootstrap)
  // read from game_config — the value the server enforces on the command.
  assertEquals(makeGroundItemHandler(noop, 4.5).interactionRange, 4.5);
  assertEquals(makePoiInteractableHandler(noop, 5).interactionRange, 5);
  assertEquals(makeResourceNodeHandler(6).interactionRange, 6);
});

Deno.test("POI handler: poiInteractable decodes to the named field (never raw) and canHandle sees it", () => {
  const { world, target } = spawnTarget([
    {
      componentType: ComponentType.poiInteractable,
      data: poiInteractableCodec.encode({
        poiInstanceId: "poi-1",
        verb: "drink",
        consumable: true,
      }),
    },
  ]);
  const state = world.get("e1")!;
  assertEquals(state.poiInteractable, { poiInstanceId: "poi-1", verb: "drink", consumable: true });
  assertEquals(state.raw.has("poiInteractable"), false, "decoded components must never land in raw");
  assertEquals(makePoiInteractableHandler(noop, 3).canHandle(target), true);
  assertEquals(makeGroundItemHandler(noop, 2.5).canHandle(target), false);
});

Deno.test("resource_node stays the presence-only exception: lands in raw, handler keys off raw", () => {
  const { world, target } = spawnTarget([
    {
      componentType: ComponentType.resource_node,
      data: resourceNodeCodec.encode({ nodeTypeId: "oak_tree", hitPoints: 30, depleted: false }),
    },
  ]);
  const state = world.get("e1")!;
  assertEquals(state.raw.has("resource_node"), true, "PRESENCE_ONLY_WIRE_IDS opt-out: no decode");
  assertEquals(makeResourceNodeHandler(3).canHandle(target), true);
});

Deno.test("an entity with none of the marker components matches no handler", () => {
  const { target } = spawnTarget([]);
  assertEquals(makeGroundItemHandler(noop, 2.5).canHandle(target), false);
  assertEquals(makePoiInteractableHandler(noop, 3).canHandle(target), false);
  assertEquals(makeResourceNodeHandler(3).canHandle(target), false);
});
