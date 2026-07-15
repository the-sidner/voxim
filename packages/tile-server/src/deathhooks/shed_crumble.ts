/**
 * shed_crumble DeathHook (T-339) — starts a body's death-crumble. Mirrors
 * shed_dissolve.ts's exact shape (same DeathHook-not-Trigger reasoning; see
 * that file's header for why a DeathHook is the only extension point that
 * can still read `NpcTag` before the entity is torn down).
 *
 * A no-op for every entity without a `deathStyleId` resolving to style
 * "crumble" (players, plain NPCs, a dissolve-styled NPC) — the hook is a
 * pure passthrough by default, matching `equip_cleanup`'s "runs for
 * everyone, does nothing when there's nothing to do" shape.
 *
 * For a crumble-styled entity: seeds its `DeathStyleDef.resourceKey`
 * Resource at `crumble.durationTicks` and votes `{ linger: true }` so
 * `DeathSystem` skips its `world.destroy()` this tick — the corpse stays
 * queryable/renderable while the client detaches its bone groups and lets
 * them fall (client-only; the server has nothing further to do but keep
 * the entity alive for the timer's duration). The timer's own terminal
 * threshold (`cross@0` -> `destroy_self`, already `destroySubtree`-safe —
 * see `resources/effects/destroy_self.ts`) does the actual despawn. No
 * double-despawn: DeathSystem's world.destroy is skipped for a lingering
 * entity, and destroy_self is the only remaining path that removes it.
 */

import type { ContentService } from "@voxim/content";
import type { DeathHook } from "../systems/death.ts";
import { Resource } from "../components/resource.ts";
import { createLogger } from "../logger.ts";
import { resolveDeathStyle } from "./death_style.ts";

const log = createLogger("deathhooks:shed_crumble");

export function createShedCrumbleHook(content: ContentService): DeathHook {
  return {
    id: "shed_crumble",
    onDeath(ctx) {
      const style = resolveDeathStyle(content, ctx.world, ctx.entityId);
      if (!style || style.style !== "crumble" || !style.crumble) return;

      const prevValues = ctx.world.get(ctx.entityId, Resource)?.values ?? {};
      ctx.world.set(ctx.entityId, Resource, {
        values: {
          ...prevValues,
          [style.resourceKey]: { value: style.crumble.durationTicks, max: style.crumble.durationTicks },
        },
      });

      log.debug("entity=%s style=%s durationTicks=%d — crumble started, destroy deferred", ctx.entityId, style.id, style.crumble.durationTicks);
      return { linger: true };
    },
  };
}
