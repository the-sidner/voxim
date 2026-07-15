/**
 * CommandType.DebugKillEntity round-trip (T-311 P5c I3b harness) — the
 * dev-only "zero an arbitrary entity's health" cheat that lets the harness
 * kill NPCs on demand for the dissolve-cost measurement.
 */

import { assertEquals } from "jsr:@std/assert";
import { CommandType } from "./messages.ts";
import { commandDatagramCodec } from "./codecs.ts";

Deno.test("CommandType.DebugKillEntity round-trips through commandDatagramCodec", () => {
  const original = {
    seq: 7,
    command: { cmd: CommandType.DebugKillEntity as const, entityId: "019f29e6-b2bb-76e9-9564-99a7457524e4" },
  };
  const bytes = commandDatagramCodec.encode(original);
  const decoded = commandDatagramCodec.decode(bytes);
  assertEquals(decoded.seq, original.seq);
  assertEquals(decoded.command, original.command);
});
