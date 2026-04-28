import type { DbPool } from "../client.ts";

export interface TileRow {
  tileId: string;
  address: string;
  adminUrl: string;
  lastHeartbeatAt: Date;
}

export interface TileRepo {
  upsert(row: Omit<TileRow, "lastHeartbeatAt">): Promise<void>;
  heartbeat(tileId: string): Promise<boolean>;
  get(tileId: string): Promise<TileRow | null>;
  list(): Promise<TileRow[]>;
  delete(tileId: string): Promise<void>;
  evictStale(staleBefore: Date): Promise<string[]>;
}

export class PgTileRepo implements TileRepo {
  constructor(private readonly pool: DbPool) {}

  async upsert(row: Omit<TileRow, "lastHeartbeatAt">): Promise<void> {
    const conn = await this.pool.connect();
    try {
      await conn.queryArray({
        text: `
          INSERT INTO tile_registry (tile_id, address, admin_url, last_heartbeat_at)
          VALUES ($1, $2, $3, now())
          ON CONFLICT (tile_id) DO UPDATE
            SET address = EXCLUDED.address,
                admin_url = EXCLUDED.admin_url,
                last_heartbeat_at = now()
        `,
        args: [row.tileId, row.address, row.adminUrl],
      });
    } finally {
      conn.release();
    }
  }

  async heartbeat(tileId: string): Promise<boolean> {
    const conn = await this.pool.connect();
    try {
      const res = await conn.queryArray({
        text: "UPDATE tile_registry SET last_heartbeat_at = now() WHERE tile_id = $1",
        args: [tileId],
      });
      return (res.rowCount ?? 0) > 0;
    } finally {
      conn.release();
    }
  }

  async get(tileId: string): Promise<TileRow | null> {
    const conn = await this.pool.connect();
    try {
      const res = await conn.queryObject<RawTileRow>({
        text: "SELECT * FROM tile_registry WHERE tile_id = $1",
        args: [tileId],
      });
      return res.rows[0] ? mapTile(res.rows[0]) : null;
    } finally {
      conn.release();
    }
  }

  async list(): Promise<TileRow[]> {
    const conn = await this.pool.connect();
    try {
      const res = await conn.queryObject<RawTileRow>({
        text: "SELECT * FROM tile_registry ORDER BY tile_id",
      });
      return res.rows.map(mapTile);
    } finally {
      conn.release();
    }
  }

  async delete(tileId: string): Promise<void> {
    const conn = await this.pool.connect();
    try {
      await conn.queryArray({
        text: "DELETE FROM tile_registry WHERE tile_id = $1",
        args: [tileId],
      });
    } finally {
      conn.release();
    }
  }

  async evictStale(staleBefore: Date): Promise<string[]> {
    const conn = await this.pool.connect();
    try {
      const res = await conn.queryObject<{ tile_id: string }>({
        text: `
          DELETE FROM tile_registry
          WHERE last_heartbeat_at < $1
          RETURNING tile_id
        `,
        args: [staleBefore],
      });
      return res.rows.map((r) => r.tile_id);
    } finally {
      conn.release();
    }
  }
}

interface RawTileRow {
  tile_id: string;
  address: string;
  admin_url: string;
  last_heartbeat_at: Date;
}

function mapTile(r: RawTileRow): TileRow {
  return {
    tileId: r.tile_id,
    address: r.address,
    adminUrl: r.admin_url,
    lastHeartbeatAt: r.last_heartbeat_at,
  };
}
