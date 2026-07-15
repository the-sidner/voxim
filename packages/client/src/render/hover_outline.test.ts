/**
 * T-358 — pins outlineCategoryFor's component→tint table, in particular that
 * poiInteractable is read off the NAMED EntityState field (it has a client
 * decoder, so it never appears in `raw` — the old raw.has() check was
 * constantly false since T-284) while resource_node stays the deliberate
 * raw presence marker (PRESENCE_ONLY_WIRE_IDS).
 *
 * Fixtures go through the real wire-decode path (ClientWorld.applySpawn +
 * codec-encoded bytes) so the tests fail if the decode side regresses too.
 */
import { assert, assertEquals } from "jsr:@std/assert";
import { ComponentType } from "@voxim/protocol";
import { itemDataCodec, poiInteractableCodec, resourceNodeCodec } from "@voxim/codecs";
import { ClientWorld } from "../state/client_world.ts";
import type { EntityState } from "../state/client_world.ts";
import { outlineCategoryFor } from "./hover_outline.ts";

function spawnState(
  components: Array<{ componentType: number; data: Uint8Array }>,
): EntityState {
  const world = new ClientWorld();
  world.applySpawn({ entityId: "e1", components });
  const state = world.get("e1");
  assert(state !== undefined);
  return state;
}

const itemData = () => ({
  componentType: ComponentType.itemData,
  data: itemDataCodec.encode({ prefabId: "wooden_sword", quantity: 1 }),
});
const poiInteractable = () => ({
  componentType: ComponentType.poiInteractable,
  data: poiInteractableCodec.encode({ poiInstanceId: "poi-1", verb: "pull", consumable: false }),
});
const resourceNode = () => ({
  componentType: ComponentType.resource_node,
  data: resourceNodeCodec.encode({ nodeTypeId: "oak_tree", hitPoints: 30, depleted: false }),
});

Deno.test("outlineCategoryFor: null state outlines nothing", () => {
  assertEquals(outlineCategoryFor(null), null);
});

Deno.test("outlineCategoryFor: entity with no marker components outlines nothing", () => {
  assertEquals(outlineCategoryFor(spawnState([])), null);
});

Deno.test("outlineCategoryFor: poiInteractable (named field, not raw) gets the violet tint", () => {
  const state = spawnState([poiInteractable()]);
  assertEquals(state.raw.has("poiInteractable"), false, "decoded — never in raw");
  assertEquals(outlineCategoryFor(state), { tint: 0xd080ff });
});

Deno.test("outlineCategoryFor: itemData gets the cyan tint", () => {
  assertEquals(outlineCategoryFor(spawnState([itemData()])), { tint: 0x80e0ff });
});

Deno.test("outlineCategoryFor: resource_node (raw presence marker) gets the warm-yellow tint", () => {
  const state = spawnState([resourceNode()]);
  assertEquals(state.raw.has("resource_node"), true, "presence-only — stays in raw");
  assertEquals(outlineCategoryFor(state), { tint: 0xffe080 });
});

Deno.test("outlineCategoryFor: table order is priority order — itemData beats poiInteractable", () => {
  const state = spawnState([itemData(), poiInteractable()]);
  assertEquals(outlineCategoryFor(state), { tint: 0x80e0ff });
});
