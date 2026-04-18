/**
 * AccountStore — on-disk user records + binary heritage payloads.
 *
 * File layout (same directory, single flat level for MVP):
 *
 *   users/
 *     _index_by_login.json            Map<loginName, userId>
 *     {userId}.json                   UserRecord (see types.ts)
 *     {userId}.heritage.bin           heritageCodec payload wrapped in a
 *                                     magic+version header
 *
 * Write discipline:
 *   - Every file write goes through `atomicWrite()` (write-to-tmp, fsync
 *     implicit via Deno.writeFile, rename). A crash leaves the previous
 *     version intact.
 *   - JSON and binary writes are *independent* — no field is duplicated
 *     across them, so cross-file atomicity is not needed. A crash between
 *     the two loses one of two independent updates, not a torn composite.
 *
 * The store is oblivious to password hashing (auth.ts owns that). The
 * caller passes the already-hashed string in.
 */

import { WireWriter, WireReader, heritageCodec } from "@voxim/codecs";
import type { HeritageData } from "@voxim/codecs";
import type { UserRecord } from "./types.ts";

const HERITAGE_MAGIC   = 0x56585548; // "VXUH" — Voxim user heritage
const HERITAGE_VERSION = 1;

/**
 * Atomic file write: stage to a sibling `.tmp`, then rename. POSIX rename
 * is atomic within a filesystem; a crash leaves either the old file or the
 * new one, never a torn write.
 */
async function atomicWrite(path: string, bytes: Uint8Array): Promise<void> {
  const tmp = `${path}.tmp`;
  await Deno.writeFile(tmp, bytes);
  await Deno.rename(tmp, path);
}

async function tryReadFile(path: string): Promise<Uint8Array | null> {
  try {
    return await Deno.readFile(path);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return null;
    throw err;
  }
}

async function ensureDir(path: string): Promise<void> {
  await Deno.mkdir(path, { recursive: true });
}

// ---- heritage file header ----

function encodeHeritageFile(data: HeritageData): Uint8Array {
  const payload = heritageCodec.encode(data);
  const w = new WireWriter();
  w.writeU32(HERITAGE_MAGIC);
  w.writeU32(HERITAGE_VERSION);
  w.writeF64(Date.now());
  w.writeU16(payload.byteLength);
  w.writeBytes(payload);
  return w.toBytes();
}

function decodeHeritageFile(bytes: Uint8Array): HeritageData | null {
  const r = new WireReader(bytes);
  const magic = r.readU32();
  if (magic !== HERITAGE_MAGIC) return null;
  const version = r.readU32();
  if (version !== HERITAGE_VERSION) return null;
  r.readF64(); // savedAt — informational only
  const payloadLen = r.readU16();
  const payload = r.readBytes(payloadLen);
  return heritageCodec.decode(payload);
}

// ---- store ----

export class AccountStore {
  /** loginName → userId. Rebuilt lazily from disk scan when missing. */
  private loginIndex = new Map<string, string>();
  private indexLoaded = false;

  constructor(private readonly rootDir: string) {}

  async init(): Promise<void> {
    await ensureDir(this.rootDir);
    await this.loadIndex();
  }

  // ---- internal: login index ----

  private indexPath(): string {
    return `${this.rootDir}/_index_by_login.json`;
  }

  private async loadIndex(): Promise<void> {
    if (this.indexLoaded) return;
    const bytes = await tryReadFile(this.indexPath());
    if (bytes) {
      const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, string>;
      this.loginIndex = new Map(Object.entries(parsed));
    } else {
      // Index missing — rebuild by scanning the directory.
      this.loginIndex = await this.rebuildIndex();
      await this.persistIndex();
    }
    this.indexLoaded = true;
  }

