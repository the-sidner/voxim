/**
 * Session token lifecycle: issue, validate (rolling expiry), revoke.
 *
 * Storage is a Postgres-backed `SessionRepo` (only the SHA-256 of the token
 * leaves this layer; the raw token lives only on the client). Validate is
 * lazy — expired rows aren't pruned until a sweep job runs.
 *
 * This sits between `AccountEndpoints` and the repo so the endpoints don't
 * need to know about hashing or rolling-expiry semantics.
 */

import type { SessionRepo } from "@voxim/db";
import { generateToken, hashToken } from "./auth.ts";

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export interface IssuedSession {
  /** Raw token — send to the client, never persisted server-side. */
  token: string;
  expiresAt: number;
}

export class SessionService {
  constructor(
    private readonly repo: SessionRepo,
    private readonly ttlMs: number = DEFAULT_TTL_MS,
  ) {}

  async issue(userId: string): Promise<IssuedSession> {
    const token = generateToken();
    const tokenHash = await hashToken(token);
    const expiresAt = new Date(Date.now() + this.ttlMs);
    await this.repo.insert({ tokenHash, userId, expiresAt });
    return { token, expiresAt: expiresAt.getTime() };
  }

  async validate(token: string): Promise<string | null> {
    const tokenHash = await hashToken(token);
    const row = await this.repo.getByTokenHash(tokenHash);
    if (!row) return null;
    if (row.expiresAt.getTime() <= Date.now()) {
      await this.repo.delete(tokenHash);
      return null;
    }
    // Rolling expiry: bump the deadline so active users don't get logged
    // out mid-session. Costs one update per validated request.
    const next = new Date(Date.now() + this.ttlMs);
    await this.repo.extend(tokenHash, next);
    return row.userId;
  }

  async revoke(token: string): Promise<void> {
    const tokenHash = await hashToken(token);
    await this.repo.delete(tokenHash);
  }

  async revokeAllForUser(userId: string): Promise<number> {
    return await this.repo.deleteAllForUser(userId);
  }

  async sweepExpired(): Promise<number> {
    return await this.repo.deleteExpired(new Date());
  }
}
