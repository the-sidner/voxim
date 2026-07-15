import { defineComponent } from "@voxim/engine";
import { ComponentType, networkedCodec } from "@voxim/protocol";
import type { EquipmentData } from "@voxim/codecs";

export type { EquipmentData };

/**
 * Equipment — items currently held or worn by an entity.
 *
 * Each slot holds the EntityId (string) of the equipped item entity, or null.
 * Stat reads go through world.get(slotEntityId, ItemData) → prefabId → deriveItemStats.
 */

export const Equipment = defineComponent({
  name: "equipment" as const,
  wireId: ComponentType.equipment,
  codec: networkedCodec<EquipmentData>(ComponentType.equipment),
  default: (): EquipmentData => ({
    weapon:  null,
    offHand: null,
    head:    null,
    chest:   null,
    legs:    null,
    feet:    null,
    back:    null,
  }),
});
