/**
 * Coordinator — macro-world ECS driver.
 *
 * One per cluster. Owns the world map, cities, caravans, trade, and macro
 * events. Runs a slow tickloop (default 1 Hz) on top of `@voxim/engine`'s
 * World.
 *
 * T-137 shipped the empty world + WT link.
 * T-139 wires real publish/subscribe over the link:
 *   - tile-published WorldEvents arrive in `onEvent` and are logged
 *   - `tellTile()` emits a TileCommand targeting a specific tileId
 * T-138 (world map), T-142 (city sim) put real behaviour on top.
 */
import { World } from "@voxim/engine";
import type {
  WorldEventEnvelope,
  TileCommandEnvelope,
} from "@voxim/protocol";
import type { AtlasTileInitRepo, CityRepo, CityRow, WorldRow, WorldsRepo } from "@voxim/db";
import { GatewayLink } from "./gateway_link.ts";
import {
  CITY_EVENT_LOG_LIMIT,
  defaultCityState,
  pickCityName,
  runUtilityAI,
  type CityState,
  type UtilityCommand,
} from "./city_sim.ts";
import { AIManagerClient } from "./ai_manager_client.ts";
import type { AgentToolCall, CityContextPacket } from "@voxim/ai-manager";

export interface CoordinatorConfig {
  /** Gateway WebTransport URL, e.g. "https://gateway:8080". */
  gatewayWtUrl: string;
  /** Shared secret matching the gateway's VOXIM_SERVICE_SECRET. */
  serviceSecret: string;
  /**
   * SHA-256 hex of the gateway's TLS cert. Required for self-signed dev
   * certs; omit when the gateway uses a CA-signed cert.
   */
  gatewayCertHashHex?: string;
  /** Tick rate in Hz. Default 1 (macro sim is slow). */
  tickRateHz?: number;
  /**
   * Worlds repo. Coordinator picks the latest baked world at boot and
   * scopes its world-graph aggregation to that world.
   */
  worldsRepo?: WorldsRepo;
  /**
   * Atlas tile_init repo. Read-only here — seeds the per-tile gate-summary
   * map at boot from the active world's baked tiles.
   */
  atlasTilesRepo?: AtlasTileInitRepo;
  /**
   * Cities repo. The macro utility-AI tickloop reads from it. City seeding
   * (was driven by citySeedFlag on the legacy world map) is paused until
   * atlas's worldmap learns to carry city seeds.
   */
  cityRepo?: CityRepo;
  /**
   * Base URL for the ai-manager service (T-143), e.g. "http://ai-manager:8090".
   * When omitted the coordinator runs utility-AI only.
   */
  aiManagerUrl?: string;
  /**
   * HTTP port for read-only debug + macro queries (/health, /world-graph).
   * When omitted the coordinator skips the HTTP server entirely.
   */
  httpPort?: number;
}

/** Macro utility-AI runs every N coordinator ticks. */
const CITY_AI_INTERVAL_TICKS = 10;

export class Coordinator {
  readonly world = new World();
  private link: GatewayLink | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private tick = 0;
  private httpAbort: AbortController | null = null;
  /** Tracks tiles that have published at least one event recently. */
  private liveTiles = new Set<string>();
  /**
   * Per-tile gate-summary u16, keyed by tileId. Seeded by tile-server's
   * tile_summary_updated event on boot; updated by the same event when
   * the runtime edit loop changes the summary (phase 6D).
   *
   * The aggregated world graph derives from this map: nodes are
   * (tileId, component-of-summary), edges are inter-tile via gates
   * with matching nibble values across the shared edge.
   */
  private tileSummaries = new Map<string, { cellX: number; cellY: number; summary: number }>();
  /** Active world (latest baked). null when atlas hasn't bootstrapped one yet. */
  private activeWorld: WorldRow | null = null;
  private cityRepo: CityRepo | null = null;
  /** In-memory mirror of `cities` rows; refreshed on seed and after each AI pass. */
  private cities: CityRow[] = [];
  private ai: AIManagerClient | null = null;
  /**
   * Cities currently waiting on an ai-manager response. Each entry pins a
   * city until its dispatchCity() promise settles, so concurrent significant
   * events for the same city collapse into one call. Cleared on settle.
   */
  private aiInFlight = new Set<string>();

