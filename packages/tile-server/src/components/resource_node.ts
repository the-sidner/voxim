import { defineComponent } from "@voxim/engine";
import { resourceNodeCodec } from "@voxim/codecs";

export interface ResourceNodeData {
  /** References EntityTemplate.id — used to look up harvest data at runtime. */
  nodeTypeId: string;
  /** Remaining hit points. 0 = depleted. */
  hitPoints: number;
  /** True when depleted — entity is kept alive to track respawn countdown. */
  depleted: boolean;
  /**
   * Ticks remaining until respawn.
   * Only meaningful when depleted === true.
   * Null means never respawns (one-time node).
   */
  respawnTicksRemaining: number | null;
}

export const ResourceNode = defineComponent({
  name: "resource_node" as const,
  codec: resourceNodeCodec,
  default: (): ResourceNodeData => ({
    nodeTypeId: "tree",
    hitPoints: 5,
    depleted: false,
    respawnTicksRemaining: null,
  }),
});
