import { newEntityId } from "@voxim/engine";
import type { EntityId } from "@voxim/engine";

export interface TileEntry {
  tileId: string;
  /** WebTransport address for direct client connections: "host:port" */
  address: string;
  /** Plain HTTP URL for gateway → tile internal communication: "http://host:adminPort" */
  adminUrl: string;
}

/**
 * Tile directory — maps tile IDs to their tile server addresses.
 *
 * Vertical slice: one entry, registered at gateway startup via config.
 * Future: tile servers register themselves via GatewayRegisterRequest on startup,
 * deregister on shutdown. The directory is the source of truth for which tiles
 * are currently alive.
 */
export class TileDirectory {
  private tiles = new Map<string, TileEntry>();
  /** Player → current tile mapping. */
  private playerTile = new Map<EntityId, string>();

  register(entry: TileEntry): void {
    this.tiles.set(entry.tileId, entry);
    console.log(`[TileDirectory] registered tile ${entry.tileId} at ${entry.address}`);
  }

  deregister(tileId: string): void {
    this.tiles.delete(tileId);
    console.log(`[TileDirectory] removed tile ${tileId}`);
  }

  get(tileId: string): TileEntry | null {
    return this.tiles.get(tileId) ?? null;
  }

  /**
   * Resolve which tile a player should connect to.
   * Vertical slice: always returns the first (only) registered tile.
   * Future: persistent player location lookup from a state store.
   */
  tileForPlayer(playerId: EntityId): TileEntry | null {
    const currentTileId = this.playerTile.get(playerId);
    if (currentTileId) {
      return this.tiles.get(currentTileId) ?? this.firstTile();
    }
    return this.firstTile();
  }

  setPlayerTile(playerId: EntityId, tileId: string): void {
    this.playerTile.set(playerId, tileId);
  }

  removePlayer(playerId: EntityId): void {
    this.playerTile.delete(playerId);
  }

  private firstTile(): TileEntry | null {
    return this.tiles.values().next().value ?? null;
  }

  /** Generate a new player ID. */
  static newPlayerId(): EntityId {
    return newEntityId();
  }
}
