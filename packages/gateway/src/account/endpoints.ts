/**
 * HTTP endpoints for the account service — client-facing under `/account/*`
 * and server-to-server under `/internal/*`.
 *
 * Authentication split:
 *   - Client endpoints: `Authorization: Bearer <token>` where token is the
 *     raw value returned by login. Validated via SessionService.
 *   - Server-to-server endpoints: `X-Voxim-Service-Secret: <shared secret>`
 *     compared constant-time to the configured secret. Used by tile servers
 *     that talk to the account service on behalf of their players.
 *
 * Persistence: Postgres via repository interfaces from `@voxim/db`. The
 * endpoints never see SQL.
 */

import type { UserRepo, HeritageRepo, UserRow, HearthAnchor, UserTileFogRepo } from "@voxim/db";
import type { SessionService } from "./session_service.ts";
import { hashPassword, verifyPassword } from "./auth.ts";
import { heritageCodec, type HeritageData, type HeritageTrait } from "@voxim/codecs";
import { verifyServiceSecret } from "@voxim/protocol";
import type { SessionInfo } from "./types.ts";

export interface AccountEndpointsDeps {
  users: UserRepo;
  heritage: HeritageRepo;
  /** Per-(user, tile) fog-of-war bitmaps (T-161). */
  userFog: UserTileFogRepo;
  sessions: SessionService;
  /** Shared secret gating the `/internal/*` endpoints. Must be non-empty. */
  serviceSecret: string;
}

// ---- heritage mutation rules ----

const MAX_HEALTH_BONUS = 50;
const HEALTH_BONUS_PER_GEN = 5;

function heritageHealthBonus(h: HeritageData): number {
  return h.traits
    .filter((t) => t.type === "health_bonus")
    .reduce((sum, t) => sum + t.value, 0);
}

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

function extractBearerToken(req: Request): string | null {
  const header = req.headers.get("authorization");
  if (!header || !header.startsWith("Bearer ")) return null;
  return header.slice(7).trim() || null;
}

