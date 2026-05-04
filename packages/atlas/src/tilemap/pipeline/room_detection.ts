/**
 * Stage 2 — connected components of openMask → Room[].
 *
 * Iterative flood-fill (4-connected). Each connected blob becomes one
 * Room with a centroid + pixel count. `roomOf` maps every pixel to its
 * room id, or 0xFFFF for closed pixels.
 *
 * The pixel set is intentionally NOT stored on the Room object — recover
 * it from `roomOf` when needed. Keeps Rooms small for the wire format.
 */

import type { Room } from "../types.ts";

export const ROOM_ID_NONE = 0xFFFF;

export interface RoomDetectionInput {
  openMask: Uint8Array;
  gridSize: number;
  /** World units per pixel. Used to convert centroids to world coords. */
  px2world: number;
}

export interface RoomDetectionOutput {
  rooms: Room[];
  roomOf: Uint16Array;
}

export function runRoomDetection(input: RoomDetectionInput): RoomDetectionOutput {
  const { openMask, gridSize, px2world } = input;
  const N = gridSize * gridSize;
  const roomOf = new Uint16Array(N).fill(ROOM_ID_NONE);
  const rooms: Room[] = [];

  // Per-room centroid accumulators (sum of pixel x/y, count).
  const sumX: number[] = [];
  const sumY: number[] = [];
  const counts: number[] = [];

  // Reusable BFS queue (indices into the flat grid).
  const queue: number[] = [];

  for (let seed = 0; seed < N; seed++) {
    if (openMask[seed] !== 1) continue;
    if (roomOf[seed] !== ROOM_ID_NONE) continue;

    const id = rooms.length;
    if (id >= ROOM_ID_NONE) {
      // Hit the sentinel ceiling; very unlikely on 128² grids.
      throw new Error("room id overflow (≥ 0xFFFF rooms in one tile)");
    }

    let sx = 0, sy = 0, count = 0;
    queue.length = 0;
    queue.push(seed);
    roomOf[seed] = id;

    while (queue.length > 0) {
      const idx = queue.pop()!;
      const px = idx % gridSize;
      const py = (idx - px) / gridSize;
      sx += px;
      sy += py;
      count++;

      // 4-neighbours
      if (px > 0)              tryEnqueue(idx - 1,        openMask, roomOf, id, queue);
      if (px < gridSize - 1)   tryEnqueue(idx + 1,        openMask, roomOf, id, queue);
      if (py > 0)              tryEnqueue(idx - gridSize, openMask, roomOf, id, queue);
      if (py < gridSize - 1)   tryEnqueue(idx + gridSize, openMask, roomOf, id, queue);
    }

    sumX.push(sx);
    sumY.push(sy);
    counts.push(count);
    rooms.push({
      id,
      cx: 0, // filled below
      cy: 0,
      pixelCount: count,
    });
  }

  for (let i = 0; i < rooms.length; i++) {
    rooms[i].cx = (sumX[i] / counts[i] + 0.5) * px2world;
    rooms[i].cy = (sumY[i] / counts[i] + 0.5) * px2world;
  }

  return { rooms, roomOf };
}

function tryEnqueue(
  idx: number,
  openMask: Uint8Array,
  roomOf: Uint16Array,
  id: number,
  queue: number[],
): void {
  if (openMask[idx] !== 1) return;
  if (roomOf[idx] !== ROOM_ID_NONE) return;
  roomOf[idx] = id;
  queue.push(idx);
}
