/**
 * CommandType.DebugSetActionParam round-trip (T-327) — the combat-feel
 * tuning pipeline's live knob-edit command. Covers both addressing modes:
 * a real ActionDef id, and the "$config" GameConfig sentinel.
 */

import { assertEquals } from "jsr:@std/assert";
import { CommandType } from "./messages.ts";
import { commandDatagramCodec } from "./codecs.ts";

Deno.test("CommandType.DebugSetActionParam round-trips (ActionDef phase field)", () => {
  const original = {
    seq: 3,
    command: {
      cmd: CommandType.DebugSetActionParam as const,
      actionId: "swing_medium",
      field: "phases.windup.ticks",
      value: 5,
    },
  };
  const bytes = commandDatagramCodec.encode(original);
  const decoded = commandDatagramCodec.decode(bytes);
  assertEquals(decoded.seq, original.seq);
  assertEquals(decoded.command, original.command);
});

Deno.test("CommandType.DebugSetActionParam round-trips ($config sentinel)", () => {
  const original = {
    seq: 4,
    command: {
      cmd: CommandType.DebugSetActionParam as const,
      actionId: "$config",
      field: "combat.aimAssist.halfAngleDeg",
      value: 45.5,
    },
  };
  const bytes = commandDatagramCodec.encode(original);
  const decoded = commandDatagramCodec.decode(bytes);
  assertEquals(decoded.seq, original.seq);
  assertEquals(decoded.command, original.command);
});
