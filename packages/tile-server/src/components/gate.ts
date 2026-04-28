/**
 * Gate — server-only marker for a tile-edge transition point.
 *
 * Spawned at boot from `WorldMapCell.gatePositions`. A player whose
 * Position is within `radius` triggers a handoff to `destinationTileId`.
 *
 * Visualisation is client-side and out of scope for T-140; the server
 * just runs the proximity check and initiates the handoff.
 */
import { defineComponent } from "@voxim/engine";
import { WireWriter, WireReader } from "@voxim/codecs";

export interface GateLinkData {
  destinationTileId: string;
  /** "north" | "south" | "east" | "west" — which edge this gate sits on. */
  edge: "north" | "south" | "east" | "west";
  /** Trigger radius in world units. */
  radius: number;
}

const EDGE_TO_INT: Record<GateLinkData["edge"], number> = {
  north: 0, south: 1, east: 2, west: 3,
};
const INT_TO_EDGE: GateLinkData["edge"][] = ["north", "south", "east", "west"];

export const GateLink = defineComponent({
  name: "gateLink" as const,
  networked: false,
  codec: {
    encode(v: GateLinkData): Uint8Array {
      const w = new WireWriter();
      w.writeStr(v.destinationTileId);
      w.writeU8(EDGE_TO_INT[v.edge]);
      w.writeF32(v.radius);
      return w.toBytes();
    },
    decode(b: Uint8Array): GateLinkData {
      const r = new WireReader(b);
      const destinationTileId = r.readStr();
      const edge = INT_TO_EDGE[r.readU8()] ?? "north";
      const radius = r.readF32();
      return { destinationTileId, edge, radius };
    },
  },
  default: (): GateLinkData => ({ destinationTileId: "", edge: "north", radius: 4 }),
});
