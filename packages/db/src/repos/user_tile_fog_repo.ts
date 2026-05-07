/**
 * Per-(user, tile) fog-of-war persistence (T-161).
 *
 * The bitmap is the bit-packed `seenEver` buffer the tile-server's
 * FogOfWarSystem maintains — opaque to Postgres, kept as `bytea`.  Always
 * fixed length (`FOG_GRID_BYTES` = 8192) but the repo doesn't enforce that
 * here; the caller (account service) trusts what tile-server writes.
 */
import type { DbPool } from "../client.ts";

export interface UserTileFogRow {
  userId: string;
  tileId: string;
  bitmap: Uint8Array;
  updatedAt: Date;
}

export interface UserTileFogRepo {
  get(userId: string, tileId: string): Promise<UserTileFogRow | null>;
  put(userId: string, tileId: string, bitmap: Uint8Array): Promise<void>;
}

export class PgUserTileFogRepo implements UserTileFogRepo {
  constructor(private readonly pool: DbPool) {}

  async get(userId: string, tileId: string): Promise<UserTileFogRow | null> {
    const conn = await this.pool.connect();
    try {
      const res = await conn.queryObject<{
        user_id: string;
        tile_id: string;
        bitmap: Uint8Array;
        updated_at: Date;
      }>({
        text: `
          SELECT user_id, tile_id, bitmap, updated_at
          FROM user_tile_fog
          WHERE user_id = $1 AND tile_id = $2
        `,
        args: [userId, tileId],
      });
      const row = res.rows[0];
      if (!row) return null;
      return {
        userId: row.user_id,
        tileId: row.tile_id,
        bitmap: row.bitmap,
        updatedAt: row.updated_at,
      };
    } finally {
      conn.release();
    }
  }

  async put(userId: string, tileId: string, bitmap: Uint8Array): Promise<void> {
    const conn = await this.pool.connect();
    try {
      await conn.queryArray({
        text: `
          INSERT INTO user_tile_fog (user_id, tile_id, bitmap, updated_at)
          VALUES ($1, $2, $3, now())
          ON CONFLICT (user_id, tile_id) DO UPDATE
            SET bitmap = EXCLUDED.bitmap,
                updated_at = now()
        `,
        args: [userId, tileId, bitmap],
      });
    } finally {
      conn.release();
    }
  }
}
