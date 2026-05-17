import { defineComponent } from "@voxim/engine";
import { ComponentType } from "@voxim/protocol";
import { resourceNodeCodec } from "@voxim/codecs";

export interface ResourceNodeData {
  /** References Prefab.id — used to look up harvest data at runtime. */
  nodeTypeId: string;
  /** Remaining hit points. 0 = depleted. */
  hitPoints: number;
  /**
   * True when depleted. The entity stays alive carrying a `respawn_timer`
   * Resource (cross@0 → respawn_node, T-242); non-respawning nodes are
   * destroyed on depletion instead, so `depleted` always coexists with an
   * active respawn timer.
   */
  depleted: boolean;
}

export const ResourceNode = defineComponent({
  name: "resource_node" as const,
  wireId: ComponentType.resource_node,
  codec: resourceNodeCodec,
  default: (): ResourceNodeData => ({
    nodeTypeId: "tree",
    hitPoints: 5,
    depleted: false,
  }),
});