  async start(config: CoordinatorConfig): Promise<void> {
    // Active world: latest baked. Atlas owns worlds; we just read.
    if (config.worldsRepo) {
      this.activeWorld = await config.worldsRepo.getLatest();
      if (this.activeWorld) {
        console.log(
          `[Coordinator] active world: ${this.activeWorld.name} ` +
          `(${this.activeWorld.id.slice(0, 8)}…) ${this.activeWorld.width}×${this.activeWorld.height} ` +
          `baked ${this.activeWorld.bakedAt.toISOString()}`,
        );
      } else {
        console.warn(
          "[Coordinator] no worlds present — atlas hasn't bootstrapped yet. " +
          "world graph will start empty; tile summaries will populate on tile boot.",
        );
      }
    }

    // Seed the world-graph aggregate from atlas's baked tile_init rows.
    // Coordinator no longer waits for tiles to push their summaries — the
    // bake is the source of truth. Tile pushes after this point are
    // delta updates from runtime edits (phase 6D).
    if (config.atlasTilesRepo && this.activeWorld) {
      const summaries = await config.atlasTilesRepo.listSummaries(this.activeWorld.id);
      for (const s of summaries) {
        // tile_id convention: cellX_cellY
        const tileId = `${s.cellX}_${s.cellY}`;
        this.tileSummaries.set(tileId, { cellX: s.cellX, cellY: s.cellY, summary: s.summary });
      }
      console.log(`[Coordinator] world graph seeded with ${this.tileSummaries.size} tile summaries`);
    }

    if (config.cityRepo) {
      this.cityRepo = config.cityRepo;
      this.cities = await this.cityRepo.list();
      console.log(`[Coordinator] cities ready: ${this.cities.length}`);
    }

    // AI manager (T-143). Optional: when AI_MANAGER_URL is unset the
    // coordinator runs utility-AI only.
    if (config.aiManagerUrl) {
      this.ai = new AIManagerClient(config.aiManagerUrl);
      console.log(`[Coordinator] ai-manager wired @ ${config.aiManagerUrl}`);
    }

    const tickRate = config.tickRateHz ?? 1;
    const intervalMs = Math.max(1, Math.round(1000 / tickRate));

    this.link = new GatewayLink({
      url: config.gatewayWtUrl,
      serviceSecret: config.serviceSecret,
      gatewayCertHashHex: config.gatewayCertHashHex,
      onEvent: (env) => this.handleEvent(env),
    });
    void this.link.connect();

    this.tickTimer = setInterval(() => this.runTick(intervalMs / 1000), intervalMs);
    console.log(`[Coordinator] tickloop started @ ${tickRate} Hz`);

    if (config.httpPort) this.startHttp(config.httpPort);

    // Restart-on-bake: same pattern as tile-server. When atlas writes a
    // new worlds row, we exit so the world graph reseeds from the fresh
    // baked tile_init on next boot.
    if (config.worldsRepo && this.activeWorld) {
      const repo = config.worldsRepo;
      const initialId    = this.activeWorld.id;
      const initialBaked = this.activeWorld.bakedAt.getTime();
      setInterval(async () => {
        try {
          const w = await repo.getLatest();
          if (!w) return;
          if (w.id !== initialId || w.bakedAt.getTime() > initialBaked) {
            console.log(
              `[Coordinator] new world detected (${w.id.slice(0, 8)}… baked ` +
              `${w.bakedAt.toISOString()}); restarting`,
            );
            Deno.exit(0);
          }
        } catch (err) {
          console.warn(`[Coordinator] world poll failed: ${(err as Error).message}`);
        }
      }, 5000);
    }
  }

  /**
   * Read-only HTTP for outside consumers — health check + the aggregated
   * world graph (the live picture of every tile's gate-summary). Tiny:
   * no streaming, no subscriptions, just a snapshot per request. The
   * world graph is small enough (≤ a few KB even for large worlds) that
   * polling is fine.
   */
  private startHttp(port: number): void {
    this.httpAbort = new AbortController();
    Deno.serve({
      port,
      hostname: "0.0.0.0",
      signal: this.httpAbort.signal,
    }, (req) => {
      const url = new URL(req.url);
      const headers = { "access-control-allow-origin": "*" };
      if (req.method === "GET" && url.pathname === "/health") {
        return Response.json({ status: "ok", service: "coordinator" }, { headers });
      }
      if (req.method === "GET" && url.pathname === "/world-graph") {
        return Response.json({ summaries: this.getWorldGraph() }, { headers });
      }
      return new Response("not found", { status: 404, headers });
    });
    console.log(`[Coordinator] HTTP listening on 0.0.0.0:${port}`);
  }

  async stop(): Promise<void> {
    if (this.tickTimer !== null) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    if (this.httpAbort) {
      this.httpAbort.abort();
      this.httpAbort = null;
    }
    await this.link?.close();
    console.log("[Coordinator] stopped");
  }

  /** Send a TileCommand to a specific tile (via gateway routing). */
  async tellTile(targetTileId: string, command: { kind: string; [k: string]: unknown }): Promise<void> {
    if (!this.link?.connected) {
      console.warn(`[Coordinator] cannot send tile_command — link down`);
      return;
    }
    const env: TileCommandEnvelope = { type: "tile_command", targetTileId, command };
    await this.link.sendCommand(env);
  }

