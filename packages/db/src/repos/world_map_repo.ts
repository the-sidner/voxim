import type { DbPool } from "../client.ts";

export interface WorldMapRow {
  worldId: string;
  seed: bigint;
  payload: Uint8Array;
  generatedAt: Date;
}

export interface WorldMapRepo {
  get(worldId?: string): Promise<WorldMapRow | null>;
  put(input: { worldId?: string; seed: bigint; payload: Uint8Array }): Promise<void>;
}

export class PgWorldMapRepo implements WorldMapRepo {
  constructor(private readonly pool: DbPool) {}

  async get(worldId: string = "default"): Promise<WorldMapRow | null> {
    const conn = await this.pool.connect();
    try {
      const res = await conn.queryObject<{
        world_id: string;
        seed: bigint;
        payload: Uint8Array;
        generated_at: Date;
      }>({
        text: "SELECT world_id, seed, payload, generated_at FROM world_map WHERE world_id = $1",
        args: [worldId],
      });
      const row = res.rows[0];
      if (!row) return null;
      return {
        worldId: row.world_id,
        seed: row.seed,
        payload: row.payload,
        generatedAt: row.generated_at,
      };
    } finally {
      conn.release();
    }
  }

  async put(input: { worldId?: string; seed: bigint; payload: Uint8Array }): Promise<void> {
    const conn = await this.pool.connect();
    try {
      await conn.queryArray({
        text: `
          INSERT INTO world_map (world_id, seed, payload, generated_at)
          VALUES ($1, $2, $3, now())
          ON CONFLICT (world_id) DO UPDATE
            SET seed = EXCLUDED.seed,
                payload = EXCLUDED.payload,
                generated_at = now()
        `,
        args: [input.worldId ?? "default", input.seed, input.payload],
      });
    } finally {
      conn.release();
    }
  }
}
