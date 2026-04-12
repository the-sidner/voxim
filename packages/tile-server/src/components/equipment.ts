import { defineComponent } from "@voxim/engine";
import { ComponentType } from "@voxim/protocol";
import { equipmentCodec } from "@voxim/codecs";
import type { EquipmentData } from "@voxim/codecs";
import type { InventorySlot } from "./items.ts";

export type { EquipmentData };

/**
 * Equipment — items currently held or worn by an entity.
 *
 * weapon: the item in the entity's primary hand — drives attack stats.
 * armor:  the item worn on the torso — drives damage reduction and stamina regen penalty.
 *
 * Each slot stores a full InventorySlot (itemType + parts + condition) so that
 * DerivedItemStats can be recomputed from material composition at any time without
 * a separate lookup.  null means the slot is empty (unarmed / unarmored).
 *
 * Additional slots (off-hand, helmet, legs, boots) follow the same pattern and
 * can be added here without changing any consuming system's interface.
 */

// InventorySlot is imported for re-export and consumer convenience only.
export type { InventorySlot };

export const Equipment = defineComponent({
  name: "equipment" as const,
  wireId: ComponentType.equipment,
  codec: equipmentCodec,
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
