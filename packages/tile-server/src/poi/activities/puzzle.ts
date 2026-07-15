/**
 * puzzle POI activity (T-212 v2) — dispatches to a `PuzzleKindHandler` by
 * `activity.puzzleId`'s `PuzzleDef.kind` (registry-of-registries: the POI
 * registry dispatches on `def.type`, this handler dispatches AGAIN on the
 * puzzle template's `kind` — the same "dispatch by template kind through a
 * registry" the ticket calls for). v1 ships one kind (`lever_sequence`);
 * a second template is a new `puzzle_kinds/` file + one `register()` call.
 */

import type { PoiActivityPuzzle } from "@voxim/content";
import type { PoiActivityHandler } from "../activity.ts";
import { newPuzzleKindRegistry } from "../puzzle_kinds/mod.ts";
import { createLogger } from "../../logger.ts";

const log = createLogger("poi:puzzle");
const kinds = newPuzzleKindRegistry();

export const puzzleActivity: PoiActivityHandler = {
  id: "puzzle",
  activate(ctx) {
    const activity = ctx.def.activity as PoiActivityPuzzle;
    const puzzleDef = ctx.content.puzzles.get(activity.puzzleId);
    if (!puzzleDef) {
      log.warn("POI %s: puzzleId '%s' has no loaded PuzzleDef", ctx.poiInstanceId, activity.puzzleId);
      return;
    }
    kinds.get(puzzleDef.kind).activate(ctx);
  },
};
