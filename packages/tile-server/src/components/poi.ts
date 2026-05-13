/**
 * POI runtime components (T-212).
 *
 * Server-only — POI activity is decided server-side and the player
 * never sees the trigger directly. Visible effects (spawned NPCs,
 * lore events, etc.) flow through the normal entity/event channels.
 */

import { defineComponent } from "@voxim/engine";
import { WireReader, WireWriter } from "@voxim/codecs";

/**
 * Marker entity placed at every narrative POI's zone centroid at tile
 * boot. The PoiSystem walks these every tick, checks whether any
 * player is within `triggerRadius`, and on first crossing fires the
 * POI's activity (spawn enemies / unlock lore / etc.) using the POI
 * definition looked up via `poiDefId`.
 *
 * `fired` flips true on first activation. Encounters that respawn (per
 * POI def `activity.regenAfterTicks`) reset it; non-respawning POIs
 * stay fired forever until the tile's lifecycle resets.
 *
 * `poiInstanceId` is the unique-per-tile id (e.g. `wolf_den_z7`) the
 * narrative emits — useful for cross-referencing with TileNarrative
 * trinkets/stairs once T-212 v2 wires inventory checks.
 */
export interface PoiTriggerData {
  poiInstanceId: string;
  poiDefId: string;
  triggerRadius: number;
  fired: boolean;
}

export const PoiTrigger = defineComponent({
  name: "poiTrigger" as const,
  networked: false,
  codec: {
    encode(v: PoiTriggerData): Uint8Array {
      const w = new WireWriter();
      w.writeStr(v.poiInstanceId);
      w.writeStr(v.poiDefId);
      w.writeF32(v.triggerRadius);
      w.writeU8(v.fired ? 1 : 0);
      return w.toBytes();
    },
    decode(b: Uint8Array): PoiTriggerData {
      const r = new WireReader(b);
      return {
        poiInstanceId: r.readStr(),
        poiDefId:      r.readStr(),
        triggerRadius: r.readF32(),
        fired:         r.readU8() === 1,
      };
    },
  },
  default: (): PoiTriggerData => ({
    poiInstanceId: "",
    poiDefId:      "",
    triggerRadius: 6,
    fired:         false,
  }),
});
