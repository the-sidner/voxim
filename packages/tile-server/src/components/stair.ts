/**
 * Stair runtime component (T-213).
 *
 * One per stair entity spawned at the path/wilderness boundary. Carries
 * the narrative gating state — `trinketId` is null for "found" stairs
 * (open at boot), non-null for stairs gated behind a POI's trinket
 * reward. The future StairUnlockSystem (T-212 v2) flips a locked stair
 * to found when the player consumes the matching trinket; that triggers
 * `applyStairUnlock` at runtime and ships a heightmap delta to clients.
 *
 * Server-only: clients see the visible stair voxels via ModelRef; the
 * lock state is not needed client-side for v1.
 */

import { defineComponent } from "@voxim/engine";
import { WireReader, WireWriter } from "@voxim/codecs";

export interface StairData {
  /** Narrative stair id (e.g. `stair_explore_z7` or `stair_<poiId>`). */
  stairId: string;
  /** Wilderness zone the stair leads up to. */
  toZoneId: number;
  /** Path zone the stair anchor lives on. */
  fromZoneId: number;
  /**
   * Trinket id that unlocks this stair, or empty when the stair was
   * "found" (open from boot). String rather than null because the
   * codec wire format encodes a string slot either way.
   */
  trinketId: string;
  /** Anchor pixel in TILE_SIZE coords. Needed for runtime unlock. */
  anchorX: number;
  anchorY: number;
  /** True once unlocked (either at boot for "found" stairs or by trinket). */
  unlocked: boolean;
}

export const Stair = defineComponent({
  name: "stair" as const,
  networked: false,
  codec: {
    encode(v: StairData): Uint8Array {
      const w = new WireWriter();
      w.writeStr(v.stairId);
      w.writeU16(v.toZoneId);
      w.writeU16(v.fromZoneId);
      w.writeStr(v.trinketId);
      w.writeF32(v.anchorX);
      w.writeF32(v.anchorY);
      w.writeU8(v.unlocked ? 1 : 0);
      return w.toBytes();
    },
    decode(b: Uint8Array): StairData {
      const r = new WireReader(b);
      return {
        stairId:    r.readStr(),
        toZoneId:   r.readU16(),
        fromZoneId: r.readU16(),
        trinketId:  r.readStr(),
        anchorX:    r.readF32(),
        anchorY:    r.readF32(),
        unlocked:   r.readU8() === 1,
      };
    },
  },
  default: (): StairData => ({
    stairId:    "",
    toZoneId:   0,
    fromZoneId: 0,
    trinketId:  "",
    anchorX:    0,
    anchorY:    0,
    unlocked:   false,
  }),
});
