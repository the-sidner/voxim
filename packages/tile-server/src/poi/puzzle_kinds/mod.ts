/**
 * Puzzle-kind registry (T-212 v2) — "how does this puzzle TEMPLATE work?"
 * dispatched by `PuzzleDef.kind`, mirroring every other registry-dispatch
 * substrate in the codebase (POI activities, action effects/gates, BT
 * nodes, hit handlers). v1 ships exactly one kind: `lever_sequence`. Adding
 * a second (reflection_path, valve_sequence) is one handler file + one
 * `register()` call here, never an engine edit.
 */

import type { World } from "@voxim/engine";
import type { EntityId, Registry } from "@voxim/engine";
import { Registry as RegistryImpl } from "@voxim/engine";
import type { ContentService, PoiDef } from "@voxim/content";
import type { EventEmitter } from "../../system.ts";
import { leverSequenceKind } from "./lever_sequence.ts";

export interface PuzzleKindContext {
  world: World;
  events: EventEmitter;
  content: ContentService;
  def: PoiDef;
  pos: { x: number; y: number; z: number };
  poiInstanceId: string;
  /** The PoiTrigger entity — puzzle state lives here (same convention
   * WaveState/BossArenaLink use). */
  triggerId: EntityId;
}

export interface PuzzleKindHandler {
  /** Registry key — matches `PuzzleDef.kind`. */
  id: string;
  /** Spawn the puzzle's interactable entities (levers, …) and seed its
   * server-only state. Called once, from the `puzzle` POI activity's
   * `activate()`. */
  activate(ctx: PuzzleKindContext): void;
  /**
   * A player used one of the puzzle's spawned entities via
   * `CommandType.UseEntity`. `entityId` is the interactable that was
   * clicked; the handler resolves which puzzle-specific meaning it has
   * (e.g. `lever_sequence` reads `Lever.leverIndex` off it).
   */
  use(ctx: PuzzleKindContext, playerId: EntityId, entityId: EntityId): void;
}

export type PuzzleKindRegistry = Registry<PuzzleKindHandler>;

export function newPuzzleKindRegistry(): PuzzleKindRegistry {
  const r = new RegistryImpl<PuzzleKindHandler>();
  r.register(leverSequenceKind);
  return r;
}
