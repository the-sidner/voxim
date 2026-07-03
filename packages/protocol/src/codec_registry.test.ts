/**
 * CODEC_BY_WIREID is the client decode loop's dispatch table (T-284) — it must
 * cover every networked component the old 31-case switch handled (or entities
 * silently stop decoding). `health` round-trips with the EXACT byte layout the
 * wire uses; `worldClock` is now a hand-rolled WireWriter/WireReader codec
 * (T-311 P5a added the `biomeTag` string field), so its test just round-trips
 * through the registry rather than pinning a fixed byte offset.
 */
import { assert, assertEquals } from "jsr:@std/assert";
import { ComponentType, CODEC_BY_WIREID } from "../mod.ts";
import { healthCodec, worldClockCodec } from "@voxim/codecs";

Deno.test("CODEC_BY_WIREID covers exactly the components the client decode loop dispatches", () => {
  const expected = [
    ComponentType.position, ComponentType.velocity, ComponentType.facing,
    ComponentType.health, ComponentType.resource, ComponentType.actionCooldowns,
    ComponentType.activeActions, ComponentType.heightmap, ComponentType.materialGrid,
    ComponentType.openMask, ComponentType.kindGrid, ComponentType.modelRef,
    ComponentType.animationState, ComponentType.equipment, ComponentType.inventory,
    ComponentType.blueprint, ComponentType.lightEmitter, ComponentType.darknessModifier,
    ComponentType.loreLoadout, ComponentType.durability, ComponentType.craftingQueue,
    ComponentType.itemData, ComponentType.workstationBuffer, ComponentType.workstationTag,
    ComponentType.traderInventory, ComponentType.jobBoard, ComponentType.container, ComponentType.stats,
    ComponentType.provenance, ComponentType.worldClock, ComponentType.gateLink, ComponentType.name,
    ComponentType.vegFieldGrid, ComponentType.surfaceStateGrid, ComponentType.waterGrid,
    ComponentType.poiInteractable, ComponentType.cliffGrid,
  ];
  for (const id of expected) assert(CODEC_BY_WIREID.has(id), `missing codec for wire id ${id}`);
  // No stragglers — the table is exactly the dispatch set.
  assertEquals(CODEC_BY_WIREID.size, expected.length);
});

Deno.test("health round-trips through the registry (replaced a hand-rolled f32/f32 decode)", () => {
  const bytes = healthCodec.encode({ current: 72.5, max: 100 });
  assertEquals(CODEC_BY_WIREID.get(ComponentType.health)!.decode(bytes), { current: 72.5, max: 100 });
});

Deno.test("worldClock round-trips ticksElapsed/dayLengthTicks/biomeTag (T-311 P5a: hand-rolled WireWriter/WireReader, not a fixed DataView layout — biomeTag is a string, the render-context selector)", () => {
  const bytes = worldClockCodec.encode({ ticksElapsed: 12345, dayLengthTicks: 24000, biomeTag: "forest" });
  assertEquals(
    CODEC_BY_WIREID.get(ComponentType.worldClock)!.decode(bytes),
    { ticksElapsed: 12345, dayLengthTicks: 24000, biomeTag: "forest" },
  );
});