  private handleEvent(env: WorldEventEnvelope): void {
    const wasNew = !this.liveTiles.has(env.sourceTileId);
    this.liveTiles.add(env.sourceTileId);

    if (env.event.kind === "tile_summary_updated") {
      const cellX   = env.event.cellX as number;
      const cellY   = env.event.cellY as number;
      const summary = env.event.summary as number;
      const tileId  = env.sourceTileId;
      const prev    = this.tileSummaries.get(tileId);
      this.tileSummaries.set(tileId, { cellX, cellY, summary });
      if (!prev || prev.summary !== summary) {
        console.log(
          `[Coordinator] tile_summary_updated ${tileId} (${cellX},${cellY}) → 0x${summary.toString(16).padStart(4, "0")}`,
        );
      }
      return;
    }

    // Always log discrete events; throttle the steady-state heartbeat.
    if (env.event.kind === "gate_approached") {
      console.log(
        `[Coordinator] gate_approached: player=${(env.event.playerId as string)?.slice(0, 8)} ` +
        `${env.sourceTileId} → ${env.event.destinationTileId} (edge=${env.event.edge})`,
      );
      // T-143: gate_approached is a "significant event" — forward to the
      // ai-manager for the city sitting on the source tile, if one exists.
      // Significance widens in later tickets (death, large damage, market
      // imbalance) once the LLM dispatcher proves out.
      void this.notifyAi("gate_approached", env.sourceTileId, {
        playerId: env.event.playerId,
        destinationTileId: env.event.destinationTileId,
      });
      return;
    }
    if (wasNew) {
      console.log(`[Coordinator] first event from ${env.sourceTileId} — kind=${env.event.kind}`);
    } else if (this.tick % 10 === 0) {
      console.log(`[Coordinator] event from ${env.sourceTileId} kind=${env.event.kind}`);
    }
  }

  /**
   * Snapshot of the aggregated world graph — every tile's gate-summary
   * indexed for outside consumers (HTTP query, future client subscription).
   * Returns a fresh array; mutating it doesn't affect the live state.
   */
  getWorldGraph(): Array<{ tileId: string; cellX: number; cellY: number; summary: number }> {
    const out: Array<{ tileId: string; cellX: number; cellY: number; summary: number }> = [];
    for (const [tileId, v] of this.tileSummaries) {
      out.push({ tileId, cellX: v.cellX, cellY: v.cellY, summary: v.summary });
    }
    return out;
  }

  private runTick(_dt: number): void {
    this.tick++;
    if (this.tick % 10 === 0) {
      console.log(
        `[Coordinator] tick ${this.tick} (link=${this.link?.connected ? "up" : "down"}, tiles=${this.liveTiles.size}, cities=${this.cities.length})`,
      );
    }

    // T-142: macro utility-AI runs on a slow cadence so DB writes stay cheap.
    // Each pass walks every city, advances production / consumption / dispatch
    // heuristics, persists state + event log, and emits one TileCommand per
    // decision. NPC instantiation happens on the tile that owns the city.
    if (this.tick % CITY_AI_INTERVAL_TICKS === 0 && this.cityRepo) {
      void this.runCityAi();
    }
  }

  /**
   * Refresh in-memory cities, advance utility AI for each, persist new state
   * + event log, and dispatch TileCommands. Errors per city are isolated so
   * one bad row doesn't abort the whole pass.
   */
  private async runCityAi(): Promise<void> {
    if (!this.cityRepo) return;
    try {
      this.cities = await this.cityRepo.list();
    } catch (err) {
      console.warn(`[Coordinator] city list failed: ${(err as Error).message}`);
      return;
    }
    for (const city of this.cities) {
      const prev = city.state as unknown as CityState;
      const result = runUtilityAI(prev, this.tick);
      try {
        await this.cityRepo.updateState(city.cityId, result.next as unknown as Record<string, unknown>);
        for (const ev of result.events) {
          await this.cityRepo.appendEvent(city.cityId, ev, CITY_EVENT_LOG_LIMIT);
        }
      } catch (err) {
        console.warn(`[Coordinator] city ${city.cityId} persist failed: ${(err as Error).message}`);
        continue;
      }
      // Emit one TileCommand per utility decision. Tile-side dispatch lives
      // outside this ticket — for now the tile-server logs the kind.
      if (this.link?.connected) {
        for (const cmd of result.commands) {
          void this.tellTile(city.tileId, toTileCommand(city.cityId, cmd));
        }
      }
    }
  }