  private async rebuildIndex(): Promise<Map<string, string>> {
    const idx = new Map<string, string>();
    for await (const entry of Deno.readDir(this.rootDir)) {
      if (!entry.isFile || !entry.name.endsWith(".json")) continue;
      if (entry.name.startsWith("_")) continue; // skip index/control files
      const bytes = await tryReadFile(`${this.rootDir}/${entry.name}`);
      if (!bytes) continue;
      try {
        const rec = JSON.parse(new TextDecoder().decode(bytes)) as UserRecord;
        if (rec.loginName && rec.userId) idx.set(rec.loginName, rec.userId);
      } catch {
        console.warn(`[AccountStore] skipping unreadable user file: ${entry.name}`);
      }
    }
    return idx;
  }

  private async persistIndex(): Promise<void> {
    const obj = Object.fromEntries(this.loginIndex);
    const bytes = new TextEncoder().encode(JSON.stringify(obj, null, 2));
    await atomicWrite(this.indexPath(), bytes);
  }

  // ---- user records ----

  private userPath(userId: string): string {
    return `${this.rootDir}/${userId}.json`;
  }

  private heritagePath(userId: string): string {
    return `${this.rootDir}/${userId}.heritage.bin`;
  }

  /**
   * Create a new user. Initial heritage (empty dynasty, generation 0) is
   * written as a separate binary file. Caller is responsible for passing
   * an already-hashed password.
   *
   * Throws on loginName collision — caller should pre-check via
   * `getUserByLogin` or inspect the thrown error.
   */
  async createUser(loginName: string, passwordHash: string): Promise<UserRecord> {
    await this.loadIndex();
    if (this.loginIndex.has(loginName)) {
      throw new Error(`loginName "${loginName}" is already taken`);
    }

    const userId = crypto.randomUUID();
    const dynastyId = crypto.randomUUID();
    const now = Date.now();

    const record: UserRecord = {
      userId,
      loginName,
      passwordHash,
      createdAt: now,
      lastLoginAt: now,
      activeDynastyId: dynastyId,
      lastTileId: null,
      hearthAnchor: null,
      settings: {},
    };

    await this.writeUser(record);
    await this.putHeritage(userId, { dynastyId, generation: 0, traits: [] });

    this.loginIndex.set(loginName, userId);
    await this.persistIndex();

    return record;
  }

  private async writeUser(record: UserRecord): Promise<void> {
    const bytes = new TextEncoder().encode(JSON.stringify(record, null, 2));
    await atomicWrite(this.userPath(record.userId), bytes);
  }

  async getUserById(userId: string): Promise<UserRecord | null> {
    const bytes = await tryReadFile(this.userPath(userId));
    if (!bytes) return null;
    return JSON.parse(new TextDecoder().decode(bytes)) as UserRecord;
  }

  async getUserByLogin(loginName: string): Promise<UserRecord | null> {
    await this.loadIndex();
    const userId = this.loginIndex.get(loginName);
    if (!userId) return null;
    return this.getUserById(userId);
  }

  /**
   * Patch a subset of mutable user fields. Read-modify-write under the hood,
   * so not safe for truly concurrent writes to the same user — accounts are
   * effectively single-writer (one logged-in session per user at a time), so
   * this is acceptable for MVP. A future queue or per-user lock is the
   * upgrade path if we ever parallelise login state changes.
   */
  async updateUser(
    userId: string,
    patch: Partial<Omit<UserRecord, "userId" | "loginName" | "createdAt">>,
  ): Promise<UserRecord | null> {
    const current = await this.getUserById(userId);
    if (!current) return null;
    const next: UserRecord = {
      ...current,
      ...patch,
      // Deep-merge settings rather than replacing, so a client PATCH with
      // { settings: { audio: { volume: 0.5 } } } doesn't wipe other keys.
      settings: patch.settings ? { ...current.settings, ...patch.settings } : current.settings,
    };
    await this.writeUser(next);
    return next;
  }

  // ---- heritage ----

  async getHeritage(userId: string): Promise<HeritageData | null> {
    const bytes = await tryReadFile(this.heritagePath(userId));
    if (!bytes) return null;
    return decodeHeritageFile(bytes);
  }

  async putHeritage(userId: string, data: HeritageData): Promise<void> {
    await atomicWrite(this.heritagePath(userId), encodeHeritageFile(data));
  }
}
