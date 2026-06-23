/**
 * CODEC_BY_WIREID is the client decode loop's dispatch table (T-284) — it must
 * cover every networked component the old 31-case switch handled (or entities
 * silently stop decoding), and the two formerly hand-rolled DataView decodes
 * (health, worldClock) must round-trip with the EXACT byte layout the wire uses.
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
  ];
  for (const id of expected) assert(CODEC_BY_WIREID.has(id), `missing codec for wire id ${id}`);
  // No stragglers — the table is exactly the dispatch set (32 components).
  assertEquals(CODEC_BY_WIREID.size, expected.length);
});

Deno.test("health round-trips through the registry (replaced a hand-rolled f32/f32 decode)", () => {
  const bytes = healthCodec.encode({ current: 72.5, max: 100 });
  assertEquals(CODEC_BY_WIREID.get(ComponentType.health)!.decode(bytes), { current: 72.5, max: 100 });
});

Deno.test("worldClock round-trips i32/i32 — the exact layout the old inline DataView read", () => {
  const bytes = worldClockCodec.encode({ ticksElapsed: 12345, dayLengthTicks: 24000 });
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assertEquals(v.getInt32(0, true), 12345);  // ticksElapsed @ 0
  assertEquals(v.getInt32(4, true), 24000);  // dayLengthTicks @ 4
  assertEquals(
    CODEC_BY_WIREID.get(ComponentType.worldClock)!.decode(bytes),
    { ticksElapsed: 12345, dayLengthTicks: 24000 },
  );
});
