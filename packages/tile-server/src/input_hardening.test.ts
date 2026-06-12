/**
 * Input hardening (T-253) — hostile-client handling of the input path.
 *
 * NaN movement is zeroed before it can poison Position (and spread via the
 * pairwise-separation pass); reordered/replayed datagrams never regress the
 * applied seq; the RTT sample (client-supplied timestamp) is clamped; the
 * command queue and the outbound state queue are bounded.
 */

import { assert, assertEquals } from "jsr:@std/assert";
import type { MovementDatagram, CommandPayload } from "@voxim/protocol";
import { sanitizeAndMergeInputs } from "./input_merge.ts";
import { ClientSession } from "./session.ts";

const HELD = 1 << 1; // pretend BLOCK is the only held bit for these tests

function dg(seq: number, over: Partial<MovementDatagram> = {}): MovementDatagram {
  return {
    seq, timestamp: 0, facing: 0, movementX: 0, movementY: 0,
    actions: 0, chargeMs: 0, interactSlot: 0,
    ...over,
  } as MovementDatagram;
}

Deno.test("T-253: non-finite movement/facing is zeroed, finite fields survive", () => {
  const m = sanitizeAndMergeInputs(
    [dg(5, { movementX: NaN, movementY: Infinity, facing: -Infinity, chargeMs: NaN })],
    0, HELD,
  );
  assert(m);
  assertEquals(m.latest.movementX, 0);
  assertEquals(m.latest.movementY, 0);
  assertEquals(m.latest.facing, 0);
  assertEquals(m.latest.chargeMs, 0);
  assertEquals(m.latest.seq, 5);
});

Deno.test("T-253: stale and replayed seqs are discarded; latest is chosen by seq, not arrival", () => {
  // Arrival order: 7, then a reordered older 5, then 9.
  const m = sanitizeAndMergeInputs(
    [dg(7, { movementX: 0.7 }), dg(5, { movementX: 0.5 }), dg(9, { movementX: 0.9 })],
    6, // 5 is also below the already-applied watermark
    HELD,
  );
  assert(m);
  assertEquals(m.latest.seq, 9, "latest by seq");
  assertEquals(m.latest.movementX, 0.9);

  const allStale = sanitizeAndMergeInputs([dg(3), dg(4)], 6, HELD);
  assertEquals(allStale, null, "a batch of stale datagrams applies nothing");
});

Deno.test("T-253: one-shot bits OR across the batch; held bits come from the latest frame", () => {
  const JUMP = 1 << 2;
  const m = sanitizeAndMergeInputs(
    [dg(1, { actions: JUMP | HELD }), dg(2, { actions: 0 })],
    0, HELD,
  );
  assert(m);
  assert((m.mergedActions & JUMP) !== 0, "the click in frame 1 still counts");
  assertEquals(m.mergedActions & HELD, 0, "the released held bit does not");
});

Deno.test("T-253: the RTT sample is clamped — a lying timestamp can't inflate the rewind window", () => {
  const s = new ClientSession("p1");
  s.updateRtt(60_000, 0.15, 1000); // claims 60s RTT
  assertEquals(s.rttMs, 1000, "cold start clamped to the max");
  s.updateRtt(-50, 0.15, 1000);
  assert(s.rttMs >= 0 && s.rttMs <= 1000, "negative samples clamp at 0");
});

Deno.test("T-253: the command queue is bounded", () => {
  const s = new ClientSession("p1");
  const cmd = { cmd: 0 } as unknown as CommandPayload;
  for (let i = 0; i < 1000; i++) s.enqueueCommand(cmd);
  assert(s.commandQueue.length <= 256, `bounded (got ${s.commandQueue.length})`);
});

Deno.test("T-253: a stalled reader is disconnected at the outbound queue cap", () => {
  const s = new ClientSession("p1");
  // A sink whose writes never resolve — the reader never drains.
  s.attachOutputStream(new WritableStream<Uint8Array>({
    write: () => new Promise<void>(() => {}),
  }));
  const megabyte = new Uint8Array(1024 * 1024);
  for (let i = 0; i < 10 && s.isOpen; i++) s.sendStateRaw(megabyte);
  assertEquals(s.isOpen, false, "session closed once >4MB sat unwritten");
});
