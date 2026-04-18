/**
 * In-memory session store — maps hashed tokens to userIds with a TTL.
 *
 * Scope: a single gateway process. Sessions do not survive gateway restarts;
 * users re-login. This is acceptable for MVP — the alternative (persistent
 * session storage) only matters when gateway horizontal scaling comes in.
 *
 * The store holds the SHA-256 hash of the token, not the raw value. The
 * raw token lives only in the client's localStorage and in flight on HTTPS.
 * A memory dump of the gateway therefore cannot resurrect client sessions.
 *
 * Expiry is lazy — expired entries are evicted on read, not by a timer. A
 * dormant user's session sits in the map until the next `get` call touches
 * it. With the expected scale (hundreds to thousands of users) this is fine;
 * a sweep task is the upgrade path if the map ever grows unbounded.
 */

import { generateToken, hashToken } from "./auth.ts";

/** Default TTL for new sessions — 7 days, rolling on each successful validate. */
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface Entry {
  userId: string;
  expiresAt: number;
}

export interface IssuedSession {
  /** Raw token — send to the client. Never stored server-side. */
  token: string;
  expiresAt: number;
}

export class SessionStore {
  private map = new Map<string, Entry>();

  constructor(private readonly ttlMs: number = DEFAULT_TTL_MS) {}

  /**
   * Issue a new token for a user. Caller receives the raw token; the store
   * keeps only its SHA-256 hash. Tokens are independent — issuing a new one
   * does not invalidate any existing tokens for the same user.
   */
  async issue(userId: string): Promise<IssuedSession> {
    const token = generateToken();
    const expiresAt = Date.now() + this.ttlMs;
    this.map.set(await hashToken(token), { userId, expiresAt });
    return { token, expiresAt };
  }

  /**
   * Validate a raw token and return the userId it unlocks, or null if the
   * token is unknown or expired. On successful validation the entry's
   * expiry is refreshed (rolling sessions — active users don't get logged
   * out mid-session).
   */
  async validate(token: string): Promise<string | null> {
    const key = await hashToken(token);
    const entry = this.map.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.map.delete(key);
      return null;
    }
    entry.expiresAt = Date.now() + this.ttlMs;
    return entry.userId;
  }

  /** Revoke a single token. Idempotent — removing a missing token is a no-op. */
  async revoke(token: string): Promise<void> {
    this.map.delete(await hashToken(token));
  }

  /** Drop every session for a user. Use on password change / account delete. */
  revokeAllForUser(userId: string): number {
    let n = 0;
    for (const [key, entry] of this.map) {
      if (entry.userId === userId) { this.map.delete(key); n++; }
    }
    return n;
  }

  get size(): number {
    return this.map.size;
  }
}
