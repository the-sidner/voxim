/**
 * Worlds repo — singleton-active model.
 *
 * Each atlas bake INSERTs a fresh row with a new uuid. Services pick the
 * latest row by `baked_at` at boot. Older rows linger as a record (cheap;
 * a future inspector "purge old" affordance can clean them up).
 *
 * Atlas owns writes (insert / delete). Tile-server + coordinator are
 * read-only consumers (`getLatest` at boot, `get(id)` if they need to
 * detect "newer bake exists" via polling).
 */

import type { DbPool } from "../client.ts";

export interface WorldRow {
  /** uuid. */
  id: string;
  name: string;
  seed: bigint;
  width: number;
  height: number;
  /** Bumps on each rebake of the same logical world (manual; not used yet). */
  version: number;
  bakedAt: Date;
  /**
   * Worldgen tuning. Opaque to the repo — atlas defines the GenParams
   * shape. Stored as jsonb; an empty object means "fall back to atlas's
   * current defaults" (the bake helper merges before persisting).
   */
  params: Record<string, unknown>;
}

export interface WorldsRepo {
  /** Every world ever baked, newest first. Cheap — small table. */
  list(): Promise<WorldRow[]>;
  /** The active world: latest row by baked_at. null when none have been baked. */
  getLatest(): Promise<WorldRow | null>;
  get(id: string): Promise<WorldRow | null>;
  /** Insert a freshly-baked world. id is generated client-side. */
  insert(input: {
    id: string;
    name: string;
    seed: bigint;
    width: number;
    height: number;
    version?: number;
    params?: Record<string, unknown>;
  }): Promise<WorldRow>;
  delete(id: string): Promise<void>;
}

export class PgWorldsRepo implements WorldsRepo {
  constructor(private readonly pool: DbPool) {}

  async list(): Promise<WorldRow[]> {
    const conn = await this.pool.connect();
    try {
      const res = await conn.queryObject<RawRow>(
        "SELECT id, name, seed, width, height, version, baked_at, params FROM worlds ORDER BY baked_at DESC",
      );
      return res.rows.map(toRow);
    } finally {
      conn.release();
    }
  }

  async getLatest(): Promise<WorldRow | null> {
    const conn = await this.pool.connect();
    try {
      const res = await conn.queryObject<RawRow>(
        "SELECT id, name, seed, width, height, version, baked_at, params FROM worlds ORDER BY baked_at DESC LIMIT 1",
      );
      return res.rows[0] ? toRow(res.rows[0]) : null;
    } finally {
      conn.release();
    }
  }

  async get(id: string): Promise<WorldRow | null> {
    const conn = await this.pool.connect();
    try {
      const res = await conn.queryObject<RawRow>({
        text: "SELECT id, name, seed, width, height, version, baked_at, params FROM worlds WHERE id = $1",
        args: [id],
      });
      return res.rows[0] ? toRow(res.rows[0]) : null;
    } finally {
      conn.release();
    }
  }

  async insert(input: {
    id: string;
    name: string;
    seed: bigint;
    width: number;
    height: number;
    version?: number;
    params?: Record<string, unknown>;
  }): Promise<WorldRow> {
    const conn = await this.pool.connect();
    try {
      const res = await conn.queryObject<RawRow>({
        text: `
          INSERT INTO worlds (id, name, seed, width, height, version, params)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
          RETURNING id, name, seed, width, height, version, baked_at, params
        `,
        args: [
          input.id, input.name, input.seed, input.width, input.height,
          input.version ?? 1,
          JSON.stringify(input.params ?? {}),
        ],
      });
      return toRow(res.rows[0]);
    } finally {
      conn.release();
    }
  }

  async delete(id: string): Promise<void> {
    const conn = await this.pool.connect();
    try {
      await conn.queryArray({
        text: "DELETE FROM worlds WHERE id = $1",
        args: [id],
      });
    } finally {
      conn.release();
    }
  }
}

interface RawRow {
  id: string;
  name: string;
  seed: bigint;
  width: number;
  height: number;
  version: number;
  baked_at: Date;
  params: Record<string, unknown>;
}

function toRow(r: RawRow): WorldRow {
  return {
    id: r.id,
    name: r.name,
    seed: r.seed,
    width: r.width,
    height: r.height,
    version: r.version,
    bakedAt: r.baked_at,
    params: r.params,
  };
}
