import type { DbPool } from "../client.ts";

export interface TileSaveRow {
  worldId: string;
  tileId: string;
  payload: Uint8Array;
  savedAt: Date;
  sizeBytes: number;
}

export interface TileSaveRepo {
  get(worldId: string, tileId: string): Promise<TileSaveRow | null>;
  put(worldId: string, tileId: string, payload: Uint8Array): Promise<void>;
  delete(worldId: string, tileId: string): Promise<void>;
}

export class PgTileSaveRepo implements TileSaveRepo {
  constructor(private readonly pool: DbPool) {}

  async get(worldId: string, tileId: string): Promise<TileSaveRow | null> {
    const conn = await this.pool.connect();
    try {
      const res = await conn.queryObject<{
        world_id: string;
        tile_id: string;
        payload: Uint8Array;
        saved_at: Date;
        size_bytes: number;
      }>({
        text: "SELECT world_id, tile_id, payload, saved_at, size_bytes FROM tile_saves WHERE world_id = $1 AND tile_id = $2",
        args: [worldId, tileId],
      });
      const row = res.rows[0];
      if (!row) return null;
      return {
        worldId: row.world_id,
        tileId: row.tile_id,
        payload: row.payload,
        savedAt: row.saved_at,
        sizeBytes: row.size_bytes,
      };
    } finally {
      conn.release();
    }
  }

  async put(worldId: string, tileId: string, payload: Uint8Array): Promise<void> {
    const conn = await this.pool.connect();
    try {
      await conn.queryArray({
        text: `
          INSERT INTO tile_saves (world_id, tile_id, payload, saved_at, size_bytes)
          VALUES ($1, $2, $3, now(), $4)
          ON CONFLICT (world_id, tile_id) DO UPDATE
            SET payload = EXCLUDED.payload,
                saved_at = now(),
                size_bytes = EXCLUDED.size_bytes
        `,
        args: [worldId, tileId, payload, payload.byteLength],
      });
    } finally {
      conn.release();
    }
  }

  async delete(worldId: string, tileId: string): Promise<void> {
    const conn = await this.pool.connect();
    try {
      await conn.queryArray({
        text: "DELETE FROM tile_saves WHERE world_id = $1 AND tile_id = $2",
        args: [worldId, tileId],
      });
    } finally {
      conn.release();
    }
  }
}
