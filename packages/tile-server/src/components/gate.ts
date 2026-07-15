/**
 * Gate — tile-edge transition point.
 *
 * Spawned at boot from `GatePosition[]` derived from atlas cell metadata
 * (see `atlas_terrain.ts`). A player whose Position is within `radius`
 * triggers a handoff to `destinationTileId`.
 *
 * Networked (T-145) so the client can render a pillar + label at the gate
 * position; before that, gates were invisible and players had to wander
 * blindly into the proximity trigger.
 */
import { defineComponent } from "@voxim/engine";
import { ComponentType, networkedCodec } from "@voxim/protocol";
import type { GateLinkData } from "@voxim/codecs";

export type { GateLinkData } from "@voxim/codecs";

export const GateLink = defineComponent({
  name: "gateLink" as const,
  wireId: ComponentType.gateLink,
  codec: networkedCodec<GateLinkData>(ComponentType.gateLink),
  default: (): GateLinkData => ({ destinationTileId: "", edge: "north", radius: 4, offset: 0 }),
});
