import type { DbPool } from "../client.ts";

export interface SessionRow {
  tokenHash: string;
  userId: string;
  expiresAt: Date;
}

export interface SessionRepo {
  insert(row: SessionRow): Promise<void>;
  getByTokenHash(tokenHash: string): Promise<SessionRow | null>;
  extend(tokenHash: string, expiresAt: Date): Promise<void>;
  delete(tokenHash: string): Promise<void>;
  deleteAllForUser(userId: string): Promise<number>;
  deleteExpired(now: Date): Promise<number>;
}

export class PgSessionRepo implements SessionRepo {
  constructor(private readonly pool: DbPool) {}

  async insert(row: SessionRow): Promise<void> {
    const conn = await this.pool.connect();
    try {
      await conn.queryArray({
        text: "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)",
        args: [row.tokenHash, row.userId, row.expiresAt],
      });
    } finally {
      conn.release();
    }
  }

  async getByTokenHash(tokenHash: string): Promise<SessionRow | null> {
    const conn = await this.pool.connect();
    try {
      const res = await conn.queryObject<{
        token_hash: string;
        user_id: string;
        expires_at: Date;
      }>({
        text: "SELECT token_hash, user_id, expires_at FROM sessions WHERE token_hash = $1",
        args: [tokenHash],
      });
      const row = res.rows[0];
      if (!row) return null;
      return { tokenHash: row.token_hash, userId: row.user_id, expiresAt: row.expires_at };
    } finally {
      conn.release();
    }
  }

  async extend(tokenHash: string, expiresAt: Date): Promise<void> {
    const conn = await this.pool.connect();
    try {
      await conn.queryArray({
        text: "UPDATE sessions SET expires_at = $2 WHERE token_hash = $1",
        args: [tokenHash, expiresAt],
      });
    } finally {
      conn.release();
    }
  }

  async delete(tokenHash: string): Promise<void> {
    const conn = await this.pool.connect();
    try {
      await conn.queryArray({
        text: "DELETE FROM sessions WHERE token_hash = $1",
        args: [tokenHash],
      });
    } finally {
      conn.release();
    }
  }

  async deleteAllForUser(userId: string): Promise<number> {
    const conn = await this.pool.connect();
    try {
      const res = await conn.queryArray({
        text: "DELETE FROM sessions WHERE user_id = $1",
        args: [userId],
      });
      return res.rowCount ?? 0;
    } finally {
      conn.release();
    }
  }

  async deleteExpired(now: Date): Promise<number> {
    const conn = await this.pool.connect();
    try {
      const res = await conn.queryArray({
        text: "DELETE FROM sessions WHERE expires_at < $1",
        args: [now],
      });
      return res.rowCount ?? 0;
    } finally {
      conn.release();
    }
  }
}
