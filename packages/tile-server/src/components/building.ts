import { defineComponent } from "@voxim/engine";
import { blueprintCodec } from "@voxim/codecs";

export interface BlueprintMaterial {
  itemType: string;
  quantity: number;
}

/**
 * Blueprint — placed in the world as an entity.
 * Represents a single pending construction cell: one terrain modification
 * (height change and/or material change) at a specific chunk + cell location.
 *
 * Workers with ACTION_INTERACT within INTERACT_RANGE contribute materials
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
