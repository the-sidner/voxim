/**
 * Accumulating state for the tilemap pipeline.
 *
 * Each stage takes the prior state, runs its work, and returns the prior
 * state plus its produced fields. The types here name that progression
 * explicitly: `NoiseState` is what exists after `noiseField` runs;
 * `JunctionsState extends NoiseState` is what exists after `junctions`
 * runs; and so on. Reordering stages is a compile error because the
 * `pipe()` overload requires successive `TOut → TIn` matches.
 *
 * The transformer pattern (@voxim/levelgen) gives each stage:
 *   `Transformer<PrevState, NextState, Params>`
 * which is `(state, seed, params) => newState`.
 *
 * Seed strategy in this migration: every stage receives `tileSeed`
 * verbatim and continues to combine it internally with its own
 * `SUB_SEED` constant — byte-identical with the pre-T-204 pipeline.
 * Migrating to `splitSeed()` is deliberate behaviour change and lives
 * in a follow-up ticket.
 */

import type { WorldCellRecord } from "../../worldmap/types.ts";
import type { Junction } from "./junctions.ts";
import type { Corridor, Portal, Room } from "../types.ts";

export interface PipelineBase {
  worldCell: WorldCellRecord;
  tileSize: number;
  gridSize: number;
  px2world: number;
}

export interface NoiseState extends PipelineBase {
  noiseField: Float32Array;
}

export interface JunctionsState extends NoiseState {
  seeds: Junction[];
}

export interface NetworkState extends JunctionsState {
  /** Mutated by network/rooms/portals/rivers stages. */
  openMask: Uint8Array;
  corridors: Corridor[];
  degrees: Uint8Array;
}

export interface RoomsState extends NetworkState {
  chamberOf: Uint16Array;
  chambers: Room[];
}

export interface PortalsState extends RoomsState {
  rooms: Room[];
  roomOf: Uint16Array;
  portals: Portal[];
}

export interface KindsState extends PortalsState {
  kindOf: Uint16Array;
}

/**
 * Rivers mutates `openMask` and `kindOf` in place and produces no new
 * fields; the state type is unchanged across this stage but the values
 * inside change.
 */
export type RiversState = KindsState;

export interface TerrainState extends RiversState {
  heightMap: Float32Array;
}

export interface MaterialsState extends TerrainState {
  materials: Uint16Array;
}
