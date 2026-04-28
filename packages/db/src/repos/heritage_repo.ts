import type { DbPool } from "../client.ts";

export interface HeritageRow {
  userId: string;
  payload: Uint8Array;
  updatedAt: Date;
}

export interface HeritageRepo {
  get(userId: string): Promise<HeritageRow | null>;
  put(userId: string, payload: Uint8Array): Promise<void>;
}

export class PgHeritageRepo implements HeritageRepo {
  constructor(private readonly pool: DbPool) {}

  async get(userId: string): Promise<HeritageRow | null> {
    const conn = await this.pool.connect();
    try {
      const res = await conn.queryObject<{
        user_id: string;
        payload: Uint8Array;
        updated_at: Date;
      }>({
        text: "SELECT user_id, payload, updated_at FROM heritage WHERE user_id = $1",
        args: [userId],
      });
      const row = res.rows[0];
      if (!row) return null;
      return { userId: row.user_id, payload: row.payload, updatedAt: row.updated_at };
    } finally {
      conn.release();
    }
  }

  async put(userId: string, payload: Uint8Array): Promise<void> {
    const conn = await this.pool.connect();
    try {
      await conn.queryArray({
        text: `
          INSERT INTO heritage (user_id, payload, updated_at)
          VALUES ($1, $2, now())
          ON CONFLICT (user_id) DO UPDATE
            SET payload = EXCLUDED.payload,
                updated_at = now()
        `,
        args: [userId, payload],
      });
    } finally {
      conn.release();
    }
  }
}
