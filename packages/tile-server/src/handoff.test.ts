/**
 * Handoff serialize → restore round-trip (T-256).
 *
 * The v1 handoff silently deleted everything equipped (the item ENTITIES were
 * left behind) and restored a hollow player (raw component writes, no visual
 * shell). v2 carries the carried item entities and re-completes the player
 * through spawnPrefab. Asserts the ticket's "done when": a player crosses with
 * an equipped unique item and continues playing — visible, hittable, acting,
 * item intact, fog preserved. The payload is round-tripped through JSON to
 * match how it actually travels (gateway POST).
 */

import { assert, assertEquals } from "jsr:@std/assert";
import { World, newEntityId } from "@voxim/engine";
import { JsonSource } from "@voxim/content";
import type { ContentService } from "@voxim/content";
import { serializePlayer, restorePlayer } from "./handoff.ts";
import { spawnPrefab } from "./spawner.ts";
import { Position, Health, ModelRef } from "./components/game.ts";
import { Hitbox } from "./components/hitbox.ts";
import { ActorSlots } from "./components/action.ts";
import { Equipment } from "./components/equipment.ts";
import { ItemData } from "./components/items.ts";
import { Durability } from "./components/instance.ts";
import { FogState } from "./components/fog_state.ts";

let content: ContentService;
async function getContent(): Promise<ContentService> {
  if (!content) content = await JsonSource.load("packages/content/data");
  return content;
}

/** Spawn a player carrying one equipped unique item with a dinged durability. */
function spawnPlayerWithGear(world: World, c: ContentService): { playerId: string; itemId: string } {
  const playerId = spawnPrefab(world, c, "player", { x: 50, y: 60 });
  world.write(playerId, Health, { current: 33, max: 100 });

  const itemId = newEntityId();
  world.create(itemId);
  world.write(itemId, ItemData, { prefabId: "stone_sword", quantity: 1 });
  world.write(itemId, Durability, { remaining: 42, max: 100 });

  const eq = world.get(playerId, Equipment)!;
  world.write(playerId, Equipment, { ...eq, weapon: { entityId: itemId, prefabId: "stone_sword" } });

  // Mark a fog cell so we can prove the bitmap survives.
  const fog = world.get(playerId, FogState)!;
  fog.seenEver[7] = 0x5a;
  world.write(playerId, FogState, fog);

  return { playerId, itemId };
}

Deno.test("T-256: a player crosses with an equipped unique item and is re-completed", async () => {
  const c = await getContent();
  const src = new World();
  const { playerId, itemId } = spawnPlayerWithGear(src, c);

  const payload = serializePlayer(src, playerId, "dyn-1", "1_0", "handoff-1");
  // Travels as JSON over the gateway — round-trip it.
  const wire = JSON.parse(JSON.stringify(payload));

  const dst = new World();
  const restored = restorePlayer(dst, c, wire);
  assertEquals(restored, playerId, "same entity id on the destination");

  // Re-completed: full shell, not the v1 hollow entity.
  assert(dst.has(playerId, ModelRef), "ModelRef — visible");
  assert(dst.has(playerId, Hitbox), "Hitbox — hittable");
  assert(dst.has(playerId, ActorSlots), "ActorSlots — can act");

  // Carried item survived as an entity (v1 deleted it).
  assert(dst.isAlive(itemId), "the equipped item entity crossed too");
  assertEquals(dst.get(itemId, Durability)!.remaining, 42, "its dinged durability is intact");
  assertEquals(dst.get(itemId, ItemData)!.prefabId, "stone_sword");

  // Equipment points at the restored item, mutable state overlaid.
  assertEquals(dst.get(playerId, Equipment)!.weapon?.entityId, itemId, "still equipped");
  assertEquals(dst.get(playerId, Health)!.current, 33, "health carried");
  assertEquals(dst.get(playerId, Position)!.x, 50, "position carried");

  // Fog bitmap preserved.
  assertEquals(dst.get(playerId, FogState)!.seenEver[7], 0x5a, "fog survives the crossing");
});

Deno.test("T-256: restore is idempotent (retry doesn't duplicate or clobber)", async () => {
  const c = await getContent();
  const src = new World();
  const { playerId } = spawnPlayerWithGear(src, c);
  const wire = JSON.parse(JSON.stringify(serializePlayer(src, playerId, "dyn-1", "1_0", "h-2")));

  const dst = new World();
  restorePlayer(dst, c, wire);
  dst.write(playerId, Health, { current: 99, max: 100 }); // local progress after restore
  const again = restorePlayer(dst, c, wire);              // a duplicate delivery

  assertEquals(again, playerId);
  assertEquals(dst.get(playerId, Health)!.current, 99, "retry left the live entity untouched");
});
