/**
 * BinaryStateMessage wire round-trip (T-250) — the component-removal channel
 * must survive encode→decode alongside the existing spawn/delta/destroy
 * sections. Without it a removed component latches on the client forever.
 */

import { assertEquals } from "jsr:@std/assert";
import { binaryStateMessageCodec } from "./state_binary.ts";
import type { BinaryStateMessage } from "./state_binary.ts";

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";

function emptyMsg(): BinaryStateMessage {
  return {
    serverTick: 7,
    ackInputSeq: 42,
    spawns: [],
    deltas: [],
    removals: [],
    destroys: [],
    events: [],
    fogSnapshot: null,
    fogReveals: new Uint16Array(0),
    onlineCount: 3,
  };
}

Deno.test("T-250: removals round-trip through the codec", () => {
  const msg = emptyMsg();
  msg.removals = [
    { entityId: UUID_A, componentType: 3 /* velocity */ },
    { entityId: UUID_A, componentType: 2 /* position */ },
    { entityId: UUID_B, componentType: 14 /* animationState */ },
  ];

  const decoded = binaryStateMessageCodec.decode(binaryStateMessageCodec.encode(msg));

  assertEquals(decoded.removals.length, 3);
  assertEquals(decoded.removals[0], { entityId: UUID_A, componentType: 3 });
  assertEquals(decoded.removals[1], { entityId: UUID_A, componentType: 2 });
  assertEquals(decoded.removals[2], { entityId: UUID_B, componentType: 14 });
});

Deno.test("T-250: an empty removals list decodes to empty and doesn't desync the stream", () => {
  const msg = emptyMsg();
  // Put something after the removals section so a mis-sized removals read
  // would corrupt it.
  msg.destroys = [UUID_B];
  msg.onlineCount = 99;

  const decoded = binaryStateMessageCodec.decode(binaryStateMessageCodec.encode(msg));

  assertEquals(decoded.removals, []);
  assertEquals(decoded.destroys, [UUID_B]);
  assertEquals(decoded.onlineCount, 99);
});
