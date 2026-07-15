/**
 * CommandType.DebugSpawnDummy round-trip (T-327) — the combat-feel tuning
 * pipeline's practice-target spawn cheat.
 */

import { assertEquals } from "jsr:@std/assert";
import { CommandType } from "./messages.ts";
import { commandDatagramCodec } from "./codecs.ts";

Deno.test("CommandType.DebugSpawnDummy round-trips (attackLoop=false)", () => {
  const original = {
    seq: 1,
    command: { cmd: CommandType.DebugSpawnDummy as const, attackLoop: false },
  };
  const bytes = commandDatagramCodec.encode(original);
  const decoded = commandDatagramCodec.decode(bytes);
  assertEquals(decoded.seq, original.seq);
  assertEquals(decoded.command, original.command);
});

Deno.test("CommandType.DebugSpawnDummy round-trips (attackLoop=true)", () => {
  const original = {
    seq: 2,
    command: { cmd: CommandType.DebugSpawnDummy as const, attackLoop: true },
  };
  const bytes = commandDatagramCodec.encode(original);
  const decoded = commandDatagramCodec.decode(bytes);
  assertEquals(decoded.seq, original.seq);
  assertEquals(decoded.command, original.command);
});
