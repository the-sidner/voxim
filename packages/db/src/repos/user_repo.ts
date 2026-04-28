import type { DbPool } from "../client.ts";

export interface UserRow {
  userId: string;
  loginName: string;
  passwordHash: string;
  createdAt: Date;
  lastLoginAt: Date | null;
  activeDynastyId: string;
  lastTileId: string | null;
  hearthAnchor: HearthAnchor | null;
  settings: Record<string, unknown>;
}

export interface HearthAnchor {
  tileId: string;
  position: { x: number; y: number; z: number };
}

export interface UserRepo {
  create(input: {
    userId: string;
    loginName: string;
    passwordHash: string;
    activeDynastyId: string;
  }): Promise<UserRow>;
  getById(userId: string): Promise<UserRow | null>;
  getByLogin(loginName: string): Promise<UserRow | null>;
  updateLastLogin(userId: string, at: Date): Promise<void>;
  updateLocation(userId: string, lastTileId: string): Promise<void>;
  updateHearth(userId: string, anchor: HearthAnchor | null): Promise<void>;
  updateSettings(userId: string, settings: Record<string, unknown>): Promise<void>;
  setActiveDynastyId(userId: string, dynastyId: string): Promise<void>;
}

export class PgUserRepo implements UserRepo {
  constructor(private readonly pool: DbPool) {}

  async create(input: {
    userId: string;
    loginName: string;
    passwordHash: string;
    activeDynastyId: string;
  }): Promise<UserRow> {
    const conn = await this.pool.connect();
    try {
      const res = await conn.queryObject<RawUserRow>({
        text: `
          INSERT INTO users (user_id, login_name, password_hash, active_dynasty_id)
          VALUES ($1, $2, $3, $4)
          RETURNING *
        `,
        args: [input.userId, input.loginName, input.passwordHash, input.activeDynastyId],
      });
      return mapUser(res.rows[0]);
    } finally {
      conn.release();
    }
  }

  async getById(userId: string): Promise<UserRow | null> {
    const conn = await this.pool.connect();
    try {
      const res = await conn.queryObject<RawUserRow>({
        text: "SELECT * FROM users WHERE user_id = $1",
        args: [userId],
      });
      return res.rows[0] ? mapUser(res.rows[0]) : null;
    } finally {
      conn.release();
    }
  }

  async getByLogin(loginName: string): Promise<UserRow | null> {
    const conn = await this.pool.connect();
    try {
      const res = await conn.queryObject<RawUserRow>({
        text: "SELECT * FROM users WHERE login_name = $1",
        args: [loginName],
      });
      return res.rows[0] ? mapUser(res.rows[0]) : null;
    } finally {
      conn.release();
    }
  }

  async updateLastLogin(userId: string, at: Date): Promise<void> {
    const conn = await this.pool.connect();
    try {
      await conn.queryArray({
        text: "UPDATE users SET last_login_at = $2 WHERE user_id = $1",
        args: [userId, at],
      });
    } finally {
      conn.release();
    }
  }

  async updateLocation(userId: string, lastTileId: string): Promise<void> {
    const conn = await this.pool.connect();
    try {
      await conn.queryArray({
        text: "UPDATE users SET last_tile_id = $2 WHERE user_id = $1",
        args: [userId, lastTileId],
      });
    } finally {
      conn.release();
    }
  }

  async updateHearth(userId: string, anchor: HearthAnchor | null): Promise<void> {
    const conn = await this.pool.connect();
    try {
      await conn.queryArray({
        text: "UPDATE users SET hearth_anchor = $2 WHERE user_id = $1",
        args: [userId, anchor],
      });
    } finally {
      conn.release();
    }
  }

  async updateSettings(userId: string, settings: Record<string, unknown>): Promise<void> {
    const conn = await this.pool.connect();
    try {
      await conn.queryArray({
        text: "UPDATE users SET settings = $2 WHERE user_id = $1",
        args: [userId, settings],
      });
    } finally {
      conn.release();
    }
  }

  async setActiveDynastyId(userId: string, dynastyId: string): Promise<void> {
    const conn = await this.pool.connect();
    try {
      await conn.queryArray({
        text: "UPDATE users SET active_dynasty_id = $2 WHERE user_id = $1",
        args: [userId, dynastyId],
      });
    } finally {
      conn.release();
    }
  }
}

interface RawUserRow {
  user_id: string;
  login_name: string;
  password_hash: string;
  created_at: Date;
  last_login_at: Date | null;
  active_dynasty_id: string;
  last_tile_id: string | null;
  hearth_anchor: HearthAnchor | null;
  settings: Record<string, unknown>;
}

function mapUser(r: RawUserRow): UserRow {
  return {
    userId: r.user_id,
    loginName: r.login_name,
    passwordHash: r.password_hash,
    createdAt: r.created_at,
    lastLoginAt: r.last_login_at,
    activeDynastyId: r.active_dynasty_id,
    lastTileId: r.last_tile_id,
    hearthAnchor: r.hearth_anchor,
    settings: r.settings ?? {},
  };
}
