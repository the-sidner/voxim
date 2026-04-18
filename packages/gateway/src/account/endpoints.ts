/**
 * HTTP endpoints for the account service — client-facing under `/account/*`
 * and server-to-server under `/internal/*`.
 *
 * Authentication split:
 *   - Client endpoints: `Authorization: Bearer <token>` where token is the
 *     raw value returned by login. Validated against SessionStore.
 *   - Server-to-server endpoints: `X-Voxim-Service-Secret: <shared secret>`
 *     compared constant-time to the configured secret. Used by tile servers
 *     that talk to the account service on behalf of their players.
 *
 * The service secret is required at construction — the gateway refuses to
 * start without it (see server.ts). This prevents shipping a default
 * "insecure" that could leak out of a local-dev config into production.
 */

import type { AccountStore } from "./store.ts";
import type { SessionStore } from "./session_store.ts";
import { hashPassword, verifyPassword } from "./auth.ts";
import { heritageCodec, type HeritageData, type HeritageTrait } from "@voxim/codecs";
import type { UserRecord, SessionInfo } from "./types.ts";

export interface AccountEndpointsDeps {
  store: AccountStore;
  sessions: SessionStore;
  /** Shared secret gating the `/internal/*` endpoints. Must be non-empty. */
  serviceSecret: string;
}

// ---- heritage mutation rules (was in HeritageStore) ----

/** Max accumulated health bonus across traits — prevents late-dynasty characters becoming unkillable. */
const MAX_HEALTH_BONUS = 50;
const HEALTH_BONUS_PER_GEN = 5;

function heritageHealthBonus(h: HeritageData): number {
  return h.traits
    .filter((t) => t.type === "health_bonus")
    .reduce((sum, t) => sum + t.value, 0);
}

/**
 * Apply a death to a heritage record. Returns the new record — caller
 * persists it. Same rule as the former tile-server HeritageStore:
 * generation advances by one, a health_bonus trait is appended up to the
 * accumulation cap.
 */
function advanceHeritageForDeath(current: HeritageData): HeritageData {
  const existing = heritageHealthBonus(current);
  const newTrait: HeritageTrait | null = existing < MAX_HEALTH_BONUS
    ? { type: "health_bonus", value: HEALTH_BONUS_PER_GEN, fromGeneration: current.generation }
    : null;
  return {
    dynastyId: current.dynastyId,
    generation: current.generation + 1,
    traits: newTrait ? [...current.traits, newTrait] : current.traits,
  };
}

// ---- helpers ----

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function textError(message: string, status: number): Response {
  return new Response(message, { status });
}

/** Constant-time string comparison. Throws on surprising input shapes. */
function constantTimeEqualStrings(a: string, b: string): boolean {
  const aBytes = new TextEncoder().encode(a);
  const bBytes = new TextEncoder().encode(b);
  if (aBytes.length !== bBytes.length) return false;
  let diff = 0;
  for (let i = 0; i < aBytes.length; i++) diff |= aBytes[i] ^ bBytes[i];
  return diff === 0;
}

function extractBearerToken(req: Request): string | null {
  const header = req.headers.get("authorization");
  if (!header || !header.startsWith("Bearer ")) return null;
  return header.slice(7).trim() || null;
}

function userPublicProjection(u: UserRecord) {
  // Password hash must never leave the server.
  return {
    userId: u.userId,
    loginName: u.loginName,
    createdAt: u.createdAt,
    lastLoginAt: u.lastLoginAt,
    activeDynastyId: u.activeDynastyId,
    lastTileId: u.lastTileId,
    settings: u.settings,
  };
}

// ---- endpoints class ----

export class AccountEndpoints {
  constructor(private readonly deps: AccountEndpointsDeps) {
    if (!deps.serviceSecret || deps.serviceSecret.length < 16) {
      throw new Error("AccountEndpoints: serviceSecret must be set and at least 16 chars");
    }
  }

