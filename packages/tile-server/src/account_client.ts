/**
 * AccountClient — tile server's remote-procedure interface to the
 * gateway-hosted account service. Replaces the former in-process
 * `HeritageStore` with HTTP calls so dynasty state survives tile restarts
 * and follows the user across tiles.
 *
 * All server-to-server calls present the shared secret in the
 * `X-Voxim-Service-Secret` header — the gateway rejects requests without
 * it. Same secret the gateway's endpoints.ts verifies.
 *
 * Failure handling is deliberately conservative: network errors throw,
 * callers decide whether to retry or accept a degraded path. We log but do
 * not swallow — a tile server that silently loses death events is worse
 * than one that tells the operator something is wrong.
 */
import { heritageCodec } from "@voxim/codecs";
import type { HeritageData } from "@voxim/codecs";

export interface HearthAnchor {
  tileId: string;
  position: { x: number; y: number; z: number };
}

export interface SessionInfo {
  userId: string;
  activeDynastyId: string;
  lastTileId: string | null;
  hearthAnchor: HearthAnchor | null;
}

export class AccountClient {
  constructor(
    private readonly baseUrl: string,
    private readonly serviceSecret: string,
  ) {
    if (!baseUrl) throw new Error("AccountClient: baseUrl required");
    if (!serviceSecret || serviceSecret.length < 16) {
      throw new Error("AccountClient: serviceSecret must be set and at least 16 chars");
    }
  }

  private headers(extra: Record<string, string> = {}): HeadersInit {
    return { "x-voxim-service-secret": this.serviceSecret, ...extra };
  }

  /**
   * Validate a client-presented session token against the gateway and return
   * the associated user info. Returns null when the token is unknown,
   * expired, or missing — callers should treat null as "reject the join".
   * Throws on transport errors so transient gateway outages don't
   * silently let unauthenticated players in.
   */
  async validateSession(token: string): Promise<SessionInfo | null> {
    const res = await fetch(`${this.baseUrl}/internal/session/${encodeURIComponent(token)}`, {
      headers: this.headers(),
    });
    if (res.status === 401) return null;
    if (!res.ok) {
      throw new Error(`AccountClient.validateSession: HTTP ${res.status}`);
    }
    return await res.json() as SessionInfo;
  }

  /**
   * Fetch the current heritage for a user. Decoded with the same codec the
   * gateway encoded it with — no JSON intermediary. Returns null when the
   * user has no heritage file (shouldn't happen for a user the gateway
   * just authenticated; treated as a soft error).
   */
  async getHeritage(userId: string): Promise<HeritageData | null> {
    const res = await fetch(`${this.baseUrl}/internal/user/${encodeURIComponent(userId)}/heritage`, {
      headers: this.headers(),
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new Error(`AccountClient.getHeritage: HTTP ${res.status}`);
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    return heritageCodec.decode(bytes);
  }

  /**
   * Record a death on the gateway. Gateway advances generation and appends
   * a heritage trait. Fire-and-forget is tempting (latency off the
   * disconnect hot path) but losing a death silently is worse than a few
   * hundred ms of cleanup, so we await.
   */
  async recordDeath(userId: string, cause: "damage" | "starvation" | "corruption" | "effect", killerId?: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/internal/user/${encodeURIComponent(userId)}/death`, {
      method: "POST",
      headers: this.headers({ "content-type": "application/json" }),
      body: JSON.stringify({ cause, killerId }),
    });
    if (!res.ok) {
      throw new Error(`AccountClient.recordDeath: HTTP ${res.status}`);
    }
  }

  /**
   * Tell the gateway which tile this user is on. Called on disconnect so
   * next login routes back here. Also safe to call on join as a touch-up.
   */
  async updateLocation(userId: string, lastTileId: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/internal/user/${encodeURIComponent(userId)}/location`, {
      method: "PATCH",
      headers: this.headers({ "content-type": "application/json" }),
      body: JSON.stringify({ lastTileId }),
    });
    if (!res.ok) {
      throw new Error(`AccountClient.updateLocation: HTTP ${res.status}`);
    }
  }

  /**
   * Record the user's new hearth anchor — the location their heir spawns
   * at on next login post-death. Pass `null` to clear the anchor (e.g.
   * when the hearth entity is destroyed).
   */
  async updateHearth(userId: string, anchor: HearthAnchor | null): Promise<void> {
    const body = anchor ?? { tileId: null, position: null };
    const res = await fetch(`${this.baseUrl}/internal/user/${encodeURIComponent(userId)}/hearth`, {
      method: "PATCH",
      headers: this.headers({ "content-type": "application/json" }),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`AccountClient.updateHearth: HTTP ${res.status}`);
    }
  }
}

// ---- derived stats (moved from the deleted HeritageStore) ----

/** Max accumulated health bonus, mirroring the gateway-side cap. */
const MAX_HEALTH_BONUS = 50;

/** Sum the health bonuses in a heritage record. */
export function heritageHealthBonus(h: HeritageData): number {
  return h.traits
    .filter((t) => t.type === "health_bonus")
    .reduce((sum, t) => sum + t.value, 0);
}

/** Character max health for a given heritage, clamped to the bonus cap. */
export function maxHealthFor(h: HeritageData, baseMaxHealth = 100): number {
  return baseMaxHealth + Math.min(heritageHealthBonus(h), MAX_HEALTH_BONUS);
}
