/**
 * Atlas worldmap repo — per-cell rows of a baked worldmap, scoped per
 * world via the `world_id` uuid FK on the `worlds` table.
 *
 * Atlas owns writes (always inside a bake transaction); tile-server +
 * coordinator + inspector consume read-only. Cell shape is jsonb so the
 * parameter bundle can grow without a migration per addition.
 */

import type { DbPool } from "../client.ts";

export interface AtlasCellRow {
  cellX: number;
  cellY: number;
  /** Biome parameter bundle. Opaque to the repo — atlas defines its shape. */
  biome: Record<string, unknown>;
  /** Per-edge gate specs. Opaque to the repo. */
  gates: Record<string, unknown>;
  /** River segments crossing this cell (from worldgen's downhill walk). */
  rivers: unknown[];
}

export interface LoadedAtlasWorld {
  seed: bigint;
  cells: AtlasCellRow[];
}

export interface AtlasWorldRepo {
  /** Returns null when no worldmap exists for this world. */
  load(worldId: string): Promise<LoadedAtlasWorld | null>;
  /**
   * Insert all cells for a freshly-baked world. The world row in `worlds`
   * must already exist (FK). Bakes never UPSERT — each bake creates a
   * new world uuid, so DELETE-then-INSERT semantics aren't needed.
   */
  save(input: {
    worldId: string;
    seed: bigint;
    cells: AtlasCellRow[];
  }): Promise<void>;
  /** Drop a world's cells. Cascade on `worlds` delete handles this too. */
  clear(worldId: string): Promise<void>;
}

export class PgAtlasWorldRepo implements AtlasWorldRepo {
  constructor(private readonly pool: DbPool) {}

  async load(worldId: string): Promise<LoadedAtlasWorld | null> {
    const conn = await this.pool.connect();
    try {
      const res = await conn.queryObject<{
        cell_x: number;
        cell_y: number;
        seed: bigint;
        biome: Record<string, unknown>;
        gates: Record<string, unknown>;
        rivers: unknown[];
      }>({
        text: `
          SELECT cell_x, cell_y, seed, biome, gates, rivers
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
          rivers: r.rivers,
        })),
      };
    } finally {
      conn.release();
    }
  }

  async save(input: {
    worldId: string;
    seed: bigint;
    cells: AtlasCellRow[];
  }): Promise<void> {
    if (input.cells.length === 0) return;
    const conn = await this.pool.connect();
    try {
      // Single multi-row INSERT keeps round-trips down for any plausible
      // world size (16×16 = 256 rows in one query).
      const valuesSql: string[] = [];
      const args: unknown[] = [input.worldId, input.seed];
      let p = 3;
      for (const c of input.cells) {
        valuesSql.push(`($1, $${p++}, $${p++}, $2, $${p++}, $${p++}, $${p++})`);
        args.push(
          c.cellX, c.cellY,
          JSON.stringify(c.biome),
          JSON.stringify(c.gates),
          JSON.stringify(c.rivers),
        );
      }
      await conn.queryArray({
        text: `
          INSERT INTO atlas_world_cells
            (world_id, cell_x, cell_y, seed, biome, gates, rivers)
          VALUES ${valuesSql.join(",")}
        `,
        args,
      });
    } finally {
      conn.release();
    }
  }

  async clear(worldId: string): Promise<void> {
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
