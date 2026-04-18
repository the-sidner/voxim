/**
 * ResolveStrikePort — narrow one-method interface that lets HitHandlers fire
 * an on-hit skill (verb="strike") without importing SkillSystem concretely.
 *
 * Same pattern as DeathRequestPort: systems that own a piece of authority
 * expose a minimal port; other systems depend on the port, not the class.
 * HealthHitHandler used to hold a full `SkillSystem` reference, which
 * violated the "deferred events for cross-system reactions" invariant and
 * coupled the handler order inside server.ts into an awkward IIFE. This
 * interface decouples them: SkillSystem implements resolveStrike; the hit
 * handler depends only on this type.
 *
 * Semantics are intentionally synchronous so the skill's stamina cost and
 * effect side-effects land in the same changeset as the damage that
 * triggered them — events-based decoupling would introduce a 1-tick delay
 * that makes "heal on hit" feel wrong.
 */
import type { World, EntityId } from "@voxim/engine";
import type { EventEmitter } from "../system.ts";

export interface ResolveStrikePort {
  /**
   * Resolve the skill in `slot` on `casterId` against `targetId`. Called by
   * hit handlers when `SkillInProgress.pendingSkillVerb` begins with "strike:".
   * Returns true if the skill fired; false if it fizzled (cooldown, no
   * stamina, missing entry, etc.).
   */
  resolveStrike(
    world: World,
    events: EventEmitter,
    casterId: EntityId,
    slot: number,
    targetId: EntityId | null,
  ): boolean;
}
