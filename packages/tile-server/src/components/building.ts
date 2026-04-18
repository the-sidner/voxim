import { defineComponent } from "@voxim/engine";
import { ComponentType } from "@voxim/protocol";
import { blueprintCodec, workstationBufferCodec, WireWriter, WireReader } from "@voxim/codecs";
import type { WorkstationBufferData } from "@voxim/codecs";

export interface BlueprintMaterial {
  itemType: string;
  quantity: number;
}

/**
 * Blueprint — placed in the world as an entity.
 * Represents a single pending construction cell: one terrain modification
 * (height change and/or material change) at a specific chunk + cell location.
 *
 * Workers with ACTION_INTERACT within interact range contribute materials
 * (once) then advance construction each tick until ticksRemaining reaches 0,
 * at which point the BuildingSystem applies the terrain change and destroys
 * this entity.
 */
export interface BlueprintData {
  /** Key into STRUCTURES table — determines defaults for new blueprints. */
  structureType: string;
  /** Target chunk coordinates. */
  chunkX: number;
  chunkY: number;
  /** Cell within chunk, 0–31. */
  localX: number;
  localY: number;
  /** Height added to terrain cell on completion. 0 for floor-only changes. */
  heightDelta: number;
  /** Material ID written to MaterialGrid on completion. See @voxim/content for the full map. */
  materialId: number;
  /** Materials a worker must supply before construction can begin. */
  materialCost: BlueprintMaterial[];
  /** Total ticks to complete at 20Hz. */
  totalTicks: number;
  /** Remaining construction ticks. Counts down to 0. */
  ticksRemaining: number;
  /** True once a worker has contributed the required materials. */
  materialsDeducted: boolean;
}

export const Blueprint = defineComponent({
  name: "blueprint" as const,
  wireId: ComponentType.blueprint,
  codec: blueprintCodec,
  default: (): BlueprintData => ({
    structureType: "",
    chunkX: 0,
    chunkY: 0,
    localX: 0,
    localY: 0,
    heightDelta: 1.0,
    materialId: 1,
    materialCost: [],
    totalTicks: 60,
    ticksRemaining: 60,
    materialsDeducted: false,
  }),
});

// ---- WorkstationTag (server-only) ----
// Marks an entity as a workstation of a given type. Not sent over the wire.

export interface WorkstationTagData {
  stationType: string;
}

export const WorkstationTag = defineComponent({
  name: "workstationTag" as const,
  networked: false,
  requires: ["workstationBuffer"],
  codec: {
    encode(v: WorkstationTagData): Uint8Array {
      const w = new WireWriter(); w.writeStr(v.stationType); return w.toBytes();
    },
    decode(b: Uint8Array): WorkstationTagData {
      const r = new WireReader(b); return { stationType: r.readStr() };
    },
  },
  default: (): WorkstationTagData => ({ stationType: "" }),
});

// ---- WorkstationBuffer (networked) ----
// Holds materials placed on a workstation. Visible to clients for UI display.

export { type WorkstationBufferData };

export const WorkstationBuffer = defineComponent({
  name: "workstationBuffer" as const,
  wireId: ComponentType.workstationBuffer,
  requires: ["workstationTag"],
  codec: workstationBufferCodec,
  default: (): WorkstationBufferData => ({
    stationType: "",
    slots: [],
    capacity: 4,
    activeRecipeId: null,
    progressTicks: null,
  }),
});
