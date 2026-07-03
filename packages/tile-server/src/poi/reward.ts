/**
 * Shared POI reward-grant helper (T-212 v2) — `PoiReward.extras` fan-out,
 * used by every activity whose completion should pay out (action's
 * consumable use, puzzle's solve; wave/bossfight/encounter completions are
 * a separate, larger "convert a cleared POI into a trinket" pipeline —
 * see TICKETS.md T-212's body for why that's explicitly out of scope here).
 *
 * `lore` extras publish `LoreInternalised` (same event `exploration` uses).
 * `stack` extras drop a ground item stack near the player (mirrors resource
 * node yields via `spawnGroundStack` — no inventory-capacity edge cases).
 * `unique` extras are NOT granted here (deferred — see the ticket note);
 * logged so a cut corner is visible, not silent.
 */

import type { World } from "@voxim/engine";
import type { ContentService, PoiReward } from "@voxim/content";
import { TileEvents } from "@voxim/protocol";
import type { EventEmitter } from "../system.ts";
import { spawnGroundStack } from "../spawner.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("poi:reward");

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
    switch (extra.kind) {
      case "lore":
        events.publish(TileEvents.LoreInternalised, { entityId: playerId, fragmentId: extra.id });
        break;
      case "stack":
        spawnGroundStack(world, content, extra.id, extra.qty ?? 1, pos, { from: pos });
        break;
      case "unique":
        // Deferred (T-212 v2 scope cut, see TICKETS.md): the trinket-drop
        // pipeline (dynamic per-bake trinket ids -> unique ItemEffects
        // entity) is separate, larger work. Logged, not silent.
        log.warn("extra drop kind 'unique' (id=%s) not granted — deferred, see TICKETS.md T-212", extra.id);
        break;
    }
  }
}
