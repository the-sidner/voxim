/**
 * resolveDeathStyle (T-339) — the NpcTag -> NpcTemplate.deathStyleId ->
 * DeathStyleDef lookup shared by every death-style DeathHook
 * (shed_dissolve, shed_crumble). Each hook resolves the SAME style def and
 * then checks it is its OWN style before doing anything — mirrors how
 * multiple DeathHooks already coexist (equip_cleanup, boss_arena_unlock),
 * each independently a no-op for entities outside its concern. Kept as a
 * plain function rather than a registry: there is exactly one lookup
 * chain, reused verbatim by both hooks — a registry here would have
 * exactly one entry, which is not what the registry-dispatch doctrine is
 * for (dispatch belongs at the point a *style* fans out to its handler,
 * i.e. inside each hook's own style check, not at this identity lookup).
 */

import type { ContentService, DeathStyleDef } from "@voxim/content";
import type { World, EntityId } from "@voxim/engine";
import { NpcTag } from "../components/npcs.ts";

export function resolveDeathStyle(
  content: ContentService,
  world: World,
  entityId: EntityId,
): DeathStyleDef | undefined {
  const npcTag = world.get(entityId, NpcTag);
  const styleId = npcTag ? content.npcTemplates.get(npcTag.npcType)?.deathStyleId : undefined;
  return styleId ? content.deathStyles.get(styleId) : undefined;
}