  /**
   * Forward a significant event to the ai-manager for the city on `tileId`.
   * No-ops when AI is not wired or no city sits on this tile. One in-flight
   * call per city — concurrent events for the same city collapse so we
   * never spend two LLM calls on the same situation.
   */
  private async notifyAi(
    kind: string,
    tileId: string,
    detail: Record<string, unknown>,
  ): Promise<void> {
    if (!this.ai || !this.cityRepo) return;
    const city = this.cities.find((c) => c.tileId === tileId);
    if (!city) return;
    if (this.aiInFlight.has(city.cityId)) return;
    this.aiInFlight.add(city.cityId);
    try {
      const cityState = city.state as unknown as CityState;
      const trigger = { tick: this.tick, kind, detail };
      const recent = (city.eventLog as Array<{ tick: number; kind: string; detail?: Record<string, unknown> }>)
        .slice(-20);
      const packet: CityContextPacket = {
        cityId: city.cityId,
        tileId: city.tileId,
        name: city.name,
        personality: cityState.personality ?? "stern",
        state: city.state,
        recentEvents: [...recent, trigger],
        trigger,
      };
      const resp = await this.ai.dispatchCity(packet);
      if (!resp || resp.tool_calls.length === 0) return;
      console.log(
        `[Coordinator] ai-manager → ${city.name}: ${resp.tool_calls.length} tool_calls (trigger=${kind})`,
      );
      await this.applyAgentToolCalls(city, resp.tool_calls, resp.rationale);
    } finally {
      this.aiInFlight.delete(city.cityId);
    }
  }

  /**
   * Validate + dispatch tool calls returned by the ai-manager. Each call
   * shape is checked against the allow-list, dropped on mismatch, and
   * appended to the city's event log alongside any rationale.
   */
  private async applyAgentToolCalls(
    city: CityRow,
    calls: AgentToolCall[],
    rationale: string | undefined,
  ): Promise<void> {
    if (!this.cityRepo) return;
    if (rationale) {
      try {
        await this.cityRepo.appendEvent(
          city.cityId,
          { tick: this.tick, kind: "ai_rationale", detail: { rationale } },
          CITY_EVENT_LOG_LIMIT,
        );
      } catch {
        // best-effort
      }
    }
    for (const call of calls) {
      if (!isValidAgentToolCall(call)) {
        console.warn(`[Coordinator] dropping invalid agent tool_call:`, call);
        continue;
      }
      try {
        await this.cityRepo.appendEvent(
          city.cityId,
          { tick: this.tick, kind: `ai_${call.kind}`, detail: { ...call } },
          CITY_EVENT_LOG_LIMIT,
        );
      } catch {
        // best-effort
      }
      if (call.kind === "log_note") continue; // log-only, no tile dispatch
      if (this.link?.connected) {
        const tileCmd = call.kind === "spawn_role"
          ? { kind: "city_spawn_role", cityId: city.cityId, role: call.role, count: call.count }
          : {
              kind: "city_dispatch_caravan",
              cityId: city.cityId,
              toTileId: call.toTileId,
              cargo: call.cargo,
            };
        void this.tellTile(city.tileId, tileCmd);
      }
    }
  }
}

function isValidAgentToolCall(call: unknown): call is AgentToolCall {
  if (typeof call !== "object" || call === null) return false;
  const c = call as { kind?: unknown };
  if (c.kind === "spawn_role") {
    const k = call as { role?: unknown; count?: unknown };
    return (k.role === "farmer" || k.role === "guard") && typeof k.count === "number";
  }
  if (c.kind === "dispatch_caravan") {
    const k = call as { toTileId?: unknown; cargo?: unknown };
    return typeof k.toTileId === "string" && Array.isArray(k.cargo);
  }
  if (c.kind === "log_note") {
    return typeof (call as { note?: unknown }).note === "string";
  }
  return false;
}

async function cityIdFor(worldSeed: number, tileId: string): Promise<string> {
  // Deterministic per (seed, tile) so re-running ensureCities is a no-op.
  // The cities.city_id column is uuid, so we derive a UUIDv5-style value
  // from a SHA-1 hash of the input rather than emitting a free-form string.
  const input = new TextEncoder().encode(`voxim:city:${worldSeed}:${tileId}`);
  const buf = await crypto.subtle.digest("SHA-1", input);
  const b = new Uint8Array(buf, 0, 16);
  // Set version (5) and IETF variant bits per RFC 4122.
  b[6] = (b[6] & 0x0f) | 0x50;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = Array.from(b, (n) => n.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function toTileCommand(cityId: string, cmd: UtilityCommand): { kind: string; [k: string]: unknown } {
  switch (cmd.kind) {
    case "spawn_role":
      return { kind: "city_spawn_role", cityId, role: cmd.role, count: cmd.count };
    case "dispatch_caravan":
      return {
        kind: "city_dispatch_caravan",
        cityId,
        toTileId: cmd.toTileId,
        cargo: cmd.cargo,
      };
  }
}

