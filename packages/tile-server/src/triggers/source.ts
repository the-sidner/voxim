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
import { BossArenaLink } from "../components/boss_arena.ts";

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

/**
 * Bossfight phase-adds (T-212 v2) — `BossArenaLink`-presence grants
 * `{poiDefId}_phase_add_{i}` for every index of that POI's
 * `arenaRules.phaseTriggers`. A live-read source, not a per-boss
 * npcTemplate trigger list: the bossfight activity's `bossNpcId`s resolve
 * through the SAME spawn-table stub `wave`/`encounter` use (e.g.
 * `stone_construct` → the real `rotten_knight` template), so granting
 * phase-adds via `npcTemplateTriggerSource` would proc them on every
 * ordinary rotten_knight, not just the one playing the boss role.
 * Component presence (`BossArenaLink`, written only by
 * `poi/activities/bossfight.ts`) scopes it correctly without an
 * `isBoss` branch anywhere. Trigger ids are DERIVED from content
 * (`phaseTriggers.length`), not hardcoded — one authored trigger file per
 * boss × phase (`data/triggers/{poiDefId}_phase_add_{i}.json`), boot-
 * cross-checked like every other content id.
 */
export const bossArenaLinkTriggerSource: TriggerSource = {
  id: "boss_arena_link",
  collect({ world, content, entityId }): string[] {
    const link = world.get(entityId, BossArenaLink);
    if (!link) return [];
    const def = content.pois.get(link.poiDefId);
    if (!def || def.type !== "bossfight") return [];
    const count = def.activity.arenaRules.phaseTriggers.length;
    return Array.from({ length: count }, (_, i) => `${link.poiDefId}_phase_add_${i}`);
  },
};
