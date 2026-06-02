/**
 * POI activity handler (T-245) — the registry-dispatch substrate for POI
 * behaviour, replacing the `switch (def.type)` in PoiSystem.
 *
 * A POI fires its activity when a player first crosses its trigger radius.
 * Each activity *type* (encounter, exploration, bossfight, …) is a
 * registered handler keyed by `PoiDef.type` — one handler file + one
 * `register()` call, never a new switch case. This is the same doctrine the
 * action effects / gates / hit handlers / BT nodes already follow, and the
 * "per-type adapter modules" the original PoiSystem comment anticipated.
 */

import type { World } from "@voxim/engine";
import type { Registry } from "@voxim/engine";
import type { ContentService, PoiDef } from "@voxim/content";
import type { EventEmitter } from "../system.ts";

export interface PoiActivityContext {
  world: World;
  events: EventEmitter;
  content: ContentService;
  /** The resolved POI definition. `def.activity` narrows to this handler's
   * shape — the registry guarantees `handler.id === def.type`. */
  def: PoiDef;
  /** The POI's world centroid (the trigger entity's Position). */
  pos: { x: number; y: number; z: number };
  /** The player whose crossing fired the activity. */
  playerId: string;
  /** This POI instance's id (for logging / per-instance state). */
  poiInstanceId: string;
}

export interface PoiActivityHandler {
  /** Registry key — matches `PoiDef.type`. */
  id: string;
  activate(ctx: PoiActivityContext): void;
}

export type PoiActivityRegistry = Registry<PoiActivityHandler>;
