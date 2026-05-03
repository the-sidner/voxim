/**
 * Gate — tile-edge transition point.
 *
 * Spawned at boot from `WorldMapCell.gatePositions`. A player whose
 * Position is within `radius` triggers a handoff to `destinationTileId`.
 *
 * Networked (T-145) so the client can render a pillar + label at the gate
 * position; before that, gates were invisible and players had to wander
 * blindly into the proximity trigger.
 */
import { defineComponent } from "@voxim/engine";
import { ComponentType } from "@voxim/protocol";
import { gateLinkCodec, type GateLinkData } from "@voxim/codecs";

export type { GateLinkData } from "@voxim/codecs";

export const GateLink = defineComponent({
  name: "gateLink" as const,
  wireId: ComponentType.gateLink,
  codec: gateLinkCodec,
  default: (): GateLinkData => ({ destinationTileId: "", edge: "north", radius: 4 }),
});
