/**
 * Atlas tilemap repo — per-tile pre-computed initial state.
 *
 * Atlas writes; tile-server (read-only) and the inspector consume.
 *
 * `payload` is the serialised TileInitWire (base64 typed arrays + JSON
 * metadata). Held opaquely here — atlas defines its shape.
 */

import type { DbPool } from "../client.ts";

export interface AtlasTileInitRow {
  worldId: string;
  tileId: string;
  cellX: number;
  cellY: number;
  seed: bigint;
  payload: Record<string, unknown>;
  generatedAt: Date;
}

export interface AtlasTileSummaryRow {
  cellX: number;
  cellY: number;
  /** gateSummary u16 extracted from the payload's gateSummary field. */
  summary: number;
  seed: bigint;
}

export interface AtlasTileInitRepo {
  /** Returns null when nothing's been generated for this tile yet. */
  get(tileId: string, worldId?: string): Promise<AtlasTileInitRow | null>;

  /** List all tile_init rows for a world (compact metadata, no payload). */
  list(worldId?: string): Promise<Array<Omit<AtlasTileInitRow, "payload">>>;

  /**
   * Cheap per-tile summary list — pulls only the gateSummary u16 out of
   * each row's payload. Used by the inspector world view to draw
   * internal connectivity without dragging full payloads over the wire.
   */
  listSummaries(worldId?: string): Promise<AtlasTileSummaryRow[]>;

  put(input: {
    worldId?: string;
    tileId: string;
    cellX: number;
    cellY: number;
    seed: bigint;
    payload: Record<string, unknown>;
  }): Promise<void>;

  /** Drop one tile's row, forcing regeneration on next request. */
  delete(tileId: string, worldId?: string): Promise<void>;

  /** Drop every tile in this world (e.g. on world re-seed). */
  deleteAll(worldId?: string): Promise<void>;
}

export class PgAtlasTileInitRepo implements AtlasTileInitRepo {
  constructor(private readonly pool: DbPool) {}

  async get(tileId: string, worldId: string = "default"): Promise<AtlasTileInitRow | null> {
    const conn = await this.pool.connect();
    try {
      const res = await conn.queryObject<{
        world_id: string;
        tile_id: string;
        cell_x: number;
        cell_y: number;
        seed: bigint;
        payload: Record<string, unknown>;
        generated_at: Date;
      }>({
        text: `
          SELECT world_id, tile_id, cell_x, cell_y, seed, payload, generated_at
          FROM atlas_tile_init
          WHERE world_id = $1 AND tile_id = $2
        `,
        args: [worldId, tileId],
      });
      const row = res.rows[0];
      if (!row) return null;
      return {
        worldId: row.world_id,
        tileId:  row.tile_id,
        cellX:   row.cell_x,
        cellY:   row.cell_y,
        seed:    row.seed,
        payload: row.payload,
        generatedAt: row.generated_at,
      };
    } finally {
      conn.release();
    }
  }

  async list(worldId: string = "default"): Promise<Array<Omit<AtlasTileInitRow, "payload">>> {
    const conn = await this.pool.connect();
    try {
      const res = await conn.queryObject<{
        world_id: string;
        tile_id: string;
        cell_x: number;
        cell_y: number;
        seed: bigint;
        generated_at: Date;
      }>({
        text: `
          SELECT world_id, tile_id, cell_x, cell_y, seed, generated_at
          FROM atlas_tile_init
          WHERE world_id = $1
          ORDER BY cell_y, cell_x
        `,
        args: [worldId],
      });
      return res.rows.map((r) => ({
        worldId: r.world_id,
        tileId:  r.tile_id,
        cellX:   r.cell_x,
        cellY:   r.cell_y,
        seed:    r.seed,
        generatedAt: r.generated_at,
      }));
    } finally {
      conn.release();
    }
  }

  async listSummaries(worldId: string = "default"): Promise<AtlasTileSummaryRow[]> {
    const conn = await this.pool.connect();
    try {
      const res = await conn.queryObject<{
        cell_x: number;
        cell_y: number;
        summary: number;
        seed: bigint;
      }>({
        text: `
          SELECT cell_x, cell_y,
                 (payload->>'gateSummary')::int AS summary,
                 seed
          FROM atlas_tile_init
          WHERE world_id = $1
          ORDER BY cell_y, cell_x
        `,
        args: [worldId],
      });
      return res.rows.map((r) => ({
        cellX: r.cell_x,
        cellY: r.cell_y,
        summary: r.summary,
        seed: r.seed,
      }));
    } finally {
      conn.release();
    }
  }

  async put(input: {
    worldId?: string;
    tileId: string;
    cellX: number;
    cellY: number;
    seed: bigint;
    payload: Record<string, unknown>;
  }): Promise<void> {
    const conn = await this.pool.connect();
    try {
      await conn.queryArray({
        text: `
          INSERT INTO atlas_tile_init
            (world_id, tile_id, cell_x, cell_y, seed, payload, generated_at)
          VALUES ($1, $2, $3, $4, $5, $6, now())
          ON CONFLICT (world_id, tile_id) DO UPDATE
            SET cell_x = EXCLUDED.cell_x,
                cell_y = EXCLUDED.cell_y,
                seed   = EXCLUDED.seed,
                payload = EXCLUDED.payload,
                generated_at = now()
        `,
        args: [
          input.worldId ?? "default",
          input.tileId,
          input.cellX,
          input.cellY,
          input.seed,
          JSON.stringify(input.payload),
        ],
      });
    } finally {
      conn.release();
    }
  }

  async delete(tileId: string, worldId: string = "default"): Promise<void> {
    const conn = await this.pool.connect();
    try {
      await conn.queryArray({
        text: "DELETE FROM atlas_tile_init WHERE world_id = $1 AND tile_id = $2",
        args: [worldId, tileId],
      });
    } finally {
      conn.release();
    }
  }

  async deleteAll(worldId: string = "default"): Promise<void> {
    const conn = await this.pool.connect();
    try {
      await conn.queryArray({
        text: "DELETE FROM atlas_tile_init WHERE world_id = $1",
        args: [worldId],
      });
    } finally {
      conn.release();
    }
  }
}
