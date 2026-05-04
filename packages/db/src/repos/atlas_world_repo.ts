/**
 * Atlas worldmap repo — per-cell rows of the procedural worldmap.
 *
 * Atlas owns this table exclusively. Tilemap layer (read-only) and the
 * inspector consume it. Whole-worldmap operations are atomic via a single
 * transaction; per-cell update endpoints can land later when needed.
 *
 * Cell shape is stored as jsonb (biome + gates) so the bundle can grow
 * new fields (Q5) without a migration on every addition.
 */

import type { DbPool } from "../client.ts";

export interface AtlasCellRow {
  cellX: number;
  cellY: number;
  /** Biome parameter bundle. Opaque to the repo — atlas defines its shape. */
  biome: Record<string, unknown>;
  /** Per-edge gate specs. Opaque to the repo. */
  gates: Record<string, unknown>;
}

export interface LoadedAtlasWorld {
  seed: bigint;
  cells: AtlasCellRow[];
}

export interface AtlasWorldRepo {
  /** Returns null when no worldmap exists for this world_id. */
  load(worldId?: string): Promise<LoadedAtlasWorld | null>;
  /**
   * Replace the entire worldmap atomically. Every existing row for
   * `worldId` is deleted; the supplied cells are inserted with the
   * given seed. Use when (re-)generating from scratch.
   */
  save(input: {
    worldId?: string;
    seed: bigint;
    cells: AtlasCellRow[];
  }): Promise<void>;
  /** Drop the worldmap, forcing regeneration on next boot. */
  clear(worldId?: string): Promise<void>;
}

export class PgAtlasWorldRepo implements AtlasWorldRepo {
  constructor(private readonly pool: DbPool) {}

  async load(worldId: string = "default"): Promise<LoadedAtlasWorld | null> {
    const conn = await this.pool.connect();
    try {
      const res = await conn.queryObject<{
        cell_x: number;
        cell_y: number;
        seed: bigint;
        biome: Record<string, unknown>;
        gates: Record<string, unknown>;
      }>({
        text: `
          SELECT cell_x, cell_y, seed, biome, gates
          FROM atlas_world_cells
          WHERE world_id = $1
          ORDER BY cell_y, cell_x
        `,
        args: [worldId],
      });
      if (res.rows.length === 0) return null;
      const seed = res.rows[0].seed;
      return {
        seed,
        cells: res.rows.map((r) => ({
          cellX: r.cell_x,
          cellY: r.cell_y,
          biome: r.biome,
          gates: r.gates,
        })),
      };
    } finally {
      conn.release();
    }
  }

  async save(input: {
    worldId?: string;
    seed: bigint;
    cells: AtlasCellRow[];
  }): Promise<void> {
    const worldId = input.worldId ?? "default";
    const conn = await this.pool.connect();
    try {
      await conn.queryArray("BEGIN");
      try {
        await conn.queryArray({
          text: "DELETE FROM atlas_world_cells WHERE world_id = $1",
          args: [worldId],
        });
        // Single multi-row INSERT keeps the round-trips down for any
        // plausible world size. A 16×16 world is 256 rows in one query.
        if (input.cells.length > 0) {
          const valuesSql: string[] = [];
          const args: unknown[] = [worldId, input.seed];
          let p = 3;
          for (const c of input.cells) {
            valuesSql.push(`($1, $${p++}, $${p++}, $2, $${p++}, $${p++})`);
            args.push(c.cellX, c.cellY, JSON.stringify(c.biome), JSON.stringify(c.gates));
          }
          await conn.queryArray({
            text: `
              INSERT INTO atlas_world_cells
                (world_id, cell_x, cell_y, seed, biome, gates)
              VALUES ${valuesSql.join(",")}
            `,
            args,
          });
        }
        await conn.queryArray("COMMIT");
      } catch (e) {
        await conn.queryArray("ROLLBACK");
        throw e;
      }
    } finally {
      conn.release();
    }
  }

  async clear(worldId: string = "default"): Promise<void> {
    const conn = await this.pool.connect();
    try {
      await conn.queryArray({
        text: "DELETE FROM atlas_world_cells WHERE world_id = $1",
        args: [worldId],
      });
    } finally {
      conn.release();
    }
  }
}