  /**
   * Dispatch an HTTP request. Returns null if the path doesn't match any
   * account endpoint — caller should fall through to other handlers.
   */
  async handle(req: Request, url: URL): Promise<Response | null> {
    const p = url.pathname;

    // ---- client-facing ----
    if (req.method === "POST" && p === "/account/register")   return this.register(req);
    if (req.method === "POST" && p === "/account/login")      return this.login(req);
    if (req.method === "POST" && p === "/account/logout")     return this.logout(req);
    if (req.method === "GET"  && p === "/account/me")         return this.me(req);
    if (req.method === "PATCH" && p === "/account/me/settings") return this.patchSettings(req);

    // ---- server-to-server ----
    if (p.startsWith("/internal/")) {
      if (!this.verifyServiceSecret(req)) return textError("unauthorized", 401);

      const sessionMatch = p.match(/^\/internal\/session\/(.+)$/);
      if (req.method === "GET" && sessionMatch) {
        return this.internalSession(sessionMatch[1]);
      }

      const userMatch = p.match(/^\/internal\/user\/([^\/]+)(\/.*)?$/);
      if (userMatch) {
        const userId = userMatch[1];
        const sub = userMatch[2] ?? "";
        if (req.method === "GET"  && sub === "/heritage") return this.internalGetHeritage(userId);
        if (req.method === "POST" && sub === "/death")    return this.internalDeath(userId, req);
        if (req.method === "PATCH" && sub === "/location") return this.internalLocation(userId, req);
        if (req.method === "PATCH" && sub === "/hearth")   return this.internalSetHearth(userId, req);
      }

      return textError("not found", 404);
    }

    return null;
  }

  private verifyServiceSecret(req: Request): boolean {
    const header = req.headers.get("x-voxim-service-secret") ?? "";
    return constantTimeEqualStrings(header, this.deps.serviceSecret);
  }

  /** Returns the authenticated userId, or null on invalid/missing auth. */
  private async authUser(req: Request): Promise<string | null> {
    const token = extractBearerToken(req);
    if (!token) return null;
    return await this.deps.sessions.validate(token);
  }

  // ---- client endpoints ----

  private async register(req: Request): Promise<Response> {
    let body: { loginName?: string; password?: string };
    try { body = await req.json(); } catch { return textError("bad request", 400); }
    const loginName = body.loginName?.trim();
    const password = body.password;
    if (!loginName || !password) return textError("loginName and password required", 400);
    if (password.length < 6) return textError("password must be at least 6 characters", 400);

    const existing = await this.deps.store.getUserByLogin(loginName);
    if (existing) return json({ error: "loginName taken" }, 409);

    const passwordHash = await hashPassword(password);
    const user = await this.deps.store.createUser(loginName, passwordHash);
    const session = await this.deps.sessions.issue(user.userId);

    return json({ userId: user.userId, token: session.token, activeDynastyId: user.activeDynastyId }, 201);
  }

  private async login(req: Request): Promise<Response> {
    let body: { loginName?: string; password?: string };
    try { body = await req.json(); } catch { return textError("bad request", 400); }
    const { loginName, password } = body;
    if (!loginName || !password) return textError("loginName and password required", 400);

    const user = await this.deps.store.getUserByLogin(loginName);
    if (!user) return json({ error: "invalid credentials" }, 401);
    const ok = await verifyPassword(password, user.passwordHash);
    if (!ok) return json({ error: "invalid credentials" }, 401);

    await this.deps.store.updateUser(user.userId, { lastLoginAt: Date.now() });
    const session = await this.deps.sessions.issue(user.userId);

    return json({
      userId: user.userId,
      token: session.token,
      activeDynastyId: user.activeDynastyId,
      lastTileId: user.lastTileId,
    });
  }

  private async logout(req: Request): Promise<Response> {
    const token = extractBearerToken(req);
    if (token) await this.deps.sessions.revoke(token);
    // Idempotent — even a bogus token gets a 204, so logout never leaks
    // whether a token was valid.
    return new Response(null, { status: 204 });
  }

