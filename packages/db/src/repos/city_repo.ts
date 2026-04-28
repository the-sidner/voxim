import type { DbPool } from "../client.ts";

export interface CityRow {
  cityId: string;
  name: string;
  tileId: string;
  state: Record<string, unknown>;
  eventLog: unknown[];
  updatedAt: Date;
}

export interface CityRepo {
  create(input: {
    cityId: string;
    name: string;
    tileId: string;
    state: Record<string, unknown>;
  }): Promise<CityRow>;
  get(cityId: string): Promise<CityRow | null>;
  list(): Promise<CityRow[]>;
  listForTile(tileId: string): Promise<CityRow[]>;
  updateState(cityId: string, state: Record<string, unknown>): Promise<void>;
  appendEvent(cityId: string, event: unknown, maxLog: number): Promise<void>;
}

export class PgCityRepo implements CityRepo {
  constructor(private readonly pool: DbPool) {}

  async create(input: {
    cityId: string;
    name: string;
    tileId: string;
    state: Record<string, unknown>;
  }): Promise<CityRow> {
    const conn = await this.pool.connect();
    try {
      const res = await conn.queryObject<RawCityRow>({
        text: `
          INSERT INTO cities (city_id, name, tile_id, state)
          VALUES ($1, $2, $3, $4)
          RETURNING *
        `,
        args: [input.cityId, input.name, input.tileId, input.state],
      });
      return mapCity(res.rows[0]);
    } finally {
      conn.release();
    }
  }

  async get(cityId: string): Promise<CityRow | null> {
    const conn = await this.pool.connect();
    try {
      const res = await conn.queryObject<RawCityRow>({
        text: "SELECT * FROM cities WHERE city_id = $1",
        args: [cityId],
      });
      return res.rows[0] ? mapCity(res.rows[0]) : null;
    } finally {
      conn.release();
    }
  }

  async list(): Promise<CityRow[]> {
    const conn = await this.pool.connect();
    try {
      const res = await conn.queryObject<RawCityRow>({
        text: "SELECT * FROM cities ORDER BY name",
      });
      return res.rows.map(mapCity);
    } finally {
      conn.release();
    }
  }

  async listForTile(tileId: string): Promise<CityRow[]> {
    const conn = await this.pool.connect();
    try {
      const res = await conn.queryObject<RawCityRow>({
        text: "SELECT * FROM cities WHERE tile_id = $1",
        args: [tileId],
      });
      return res.rows.map(mapCity);
    } finally {
      conn.release();
    }
  }

  async updateState(cityId: string, state: Record<string, unknown>): Promise<void> {
    const conn = await this.pool.connect();
    try {
      await conn.queryArray({
        text: "UPDATE cities SET state = $2, updated_at = now() WHERE city_id = $1",
        args: [cityId, state],
      });
    } finally {
      conn.release();
    }
  }

  async appendEvent(cityId: string, event: unknown, maxLog: number): Promise<void> {
    // Append, then trim to last `maxLog` entries. Done in one statement so we
    // don't need to read-modify-write from the application.
    const conn = await this.pool.connect();
    try {
      await conn.queryArray({
        text: `
          UPDATE cities
          SET event_log = (
            SELECT jsonb_agg(elem)
            FROM (
              SELECT elem FROM jsonb_array_elements(event_log || jsonb_build_array($2::jsonb)) WITH ORDINALITY AS t(elem, idx)
              ORDER BY idx DESC
              LIMIT $3
            ) recent
            ORDER BY 1
          ),
          updated_at = now()
          WHERE city_id = $1
        `,
        args: [cityId, event, maxLog],
      });
    } finally {
      conn.release();
    }
  }
}

interface RawCityRow {
  city_id: string;
  name: string;
  tile_id: string;
  state: Record<string, unknown>;
  event_log: unknown[];
  updated_at: Date;
}

function mapCity(r: RawCityRow): CityRow {
  return {
    cityId: r.city_id,
    name: r.name,
    tileId: r.tile_id,
    state: r.state ?? {},
    eventLog: r.event_log ?? [],
    updatedAt: r.updated_at,
  };
}
