import { Pool } from "postgres";

export type DbPool = Pool;

export interface CreatePoolOptions {
  databaseUrl?: string;
  size?: number;
  lazy?: boolean;
}

export function createPool(opts: CreatePoolOptions = {}): DbPool {
  const url = opts.databaseUrl ?? Deno.env.get("DATABASE_URL");
  if (!url) {
    throw new Error("DATABASE_URL not set and no databaseUrl passed to createPool()");
  }
  return new Pool(url, opts.size ?? 10, opts.lazy ?? true);
}
