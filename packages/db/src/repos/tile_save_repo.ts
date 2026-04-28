import type { DbPool } from "../client.ts";

export interface TileSaveRow {
  tileId: string;
  payload: Uint8Array;
  savedAt: Date;
  sizeBytes: number;
}

export interface TileSaveRepo {
  get(tileId: string): Promise<TileSaveRow | null>;
  put(tileId: string, payload: Uint8Array): Promise<void>;
  delete(tileId: string): Promise<void>;
}

export class PgTileSaveRepo implements TileSaveRepo {
  constructor(private readonly pool: DbPool) {}

  async get(tileId: string): Promise<TileSaveRow | null> {
    const conn = await this.pool.connect();
    try {
      const res = await conn.queryObject<{
        tile_id: string;
        payload: Uint8Array;
        saved_at: Date;
        size_bytes: number;
      }>({
        text: "SELECT tile_id, payload, saved_at, size_bytes FROM tile_saves WHERE tile_id = $1",
        args: [tileId],
      });
      const row = res.rows[0];
      if (!row) return null;
      return {
        tileId: row.tile_id,
        payload: row.payload,
        savedAt: row.saved_at,
        sizeBytes: row.size_bytes,
      };
    } finally {
      conn.release();
    }
  }

  async put(tileId: string, payload: Uint8Array): Promise<void> {
    const conn = await this.pool.connect();
    try {
      await conn.queryArray({
        text: `
          INSERT INTO tile_saves (tile_id, payload, saved_at, size_bytes)
          VALUES ($1, $2, now(), $3)
          ON CONFLICT (tile_id) DO UPDATE
            SET payload = EXCLUDED.payload,
                saved_at = now(),
                size_bytes = EXCLUDED.size_bytes
        `,
        args: [tileId, payload, payload.byteLength],
      });
    } finally {
      conn.release();
    }
  }

  async delete(tileId: string): Promise<void> {
    const conn = await this.pool.connect();
    try {
      await conn.queryArray({
        text: "DELETE FROM tile_saves WHERE tile_id = $1",
        args: [tileId],
      });
    } finally {
      conn.release();
    }
  }
}
