/**
 * Shared POI reward-grant helper (T-212 v2) — `PoiReward.extras` fan-out,
 * used by every activity whose completion should pay out (action's
 * consumable use, puzzle's solve; wave/bossfight/encounter completions are
 * a separate, larger "convert a cleared POI into a trinket" pipeline —
 * see TICKETS.md T-212's body for why that's explicitly out of scope here).
 *
 * Each extra `kind` is a registered handler (registry-dispatch doctrine —
 * same substrate as poi/activity.ts). `PoiExtraDrop.kind` is a closed
 * picklist at content-load time (poi_schema.ts), so `Registry.get()` cannot
 * miss at runtime; no separate boot cross-check needed.
 *
 * `lore` extras publish `LoreInternalised` (same event `exploration` uses).
 * `stack` extras drop a ground item stack near the player (mirrors resource
 * node yields via `spawnGroundStack` — no inventory-capacity edge cases).
 * `unique` extras are NOT granted here (deferred — see the ticket note);
 * logged so a cut corner is visible, not silent.
 */

import type { World } from "@voxim/engine";
import { Registry } from "@voxim/engine";
import type { ContentService, PoiReward, PoiExtraDrop } from "@voxim/content";
import { TileEvents } from "@voxim/protocol";
import type { EventEmitter } from "../system.ts";
import { spawnGroundStack } from "../spawner.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("poi:reward");

export interface RewardExtraContext {
  world: World;
  content: ContentService;
  events: EventEmitter;
  /** The extra being granted. `extra.kind === handler.id` by dispatch. */
  extra: PoiExtraDrop;
  /** The player being rewarded. */
  playerId: string;
  /** Where ground drops land (the POI/player position the caller passed). */
  pos: { x: number; y: number; z: number };
}

export interface RewardExtraHandler {
  /** Registry key — matches `PoiExtraDrop.kind`. */
  id: string;
  grant(ctx: RewardExtraContext): void;
}

const rewardExtras = new Registry<RewardExtraHandler>();

rewardExtras.register({
  id: "lore",
  grant({ events, extra, playerId }) {
    events.publish(TileEvents.LoreInternalised, { entityId: playerId, fragmentId: extra.id });
  },
});

rewardExtras.register({
  id: "stack",
  grant({ world, content, extra, pos }) {
    spawnGroundStack(world, content, extra.id, extra.qty ?? 1, pos, { from: pos });
  },
});

rewardExtras.register({
  id: "unique",
  grant({ extra }) {
    // Deferred (T-212 v2 scope cut, see TICKETS.md): the trinket-drop
    // pipeline (dynamic per-bake trinket ids -> unique ItemEffects
    // entity) is separate, larger work. Logged, not silent.
    log.warn("extra drop kind 'unique' (id=%s) not granted — deferred, see TICKETS.md T-212", extra.id);
  },
});

export function grantPoiReward(
  world: World,
  content: ContentService,
  events: EventEmitter,
  reward: PoiReward,
  playerId: string,
  pos: { x: number; y: number; z: number },
): void {
  for (const extra of reward.extras) {
    if ((extra.chance ?? 1.0) < Math.random()) continue;
    rewardExtras.get(extra.kind).grant({ world, content, events, extra, playerId, pos });
  }
}
