import { defineComponent } from "@voxim/engine";
import { ComponentType } from "@voxim/protocol";
// Deliberately NOT networkedCodec() (T-349): resource_node is the one
// presence-only networked component — the client never decodes it (it checks
// `raw.has("resource_node")` for hover/interaction), so its codec is absent
// from CODEC_BY_WIREID and its wire id is listed in PRESENCE_ONLY_WIRE_IDS.
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
