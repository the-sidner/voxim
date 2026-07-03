/**
 * lever_sequence puzzle kind (T-212 v2) — N lever entities in an arc at the
 * POI centroid; the player must pull them in a content-derived-deterministic
 * order. `activity.params.length` (from the authoring POI, e.g.
 * `glyph_puzzle.json`) is the lever count; `showHints` is unused server-side
 * (a future client affordance — lit/unlit lever material — not built here,
 * see TICKETS.md scope note).
 *
 * Order is derived from `hash32(poiInstanceId)` via `mulberry32` — a
 * Fisher-Yates shuffle of `[0..length)` — so the SAME POI instance always
 * gets the SAME solution within one tile lifetime (no save persistence for
 * POI/puzzle state, matching WaveState/BossArenaLink).
 *
 * Wrong-order pull -> `failurePenalty` ("reset" resets `nextIndex` to 0,
 * the only value any authored puzzle POI currently uses; "damage"/"none"
 * are accepted content values but no-op here — TODO if content ever uses
 * them). Correct full sequence -> `solved: true` + grants the POI's reward
 * via the shared `poi/reward.ts` helper (same path `action` uses).
 */

import { mulberry32 } from "@voxim/engine";
import type { EntityId } from "@voxim/engine";
import type { PoiActivityPuzzle } from "@voxim/content";
import type { PuzzleKindHandler, PuzzleKindContext } from "./mod.ts";
import { spawnPrefab } from "../../spawner.ts";
import { PoiInteractable } from "../../components/poi.ts";
import { PuzzleState, Lever } from "../../components/puzzle.ts";
import { grantPoiReward } from "../reward.ts";
import { createLogger } from "../../logger.ts";

const log = createLogger("poi:puzzle");

const LEVER_PREFAB_ID = "lever";

function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Deterministic Fisher-Yates shuffle of [0, n) from a seeded RNG. */
function shuffledOrder(n: number, seed: number): number[] {
  const rng = mulberry32(seed);
  const order = Array.from({ length: n }, (_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

export const leverSequenceKind: PuzzleKindHandler = {
  id: "lever_sequence",

  activate(ctx: PuzzleKindContext): void {
    const { world, content, def, pos, poiInstanceId, triggerId } = ctx;
    if (def.type !== "puzzle") return;
    const activity = def.activity as PoiActivityPuzzle;
    const length = Math.max(1, Math.min(255, Number(activity.params.length) || 4));
    const correctOrder = shuffledOrder(length, hash32(poiInstanceId));

    world.write(triggerId, PuzzleState, { poiInstanceId, correctOrder, nextIndex: 0, solved: false });

    for (let i = 0; i < length; i++) {
      const angle = (i / length) * Math.PI * 2;
      const r = 2.5;
      try {
        const id = spawnPrefab(world, content, LEVER_PREFAB_ID, {
          x: pos.x + Math.cos(angle) * r,
          y: pos.y + Math.sin(angle) * r,
          z: pos.z,
        });
        world.write(id, Lever, { poiInstanceId, leverIndex: i });
        world.write(id, PoiInteractable, { poiInstanceId, verb: "pull", consumable: false });
      } catch (err) {
        log.warn("lever spawn failed: %s", (err as Error).message);
      }
    }
    log.info("POI %s: lever_sequence spawned %d levers, order=%s", poiInstanceId, length, correctOrder.join(","));
  },

  use(ctx: PuzzleKindContext, playerId: EntityId, entityId: EntityId): void {
    const { world, events, content, def, pos, triggerId } = ctx;
    if (def.type !== "puzzle") return;
    const activity = def.activity as PoiActivityPuzzle;
    const lever = world.get(entityId, Lever);
    const state = world.get(triggerId, PuzzleState);
    if (!lever || !state || state.solved) return;

    const expected = state.correctOrder[state.nextIndex];
    if (lever.leverIndex !== expected) {
      log.info("POI %s: wrong lever (got %d, expected %d) — penalty=%s",
        state.poiInstanceId, lever.leverIndex, expected, activity.failurePenalty);
      if (activity.failurePenalty === "reset") {
        world.set(triggerId, PuzzleState, { ...state, nextIndex: 0 });
      }
      // "damage" / "none": no-op (no authored puzzle POI currently uses
      // "damage"; accepted content value, not yet wired — TODO).
      return;
    }

    const nextIndex = state.nextIndex + 1;
    if (nextIndex >= state.correctOrder.length) {
      world.set(triggerId, PuzzleState, { ...state, nextIndex, solved: true });
      log.info("POI %s: lever_sequence SOLVED", state.poiInstanceId);
      grantPoiReward(world, content, events, def.reward, playerId, pos);
    } else {
      world.set(triggerId, PuzzleState, { ...state, nextIndex });
    }
  },
};
