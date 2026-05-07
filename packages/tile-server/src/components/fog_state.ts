/**
 * FogState — server-only fog-of-war exploration state per player (T-157).
 *
 * Bit-packed bitmap of every fog cell the player has ever seen on this tile.
 * One bit per cell, 256×256 cells = 65536 bits = `FOG_GRID_BYTES` (8192 bytes).
 *
 * The bitmap is the authoritative `seenEver` record.  `revealedThisTick`
 * accumulates cell indices that flipped from 0 → 1 since the last send; the
 * AoI/state-send pipeline drains it each tick into the client message.
 *
 * `pendingSnapshot` is set true when the player needs a full bitmap blast
 * (first tick after join, or after a server-side resync).  Cleared once the
 * snapshot has been embedded in a state message.
 *
 * Server-only: not networked.  The fog wire path lives outside the component
 * delta machinery — see `BinaryStateMessage.fogSnapshot` / `.fogReveals` and
 * the producer in `aoi.ts` / `server.ts`.
 */
import { defineComponent } from "@voxim/engine";
import { FOG_GRID_BYTES } from "@voxim/protocol";
import type { Serialiser } from "@voxim/engine";

export interface FogStateData {
  /** Bit-packed seenEver bitmap.  Length must equal FOG_GRID_BYTES. */
  seenEver: Uint8Array;
  /** Cell indices revealed since the last send.  Drained by the producer. */
  revealedThisTick: number[];
  /** True until the next state message includes the full snapshot. */
  pendingSnapshot: boolean;
}

// FogState never travels over the wire and never persists through the binary
// save format — the codec is a no-op stub satisfying the engine contract.
const fogStateCodec: Serialiser<FogStateData> = {
  encode: () => new Uint8Array(0),
  decode: () => ({
    seenEver: new Uint8Array(FOG_GRID_BYTES),
    revealedThisTick: [],
    pendingSnapshot: true,
  }),
};

export const FogState = defineComponent({
  name: "fogState" as const,
  codec: fogStateCodec,
  networked: false,
  default: (): FogStateData => ({
    seenEver: new Uint8Array(FOG_GRID_BYTES),
    revealedThisTick: [],
    pendingSnapshot: true,
  }),
});

/** Test bit `cellIdx` in the packed bitmap. */
export function fogBitGet(buf: Uint8Array, cellIdx: number): boolean {
  return (buf[cellIdx >> 3] & (1 << (cellIdx & 7))) !== 0;
}

/** Set bit `cellIdx` in the packed bitmap.  Returns true if the bit flipped. */
export function fogBitSet(buf: Uint8Array, cellIdx: number): boolean {
  const byteIdx = cellIdx >> 3;
  const mask = 1 << (cellIdx & 7);
  if ((buf[byteIdx] & mask) !== 0) return false;
  buf[byteIdx] |= mask;
  return true;
}
