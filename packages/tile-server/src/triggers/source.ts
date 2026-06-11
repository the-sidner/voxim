/**
 * TriggerSource registry (T-259) — "which triggers does this entity own
 * right now?" Mirrors the ModifierSource hybrid doctrine: sources read
 * LIVE from the store that already owns the data (equipment from the
 * Equipment component's worn prefabs), no materialized per-entity trigger
 * list to keep in sync. Later sources (inscriptions, zones, buff-granted)
 * are one handler file + one register() call each.
 */

import type { World, EntityId, Registry } from "@voxim/engine";
import { Registry as RegistryImpl } from "@voxim/engine";
import type { ContentService } from "@voxim/content";
import { Equipment } from "../components/equipment.ts";
import { NpcTag } from "../components/npcs.ts";

export interface TriggerSourceContext {
  readonly world: World;
  readonly content: ContentService;
  readonly entityId: EntityId;
}

export interface TriggerSource {
  readonly id: string;
  /** Trigger ids this source grants `entityId` right now (live read). */
  collect(ctx: TriggerSourceContext): string[];
}

export type TriggerSourceRegistry = Registry<TriggerSource>;

export function newTriggerSourceRegistry(): TriggerSourceRegistry {
  return new RegistryImpl<TriggerSource>();
}

/** Worn items grant their prefab's `triggers[]` to the wearer. */
export const equipmentTriggerSource: TriggerSource = {
  id: "equipment",
  collect({ world, content, entityId }): string[] {
    const eq = world.get(entityId, Equipment);
    if (!eq) return [];
    const out: string[] = [];
    for (const slot of [eq.weapon, eq.offHand, eq.head, eq.chest, eq.legs, eq.feet, eq.back]) {
      if (!slot) continue;
      const prefab = content.prefabs.get(slot.prefabId);
      for (const t of prefab?.triggers ?? []) out.push(t);
    }
    return out;
  },
};

/**
 * NPC archetypes carry their template's `triggers[]` innately (T-259c) —
 * signature procs (a cornered wolf's frenzy) without any item. Live read
 * via NpcTag.npcType, the same way NpcAi resolves its tuning.
 */
export const npcTemplateTriggerSource: TriggerSource = {
  id: "npc_template",
  collect({ world, content, entityId }): string[] {
    const tag = world.get(entityId, NpcTag);
    if (!tag) return [];
    return [...(content.npcTemplates.get(tag.npcType)?.triggers ?? [])];
  },
};
