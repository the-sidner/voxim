/**
 * CODEC_BY_WIREID is the single authoring site of the wireId→codec pairing
 * (T-349): the client decode loop dispatches on it, and every networked
 * ComponentDef resolves its codec through networkedCodec(). Coverage against
 * NETWORKED_DEFS is enforced by the boot cross-check in tile-server's
 * component_registry.ts (which this package cannot import); these tests pin
 * the pieces that live HERE: the presence-only opt-out set, and that `health`
 * round-trips with the EXACT byte layout the wire uses. `worldClock` is a
 * hand-rolled WireWriter/WireReader codec (T-311 P5a added the `biomeTag`
 * string field), so its test round-trips through the registry rather than
 * pinning a fixed byte offset.
 */
import { assertEquals } from "jsr:@std/assert";
import { ComponentType, CODEC_BY_WIREID, PRESENCE_ONLY_WIRE_IDS } from "../mod.ts";
import { healthCodec, worldClockCodec } from "@voxim/codecs";

Deno.test("PRESENCE_ONLY_WIRE_IDS is exactly {resource_node} — grow it deliberately", () => {
  assertEquals([...PRESENCE_ONLY_WIRE_IDS], [ComponentType.resource_node]);
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
