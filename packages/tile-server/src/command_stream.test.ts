/**
 * Reliable command delivery (T-273) — discrete commands ride a reliable bidi
 * stream, not unreliable datagrams.
 *
 * These tests exercise the exact wire path the client uses: each CommandDatagram
 * is encoded by commandDatagramCodec then length-prefixed by encodeFrame, and the
 * server's serveCommands() frame-reads the payload back, decodes it, and enqueues
 * it in arrival order. A dropped command was a visible bug under load; the point
 * of the move is that nothing is dropped and ordering is preserved.
 */

import { assert, assertEquals } from "jsr:@std/assert";
import type { CommandDatagram } from "@voxim/protocol";
import { CommandType, commandDatagramCodec, encodeFrame } from "@voxim/protocol";
import { ClientSession } from "./session.ts";

/** Encode a command the way tile_connection.sendCommand() puts it on the wire. */
function framed(dg: CommandDatagram): Uint8Array {
  return encodeFrame(commandDatagramCodec.encode(dg));
}

/** A ReadableStream that emits the given chunks then closes. */
function streamOf(chunks: Uint8Array[]): { readable: ReadableStream<Uint8Array> } {
  return {
    readable: new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(c);
        controller.close();
      },
    }),
  };
}

/** Concatenate frames into one buffer (the common "all in one chunk" case). */
function concat(...frames: Uint8Array[]): Uint8Array {
  const total = frames.reduce((n, f) => n + f.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const f of frames) { out.set(f, off); off += f.byteLength; }
  return out;
}

Deno.test("T-273: framed commands decode in order onto the command queue", async () => {
  const s = new ClientSession("p1");
  const equip: CommandDatagram = { seq: 1, command: { cmd: CommandType.Equip, fromInventorySlot: 3 } };
  const drop: CommandDatagram  = { seq: 2, command: { cmd: CommandType.DropItem, fromSlot: 7 } };
  const respawn: CommandDatagram = { seq: 3, command: { cmd: CommandType.Respawn } };

  await s.serveCommands(streamOf([concat(framed(equip), framed(drop), framed(respawn))]));

  assertEquals(s.commandQueue.length, 3);
  assertEquals(s.commandQueue[0], { cmd: CommandType.Equip, fromInventorySlot: 3 });
  assertEquals(s.commandQueue[1], { cmd: CommandType.DropItem, fromSlot: 7 });
  assertEquals(s.commandQueue[2], { cmd: CommandType.Respawn });
});

Deno.test("T-273: a command split across stream chunks is reassembled", async () => {
  const s = new ClientSession("p1");
  // A Place command with a string payload — long enough to split mid-frame.
  const place: CommandDatagram = {
    seq: 9,
    command: { cmd: CommandType.Place, source: "prefab", prefabId: "campfire", worldX: 12.5, worldY: -3.25 },
  };
  const bytes = framed(place);
  // Split at an awkward offset inside the frame (header + part of body).
  const cut = 6;
  await s.serveCommands(streamOf([bytes.subarray(0, cut), bytes.subarray(cut)]));

  assertEquals(s.commandQueue.length, 1);
  assertEquals(s.commandQueue[0], {
    cmd: CommandType.Place, source: "prefab", prefabId: "campfire", worldX: 12.5, worldY: -3.25,
  });
});

Deno.test("T-284: PlaceVoxels round-trips prefabId + voxelSize + the cell list", async () => {
  const s = new ClientSession("p1");
  const place: CommandDatagram = {
    seq: 5,
    command: {
      cmd: CommandType.PlaceVoxels,
      prefabId: "wood_wall",
      voxelSize: 1.0,
      cells: [{ cellX: 12, cellY: -3 }, { cellX: 13, cellY: -3 }, { cellX: 14, cellY: -4 }],
    },
  };
  await s.serveCommands(streamOf([framed(place)]));

  assertEquals(s.commandQueue.length, 1);
  assertEquals(s.commandQueue[0], {
    cmd: CommandType.PlaceVoxels,
    prefabId: "wood_wall",
    voxelSize: 1.0,
    cells: [{ cellX: 12, cellY: -3 }, { cellX: 13, cellY: -3 }, { cellX: 14, cellY: -4 }],
  });
});

Deno.test("T-284: PlaceVoxels with a single cell round-trips", async () => {
  const s = new ClientSession("p1");
  const place: CommandDatagram = {
    seq: 6,
    command: { cmd: CommandType.PlaceVoxels, prefabId: "stone_wall", voxelSize: 0.5, cells: [{ cellX: 0, cellY: 0 }] },
  };
  await s.serveCommands(streamOf([framed(place)]));
  assertEquals(s.commandQueue[0], {
    cmd: CommandType.PlaceVoxels, prefabId: "stone_wall", voxelSize: 0.5, cells: [{ cellX: 0, cellY: 0 }],
  });
});

Deno.test("T-273: a malformed frame is discarded but the stream keeps serving", async () => {
  const s = new ClientSession("p1");
  const good: CommandDatagram = { seq: 1, command: { cmd: CommandType.UseItem, fromSlot: 2 } };
  // A framed payload whose body is not a valid command (unknown cmdType byte).
  const bogus = encodeFrame(new Uint8Array([2, 0, 0, 0, 0, 99, 0, 0])); // type=2, cmdType=99, len=0
  await s.serveCommands(streamOf([concat(framed(good), bogus, framed(good))]));

  // Both well-formed commands land; the bogus one between them is skipped.
  assertEquals(s.commandQueue.length, 2);
  assertEquals(s.commandQueue[0], { cmd: CommandType.UseItem, fromSlot: 2 });
  assertEquals(s.commandQueue[1], { cmd: CommandType.UseItem, fromSlot: 2 });
});

Deno.test("T-273: serveCommands respects the bounded command queue", async () => {
  const s = new ClientSession("p1");
  const one = framed({ seq: 1, command: { cmd: CommandType.Respawn } });
  const many: Uint8Array[] = [];
  for (let i = 0; i < 1000; i++) many.push(one);
  await s.serveCommands(streamOf([concat(...many)]));

  assert(s.commandQueue.length <= 256, `bounded (got ${s.commandQueue.length})`);
});
