// Forward-only SQL migrator.
//
// - Reads packages/db/migrations/*.sql in numeric (alpha) order.
// - Tracks applied versions in `_migrations` (filename, applied_at).
// - Applies pending migrations inside a single transaction per file.
// - No down-migrations. For breaking schema changes during dev, wipe the
//   Postgres volume: `docker compose down -v`.
//
// Run from the host: `deno task migrate` (DATABASE_URL must point at a
// reachable Postgres). Reachable in dev as postgres://voxim:...@localhost:5432/voxim.

import { createPool } from "./src/client.ts";

const migrationsDir = new URL("./migrations/", import.meta.url);

async function listMigrationFiles(): Promise<string[]> {
  const names: string[] = [];
  for await (const entry of Deno.readDir(migrationsDir)) {
    if (entry.isFile && entry.name.endsWith(".sql")) names.push(entry.name);
  }
  names.sort();
  return names;
}

async function readMigration(name: string): Promise<string> {
  return await Deno.readTextFile(new URL(name, migrationsDir));
}

async function ensureMigrationsTable(pool: ReturnType<typeof createPool>): Promise<void> {
  const conn = await pool.connect();
  try {
    await conn.queryArray(`
      CREATE TABLE IF NOT EXISTS _migrations (
        filename    text primary key,
        applied_at  timestamptz not null default now()
      )
    `);
  } finally {
    conn.release();
  }
}

async function appliedSet(pool: ReturnType<typeof createPool>): Promise<Set<string>> {
  const conn = await pool.connect();
  try {
    const result = await conn.queryArray<[string]>("SELECT filename FROM _migrations");
    return new Set(result.rows.map((r) => r[0]));
  } finally {
    conn.release();
  }
}

async function applyMigration(
  pool: ReturnType<typeof createPool>,
  filename: string,
  sql: string,
): Promise<void> {
  const conn = await pool.connect();
  try {
    await conn.queryArray("BEGIN");
    try {
      await conn.queryArray(sql);
      await conn.queryArray(
        "INSERT INTO _migrations (filename) VALUES ($1)",
        [filename],
      );
      await conn.queryArray("COMMIT");
    } catch (err) {
      await conn.queryArray("ROLLBACK");
      throw err;
    }
  } finally {
    conn.release();
  }
}

async function main() {
  const pool = createPool({ size: 2, lazy: false });
  try {
    await ensureMigrationsTable(pool);
    const applied = await appliedSet(pool);
    const files = await listMigrationFiles();

    const pending = files.filter((f) => !applied.has(f));
    if (pending.length === 0) {
      console.log(`[migrate] up to date (${files.length} applied)`);
      return;
    }

    for (const filename of pending) {
      const sql = await readMigration(filename);
      console.log(`[migrate] applying ${filename}`);
      await applyMigration(pool, filename, sql);
    }
    console.log(`[migrate] applied ${pending.length} migration(s)`);
  } finally {
    await pool.end();
  }
}

if (import.meta.main) {
  await main();
}
