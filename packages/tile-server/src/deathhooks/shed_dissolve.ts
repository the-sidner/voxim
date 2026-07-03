/**
 * shed_dissolve DeathHook (T-311 P5c) — starts a corrupted creature's
 * death-dissolve. Runs synchronously inside `DeathSystem.run()` BEFORE
 * `world.destroy()`, so it can still read the dying entity's `NpcTag` — the
 * `entity_died` Trigger content can't offer that (see `components/boss_arena.ts`'s
 * header for the pinned-test proof: TriggerSystem's buffered drain runs one
 * tick after DeathSystem has already destroyed the entity, so
 * `world.isAlive(ownerId)` at the trigger role-iteration gate is already
 * false). `DeathHook` is the doctrine-correct extension point for "read
 * state before destruction" — same ergonomics as a Trigger (one handler +
 * one `register()` call), just synchronous instead of event-buffered.
 *
 * A no-op for every entity without a `dissolveProfileId` (players, plain
 * NPCs, the boss) — the hook is a pure passthrough by default, matching
 * `equip_cleanup`'s "runs for everyone, does nothing when there's nothing
 * to do" shape.
 *
 * For a profiled entity: seeds a `dissolve_timer` Resource at the profile's
 * `durationTicks` and votes `{ linger: true }` so `DeathSystem` skips its
 * `world.destroy()` this tick — the corpse stays queryable/renderable while
 * `ResourceSystem` counts the timer down. `dissolve_timer`'s own terminal
 * threshold (`cross@0` -> `destroy_self`) does the actual despawn once the
 * dissolve finishes (see `data/resources/dissolve_timer.json`). No
 * double-despawn: DeathSystem's world.destroy is skipped for a lingering
 * entity, and destroy_self is the only remaining path that removes it.
 *
 * Content-closure factory (not a bare object like the other DeathHooks)
 * because this is the first DeathHook that needs `ContentService` to
 * resolve the dying entity's template -> profile — `DeathHookContext`
 * carries world/events/entityId/killerId/cause only, mirroring
 * `ResourceEffectContext`'s content-via-constructor-closure shape instead
 * of widening every hook's context for one consumer.
 */

import type { ContentService } from "@voxim/content";
import type { DeathHook } from "../systems/death.ts";
import { NpcTag } from "../components/npcs.ts";
import { Resource } from "../components/resource.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("deathhooks:shed_dissolve");

export function createShedDissolveHook(content: ContentService): DeathHook {
  return {
    id: "shed_dissolve",
    onDeath(ctx) {
      const npcTag = ctx.world.get(ctx.entityId, NpcTag);
      const template = npcTag ? content.npcTemplates.get(npcTag.npcType) : undefined;
      const profileId = template?.dissolveProfileId;
      if (!profileId) return;

      const profile = content.dissolveProfiles.get(profileId);
      if (!profile) {
        // Boot cross-check guarantees this never happens in practice — but
        // a DeathHook must never throw mid-tick (it would wedge every other
        // pending death this tick), so degrade to "no dissolve" instead.
        log.error("entity=%s template=%s references unresolved dissolveProfileId=%s", ctx.entityId, template?.id, profileId);
        return;
      }

      const prevValues = ctx.world.get(ctx.entityId, Resource)?.values ?? {};
      ctx.world.set(ctx.entityId, Resource, {
        values: {
          ...prevValues,
          dissolve_timer: { value: profile.durationTicks, max: profile.durationTicks },
        },
      });

      log.debug("entity=%s profile=%s durationTicks=%d — dissolve started, destroy deferred", ctx.entityId, profileId, profile.durationTicks);
      return { linger: true };
    },
  };
}
