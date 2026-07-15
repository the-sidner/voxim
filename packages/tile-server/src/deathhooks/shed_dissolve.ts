/**
 * shed_dissolve DeathHook (T-311 P5c, refactored onto DeathStyleDef at
 * T-339) — starts a corrupted creature's death-dissolve. Runs
 * synchronously inside `DeathSystem.run()` BEFORE `world.destroy()`, so it
 * can still read the dying entity's `NpcTag` — the `entity_died` Trigger
 * content can't offer that (see `components/boss_arena.ts`'s header for
 * the pinned-test proof: TriggerSystem's buffered drain runs one tick
 * after DeathSystem has already destroyed the entity, so
 * `world.isAlive(ownerId)` at the trigger role-iteration gate is already
 * false). `DeathHook` is the doctrine-correct extension point for "read
 * state before destruction" — same ergonomics as a Trigger (one handler +
 * one `register()` call), just synchronous instead of event-buffered.
 *
 * A no-op for every entity without a `deathStyleId` resolving to style
 * "dissolve" (players, plain NPCs, the boss, a crumble-styled NPC) — the
 * hook is a pure passthrough by default, matching `equip_cleanup`'s "runs
 * for everyone, does nothing when there's nothing to do" shape. Style
 * DISPATCH (which of shed_dissolve/shed_crumble fires) happens here, per
 * hook — not through a second nested registry, since `Registry<DeathHook>`
 * is already the dispatch layer (see `resolveDeathStyle`'s header).
 *
 * For a dissolve-styled entity: seeds its `DeathStyleDef.resourceKey`
 * Resource at the profile's `durationTicks` and votes `{ linger: true }` so
 * `DeathSystem` skips its `world.destroy()` this tick — the corpse stays
 * queryable/renderable while `ResourceSystem` counts the timer down. The
 * timer's own terminal threshold (`cross@0` -> `destroy_self`) does the
 * actual despawn once the dissolve finishes (see
 * `data/resources/dissolve_timer.json`). No double-despawn: DeathSystem's
 * world.destroy is skipped for a lingering entity, and destroy_self is the
 * only remaining path that removes it.
 *
 * Content-closure factory (not a bare object like the other DeathHooks)
 * because this is the first DeathHook that needs `ContentService` to
 * resolve the dying entity's template -> style -> profile —
 * `DeathHookContext` carries world/events/entityId/killerId/cause only,
 * mirroring `ResourceEffectContext`'s content-via-constructor-closure shape
 * instead of widening every hook's context for one consumer.
 */

import type { ContentService } from "@voxim/content";
import type { DeathHook } from "../systems/death.ts";
import { Resource } from "../components/resource.ts";
import { createLogger } from "../logger.ts";
import { resolveDeathStyle } from "./death_style.ts";

const log = createLogger("deathhooks:shed_dissolve");

export function createShedDissolveHook(content: ContentService): DeathHook {
  return {
    id: "shed_dissolve",
    onDeath(ctx) {
      const style = resolveDeathStyle(content, ctx.world, ctx.entityId);
      if (!style || style.style !== "dissolve") return;

      const profile = style.dissolveProfileId ? content.dissolveProfiles.get(style.dissolveProfileId) : undefined;
      if (!profile) {
        // Boot cross-check guarantees this never happens in practice — but
        // a DeathHook must never throw mid-tick (it would wedge every other
        // pending death this tick), so degrade to "no dissolve" instead.
        log.error("entity=%s deathStyle=%s references unresolved dissolveProfileId=%s", ctx.entityId, style.id, style.dissolveProfileId);
        return;
      }

      const prevValues = ctx.world.get(ctx.entityId, Resource)?.values ?? {};
      ctx.world.set(ctx.entityId, Resource, {
        values: {
          ...prevValues,
          [style.resourceKey]: { value: profile.durationTicks, max: profile.durationTicks },
        },
      });

      log.debug("entity=%s style=%s durationTicks=%d — dissolve started, destroy deferred", ctx.entityId, style.id, profile.durationTicks);
      return { linger: true };
    },
  };
}
