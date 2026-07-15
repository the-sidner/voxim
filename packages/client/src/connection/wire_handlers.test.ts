/**
 * Pins applyLocalPlayerState — the ONE definition of "apply the local
 * player's wire state" (shared by the per-message path and start()'s
 * post-input pass):
 *
 *  - delta-keyed: a tick whose only delta is Position must NOT re-run the
 *    inventory/equipment mapping suite or touch uiState at all (the 20 Hz
 *    perf property);
 *  - the no-`changed` form applies everything present (the hydration call).
 */
import { assert, assertEquals } from "jsr:@std/assert";
import { ComponentType } from "@voxim/protocol";
import { inventoryCodec, positionCodec } from "@voxim/codecs";
import { ClientWorld } from "../state/client_world.ts";
import { uiState } from "../ui/ui_store.ts";
import { applyLocalPlayerState } from "./wire_handlers.ts";
import type { VoximGame } from "../game.ts";

function makeGameWithPlayer(): { game: VoximGame; world: ClientWorld; hotbarSyncs: () => number } {
  const world = new ClientWorld();
  world.applySpawn({
    entityId: "player",
    components: [
      { componentType: ComponentType.position, data: positionCodec.encode({ x: 1, y: 2, z: 0 }) },
      {
        componentType: ComponentType.inventory,
        data: inventoryCodec.encode({ slots: [{ kind: "stack", prefabId: "berries", quantity: 3 }], capacity: 8 }),
      },
    ],
  });
  let syncs = 0;
  const game = {
    world,
    contentService: null,
    input: null,
    intentRouter: null,
    _syncHotbarAttachments: () => { syncs++; },
    _observeHeritageGeneration: () => {},
  } as unknown as VoximGame;
  return { game, world, hotbarSyncs: () => syncs };
}

Deno.test("applyLocalPlayerState: a position-only delta leaves uiState untouched (no 20 Hz remap)", () => {
  const { game, world, hotbarSyncs } = makeGameWithPlayer();
  const before = uiState.value;
  applyLocalPlayerState(game, world.get("player")!, new Set([ComponentType.position]));
  assert(uiState.value === before, "uiState identity must not change when no UI-mapped component arrived");
  assertEquals(hotbarSyncs(), 0);
});

Deno.test("applyLocalPlayerState: an inventory delta maps only inventory and syncs the hotbar", () => {
  const { game, world, hotbarSyncs } = makeGameWithPlayer();
  applyLocalPlayerState(game, world.get("player")!, new Set([ComponentType.inventory]));
  assertEquals(uiState.value.inventory?.slots[0]?.itemType, "berries");
  assertEquals(uiState.value.inventory?.maxSlots, 8);
  assertEquals(hotbarSyncs(), 1);
});

Deno.test("applyLocalPlayerState: without `changed` (hydration form) everything present applies", () => {
  const { game, world, hotbarSyncs } = makeGameWithPlayer();
  applyLocalPlayerState(game, world.get("player")!);
  assertEquals(uiState.value.inventory?.slots[0]?.itemType, "berries");
  assertEquals(hotbarSyncs(), 1);
});