function userPublicProjection(u: UserRow) {
  return {
    userId: u.userId,
    loginName: u.loginName,
    createdAt: u.createdAt.getTime(),
    lastLoginAt: u.lastLoginAt?.getTime() ?? null,
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

  async handle(req: Request, url: URL): Promise<Response | null> {
    const p = url.pathname;

    // ---- client-facing ----
    if (req.method === "POST" && p === "/account/register")     return this.register(req);
    if (req.method === "POST" && p === "/account/login")        return this.login(req);
    if (req.method === "POST" && p === "/account/logout")       return this.logout(req);
    if (req.method === "GET"  && p === "/account/me")           return this.me(req);
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
        if (req.method === "GET"   && sub === "/heritage") return this.internalGetHeritage(userId);
        if (req.method === "POST"  && sub === "/death")    return this.internalDeath(userId, req);
        if (req.method === "PATCH" && sub === "/location") return this.internalLocation(userId, req);
        if (req.method === "PATCH" && sub === "/hearth")   return this.internalSetHearth(userId, req);
        // Fog of war (T-161): `/internal/user/:id/fog/:tileId`
        const fogMatch = sub.match(/^\/fog\/(.+)$/);
        if (fogMatch) {
          const tileId = decodeURIComponent(fogMatch[1]);
          if (req.method === "GET") return this.internalGetFog(userId, tileId);
          if (req.method === "PUT") return this.internalPutFog(userId, tileId, req);
        }
      }

      return textError("not found", 404);
    }

    return null;
  }

  private verifyServiceSecret(req: Request): boolean {
    return verifyServiceSecret(req, this.deps.serviceSecret);
  }

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

    const existing = await this.deps.users.getByLogin(loginName);
    if (existing) return json({ error: "loginName taken" }, 409);

    const passwordHash = await hashPassword(password);
    const userId = crypto.randomUUID();
    const dynastyId = crypto.randomUUID();
    const user = await this.deps.users.create({
      userId,
      loginName,
      passwordHash,
      activeDynastyId: dynastyId,
    });
    // Initial heritage: empty dynasty, generation 0.
    const initial: HeritageData = { dynastyId, generation: 0, traits: [] };
    await this.deps.heritage.put(userId, heritageCodec.encode(initial));

    const session = await this.deps.sessions.issue(user.userId);
    return json({
      userId: user.userId,
      token: session.token,
      activeDynastyId: user.activeDynastyId,
    }, 201);
  }

  private async login(req: Request): Promise<Response> {
    let body: { loginName?: string; password?: string };
    try { body = await req.json(); } catch { return textError("bad request", 400); }
    const { loginName, password } = body;
    if (!loginName || !password) return textError("loginName and password required", 400);

    const user = await this.deps.users.getByLogin(loginName);
    if (!user) return json({ error: "invalid credentials" }, 401);
    const ok = await verifyPassword(password, user.passwordHash);
    if (!ok) return json({ error: "invalid credentials" }, 401);

    await this.deps.users.updateLastLogin(user.userId, new Date());
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
    return new Response(null, { status: 204 });
  }

  private async me(req: Request): Promise<Response> {
    const userId = await this.authUser(req);
    if (!userId) return textError("unauthorized", 401);
    const user = await this.deps.users.getById(userId);
    if (!user) return textError("user not found", 404);
    return json(userPublicProjection(user));
  }

  private async patchSettings(req: Request): Promise<Response> {
    const userId = await this.authUser(req);
    if (!userId) return textError("unauthorized", 401);
    let patch: Record<string, unknown>;
    try { patch = await req.json(); } catch { return textError("bad request", 400); }
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
      return textError("settings must be an object", 400);
    }
    const current = await this.deps.users.getById(userId);
    if (!current) return textError("user not found", 404);
    // Deep-merge so a PATCH with a single nested key doesn't wipe the rest.
    const merged = { ...current.settings, ...patch };
    await this.deps.users.updateSettings(userId, merged);
    return new Response(null, { status: 204 });
  }

  // ---- server-to-server endpoints ----

  private async internalSession(token: string): Promise<Response> {
    const userId = await this.deps.sessions.validate(token);
    if (!userId) return textError("unauthenticated", 401);
    const user = await this.deps.users.getById(userId);
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
    const row = await this.deps.heritage.get(userId);
    if (!row) return textError("heritage not found", 404);
    // Stored payload is already heritageCodec.encode() — return as-is.
    const body = new Uint8Array(row.payload.length);
    body.set(row.payload);
    return new Response(body, {
      status: 200,
      headers: { "content-type": "application/octet-stream" },
    });
  }

  private async internalDeath(userId: string, _req: Request): Promise<Response> {
    const row = await this.deps.heritage.get(userId);
    if (!row) return textError("heritage not found", 404);
    const current = heritageCodec.decode(row.payload);
    const next = advanceHeritageForDeath(current);
    await this.deps.heritage.put(userId, heritageCodec.encode(next));
    console.log(`[Account] recorded death for user ${userId} → gen ${next.generation}`);
    return new Response(null, { status: 204 });
  }

  private async internalLocation(userId: string, req: Request): Promise<Response> {
    let body: { lastTileId?: string };
    try { body = await req.json(); } catch { return textError("bad request", 400); }
    if (typeof body.lastTileId !== "string") return textError("lastTileId required", 400);
    const user = await this.deps.users.getById(userId);
    if (!user) return textError("user not found", 404);
    await this.deps.users.updateLocation(userId, body.lastTileId);
    return new Response(null, { status: 204 });
  }

  private async internalGetFog(userId: string, tileId: string): Promise<Response> {
    const row = await this.deps.userFog.get(userId, tileId);
    if (!row) return textError("fog not found", 404);
    // Copy into a fresh ArrayBuffer-backed Uint8Array — same trick the
    // heritage GET uses; some lib.dom variants reject SharedArrayBuffer-
    // backed views as BodyInit.
    const body = new Uint8Array(row.bitmap.length);
    body.set(row.bitmap);
    return new Response(body, {
      status: 200,
      headers: { "content-type": "application/octet-stream" },
    });
  }

  private async internalPutFog(userId: string, tileId: string, req: Request): Promise<Response> {
    const ab = await req.arrayBuffer();
    const bitmap = new Uint8Array(ab);
    if (bitmap.byteLength === 0) return textError("empty body", 400);
    await this.deps.userFog.put(userId, tileId, bitmap);
    return new Response(null, { status: 204 });
  }

  private async internalSetHearth(userId: string, req: Request): Promise<Response> {
    let body: { tileId?: string | null; position?: { x?: number; y?: number; z?: number } | null };
    try { body = await req.json(); } catch { return textError("bad request", 400); }

    const user = await this.deps.users.getById(userId);
    if (!user) return textError("user not found", 404);

    // Null body clears the anchor (e.g. on hearth destruction).
    if (body.tileId === null || body.position === null) {
      await this.deps.users.updateHearth(userId, null);
      return new Response(null, { status: 204 });
    }
    if (typeof body.tileId !== "string" || !body.position
      || typeof body.position.x !== "number"
      || typeof body.position.y !== "number"
      || typeof body.position.z !== "number") {
      return textError("tileId and position {x,y,z} required", 400);
    }
    const anchor: HearthAnchor = {
      tileId: body.tileId,
      position: { x: body.position.x, y: body.position.y, z: body.position.z },
    };
    await this.deps.users.updateHearth(userId, anchor);
    console.log(`[Account] hearth anchor set for user ${userId} on tile ${anchor.tileId}`);
    return new Response(null, { status: 204 });
  }
}
