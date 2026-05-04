/**
 * Stage 2 — clean noise blobs into rooms.
 *
 * The noise stage produces a fragmented openMask (with the new defaults,
 * the threshold sits well above 0 so the open regions break apart into
 * many distinct blobs instead of one connected snake). Most of those
 * blobs are real rooms. A long tail of them are 1-3 pixel speckle that
 * should not be addressable as rooms — we want a clean, small set of
 * meaningful rooms for the network stage to plan over.
 *
 * Operations:
 *   1. Flood-fill the raw mask → candidate blobs.
 *   2. Drop blobs smaller than `params.minPixelArea` (close those pixels).
 *   3. Optionally dilate the survivors by N pixels (4-connected) so
 *      cramped blobs become walkable.
 *   4. Re-run flood fill → authoritative `rooms[]` + `roomOf`.
 *
 * Mutates the openMask buffer in place (returns the same buffer).
 */

import { runRoomDetection, ROOM_ID_NONE } from "./room_detection.ts";
import type { Room } from "../types.ts";
import type { GenParams } from "../../genparams.ts";

export interface RoomifyInput {
  /** From the noise stage. Mutated in place. */
  openMask: Uint8Array;
  gridSize: number;
  /** World units per pixel — passed through to room detection for centroids. */
  px2world: number;
  params: GenParams["room"];
}

export interface RoomifyOutput {
  /** Same buffer as input, with speckle removed and dilation applied. */
  openMask: Uint8Array;
  rooms: Room[];
  roomOf: Uint16Array;
}

export function runRoomify(input: RoomifyInput): RoomifyOutput {
  const { openMask, gridSize, px2world, params } = input;
  const N = gridSize * gridSize;

  // Pass 1 — label raw blobs so we can drop the small ones.
  const raw = runRoomDetection({ openMask, gridSize, px2world });

  // Drop sub-threshold blobs by closing their pixels.
  const dropped = new Uint8Array(raw.rooms.length);
  for (let i = 0; i < raw.rooms.length; i++) {
    if (raw.rooms[i].pixelCount < params.minPixelArea) dropped[i] = 1;
  }
  if (dropped.some(d => d === 1)) {
    for (let i = 0; i < N; i++) {
      const id = raw.roomOf[i];
      if (id !== ROOM_ID_NONE && dropped[id] === 1) openMask[i] = 0;
    }
  }

  // Optional dilation — grow each kept blob outward by `dilatePasses` pixels
  // (4-connected). Operates on the cleaned mask; closed pixels adjacent to
  // open pixels flip open. Buffered to avoid same-pass re-flipping.
  for (let pass = 0; pass < params.dilatePasses; pass++) {
    const next = new Uint8Array(openMask);
    for (let py = 0; py < gridSize; py++) {
      for (let px = 0; px < gridSize; px++) {
        const idx = py * gridSize + px;
        if (openMask[idx] === 1) continue;
        if (
          (px > 0              && openMask[idx - 1]        === 1) ||
          (px < gridSize - 1   && openMask[idx + 1]        === 1) ||
          (py > 0              && openMask[idx - gridSize] === 1) ||
          (py < gridSize - 1   && openMask[idx + gridSize] === 1)
        ) {
          next[idx] = 1;
        }
      }
    }
    openMask.set(next);
  }

  // Pass 2 — re-label after cleanup. This is the authoritative room set.
  const final = runRoomDetection({ openMask, gridSize, px2world });
  return { openMask, rooms: final.rooms, roomOf: final.roomOf };
}
