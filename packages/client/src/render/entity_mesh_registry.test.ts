/**
 * T-223 — `resolveItemAttachment`, the pure scene-graph resolution
 * `syncEquipment` uses to find an equipped item's attach bone. First
 * dedicated test for this module — pure data/function code, no THREE
 * instantiation needed (importing the module still pulls in `three` as a
 * dependency, same as every other client render test).
 */
import { assertEquals } from "jsr:@std/assert";
import { ComponentType } from "@voxim/protocol";
import { Parent } from "@voxim/engine";
import { ClientWorld } from "../state/client_world.ts";
import { resolveItemAttachment } from "./entity_mesh_registry.ts";
import type { BinaryEntitySpawn } from "@voxim/protocol";

function parentSpawn(entityId: string, parentId: string | null): BinaryEntitySpawn {
  return {
    entityId,
    components: [
      { componentType: ComponentType.parent, data: Parent.codec.encode({ entityId: parentId }) },
    ],
  };
}

const CHARACTER_ID = "character-1";

Deno.test("resolveItemAttachment: item parented to a known bone entity resolves to that bone", () => {
  const world = new ClientWorld();
  world.applySpawn(parentSpawn("item-1", "boneEntity-handR"));
  const mesh = { boneIdByEntity: new Map([["boneEntity-handR", "hand_r"]]) };

  assertEquals(
    resolveItemAttachment(world, mesh, CHARACTER_ID, "item-1"),
    { kind: "bone", boneId: "hand_r" },
  );
});

Deno.test("resolveItemAttachment: item parented directly to the character (holder root — legs/feet, T-220) resolves to holderRoot", () => {
  const world = new ClientWorld();
  world.applySpawn(parentSpawn("item-1", CHARACTER_ID));
  const mesh = { boneIdByEntity: new Map<string, string>() };

  assertEquals(
    resolveItemAttachment(world, mesh, CHARACTER_ID, "item-1"),
    { kind: "holderRoot" },
  );
});

Deno.test("resolveItemAttachment: an item entity that was never spawned resolves to unresolved", () => {
  const world = new ClientWorld();
  const mesh = { boneIdByEntity: new Map<string, string>() };

  assertEquals(
    resolveItemAttachment(world, mesh, CHARACTER_ID, "never-spawned"),
    { kind: "unresolved" },
  );
});

Deno.test("resolveItemAttachment: an item spawned with no parent component at all resolves to unresolved", () => {
  const world = new ClientWorld();
  world.applySpawn({ entityId: "item-1", components: [] });
  const mesh = { boneIdByEntity: new Map<string, string>() };

  assertEquals(
    resolveItemAttachment(world, mesh, CHARACTER_ID, "item-1"),
    { kind: "unresolved" },
  );
});

Deno.test("resolveItemAttachment: item parented to an entity that is neither a known bone nor the character resolves to unresolved (transient AoI window)", () => {
  const world = new ClientWorld();
  world.applySpawn(parentSpawn("item-1", "some-other-entity"));
  const mesh = { boneIdByEntity: new Map([["boneEntity-handR", "hand_r"]]) };

  assertEquals(
    resolveItemAttachment(world, mesh, CHARACTER_ID, "item-1"),
    { kind: "unresolved" },
  );
});

Deno.test("resolveItemAttachment: two different equip slots parented to the SAME bone entity (chest+back on torso_upper) both resolve to that bone", () => {
  const world = new ClientWorld();
  world.applySpawn(parentSpawn("chest-item", "boneEntity-torsoUpper"));
  world.applySpawn(parentSpawn("back-item", "boneEntity-torsoUpper"));
  const mesh = { boneIdByEntity: new Map([["boneEntity-torsoUpper", "torso_upper"]]) };

  assertEquals(resolveItemAttachment(world, mesh, CHARACTER_ID, "chest-item"), { kind: "bone", boneId: "torso_upper" });
  assertEquals(resolveItemAttachment(world, mesh, CHARACTER_ID, "back-item"), { kind: "bone", boneId: "torso_upper" });
});
