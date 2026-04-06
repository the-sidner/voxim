/**
 * World event bus symbols and payload types — gateway / macro layer.
 *
 * Carries cross-tile events: tile servers publish to this bus, the gateway
 * and macro simulation subscribe. Distinct from the tile event bus.
 */
import type { EntityId } from "@voxim/engine";

export const WorldEvents = {
  PlayerCrossedGate: Symbol("PlayerCrossedGate"),
  TileServerStarted: Symbol("TileServerStarted"),
  TileServerStopped: Symbol("TileServerStopped"),
  CaravanDeparted: Symbol("CaravanDeparted"),
  CityRaided: Symbol("CityRaided"),
} as const;

export interface PlayerCrossedGatePayload {
  playerId: EntityId;
  fromTileId: string;
  toTileId: string;
  gateId: string;
}

export interface TileServerStartedPayload {
  tileId: string;
  address: string;
}

export interface TileServerStoppedPayload {
  tileId: string;
}

export interface CaravanDepartedPayload {
  caravanId: EntityId;
  fromTileId: string;
  toTileId: string;
}

export interface CityRaidedPayload {
  tileId: string;
  raiderId: EntityId;
}
