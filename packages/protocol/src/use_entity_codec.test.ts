/**
 * CommandType.UseEntity round-trip (T-212 v2) — the "use a world-prop
 * entity" command the `action`/`puzzle` POI activities dispatch on click
 * (PickUp/LoadWorkstation semantics don't fit: no inventory transfer, no
 * buffer slot — just "use this prop, maybe consume it, fire POI effects").
 */

import { assertEquals } from "jsr:@std/assert";
import { CommandType } from "./messages.ts";
import { commandDatagramCodec } from "./codecs.ts";

Deno.test("CommandType.UseEntity round-trips through commandDatagramCodec", () => {
  const original = {
    seq: 42,
    command: { cmd: CommandType.UseEntity as const, entityId: "019f29e6-b2bb-76e9-9564-99a7457524e4" },
  };
  const bytes = commandDatagramCodec.encode(original);
  const decoded = commandDatagramCodec.decode(bytes);
  assertEquals(decoded.seq, original.seq);
  assertEquals(decoded.command, original.command);
});