  private async me(req: Request): Promise<Response> {
    const userId = await this.authUser(req);
    if (!userId) return textError("unauthorized", 401);
    const user = await this.deps.store.getUserById(userId);
    if (!user) return textError("user not found", 404);
    return json(userPublicProjection(user));
  }

  private async patchSettings(req: Request): Promise<Response> {
    const userId = await this.authUser(req);
    if (!userId) return textError("unauthorized", 401);
    let settings: Record<string, unknown>;
    try { settings = await req.json(); } catch { return textError("bad request", 400); }
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
      return textError("settings must be an object", 400);
    }
    const updated = await this.deps.store.updateUser(userId, { settings });
    if (!updated) return textError("user not found", 404);
    return new Response(null, { status: 204 });
  }

  // ---- server-to-server endpoints ----

  private async internalSession(token: string): Promise<Response> {
    const userId = await this.deps.sessions.validate(token);
    if (!userId) return textError("unauthenticated", 401);
    const user = await this.deps.store.getUserById(userId);
    if (!user) return textError("user not found", 404);
    const info: SessionInfo = {
      userId: user.userId,
      activeDynastyId: user.activeDynastyId,
      lastTileId: user.lastTileId,
      hearthAnchor: user.hearthAnchor,
    };
    return json(info);
  }

  private async internalGetHeritage(userId: string): Promise<Response> {
    const heritage = await this.deps.store.getHeritage(userId);
    if (!heritage) return textError("heritage not found", 404);
    // Binary payload using the shared heritageCodec — consumer (tile server)
    // decodes with the same codec. No JSON intermediary.
    const bytes = heritageCodec.encode(heritage);
    // Copy into a plain ArrayBuffer so the Response body is unambiguously
    // typed regardless of the underlying Uint8Array backing.
    const body = new Uint8Array(bytes.length);
    body.set(bytes);
    return new Response(body, {
      status: 200,
      headers: { "content-type": "application/octet-stream" },
    });
  }

  private async internalDeath(userId: string, _req: Request): Promise<Response> {
    // Body fields (killerId, cause) are accepted but currently informational —
    // reserved for future lore generation. We read the current heritage,
    // advance it, and write it back atomically.
    const current = await this.deps.store.getHeritage(userId);
    if (!current) return textError("heritage not found", 404);
    const next = advanceHeritageForDeath(current);
    await this.deps.store.putHeritage(userId, next);
    console.log(`[Account] recorded death for user ${userId} → gen ${next.generation}`);
    return new Response(null, { status: 204 });
  }

  private async internalLocation(userId: string, req: Request): Promise<Response> {
    let body: { lastTileId?: string };
    try { body = await req.json(); } catch { return textError("bad request", 400); }
    if (typeof body.lastTileId !== "string") return textError("lastTileId required", 400);
    const updated = await this.deps.store.updateUser(userId, { lastTileId: body.lastTileId });
    if (!updated) return textError("user not found", 404);
    return new Response(null, { status: 204 });
  }

  private async internalSetHearth(userId: string, req: Request): Promise<Response> {
    let body: { tileId?: string; position?: { x?: number; y?: number; z?: number } | null };
    try { body = await req.json(); } catch { return textError("bad request", 400); }
    // Null body clears the anchor (e.g. on hearth destruction).
    if (body.tileId === null || body.position === null) {
      const updated = await this.deps.store.updateUser(userId, { hearthAnchor: null });
      if (!updated) return textError("user not found", 404);
      return new Response(null, { status: 204 });
    }
    if (typeof body.tileId !== "string" || !body.position
      || typeof body.position.x !== "number"
      || typeof body.position.y !== "number"
      || typeof body.position.z !== "number") {
      return textError("tileId and position {x,y,z} required", 400);
    }
    const updated = await this.deps.store.updateUser(userId, {
      hearthAnchor: { tileId: body.tileId, position: { x: body.position.x, y: body.position.y, z: body.position.z } },
    });
    if (!updated) return textError("user not found", 404);
    console.log(`[Account] hearth anchor set for user ${userId} on tile ${body.tileId}`);
    return new Response(null, { status: 204 });
  }
}
