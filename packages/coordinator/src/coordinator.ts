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
  WorldMapPayload,
} from "@voxim/protocol";
import { encodeWorldMap, decodeWorldMap } from "@voxim/protocol";
import type { WorldMapRepo, CityRepo, CityRow } from "@voxim/db";
import { GatewayLink } from "./gateway_link.ts";
import { generateWorldMap } from "./world_map_gen.ts";
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
  /** World-map repo. Required for T-138; omit only for unit tests. */
  worldMapRepo?: WorldMapRepo;
  /** Seed used when generating the world map for the first time. */
  worldSeed?: number;
  /**
   * Tile ids the world map should cover. Order = row-major grid traversal,
   * length must equal worldWidth × worldHeight.
   */
  worldTileIds?: string[];
  /** Grid width / height. Default 2×2 for the dev slice. */
  worldWidth?: number;
  worldHeight?: number;
  /**
   * Cities repo (T-142). Required to seed CityState rows for citySeedFlag
   * tiles and run the macro utility-AI tickloop. Omit for the legacy world-
   * map-only mode (unit tests).
   */
  cityRepo?: CityRepo;
  /**
   * Base URL for the ai-manager service (T-143), e.g. "http://ai-manager:8090".
   * When omitted the coordinator runs utility-AI only.
   */
  aiManagerUrl?: string;
}

/** Macro utility-AI runs every N coordinator ticks. */
const CITY_AI_INTERVAL_TICKS = 10;

export class Coordinator {
  readonly world = new World();
  private link: GatewayLink | null = null;
  private tickTimer: number | null = null;
  private tick = 0;
  /** Tracks tiles that have published at least one event recently. */
  private liveTiles = new Set<string>();
  /** Decoded world map, available after start(). */
  private worldMap: WorldMapPayload | null = null;
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
    // Generate / load the world map first — every other macro decision
    // depends on knowing what the world looks like.
    if (config.worldMapRepo) {
      this.worldMap = await ensureWorldMap(config);
      console.log(
        `[Coordinator] world map ready: ${this.worldMap.width}×${this.worldMap.height} cells, ` +
        `seed=${this.worldMap.seed}`,
      );
    } else {
      console.warn("[Coordinator] no world map repo — running without macro world");
    }

    // Seed cities (T-142). Idempotent: ensureCities() only inserts rows that
    // don't already exist for citySeedFlag tiles.
    if (config.cityRepo && this.worldMap) {
      this.cityRepo = config.cityRepo;
      await this.ensureCities(config.worldSeed ?? 1);
      this.cities = await this.cityRepo.list();
      console.log(`[Coordinator] cities ready: ${this.cities.length} on the world map`);
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
  }

  async stop(): Promise<void> {
    if (this.tickTimer !== null) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
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
   * Insert one CityRow per tile flagged citySeedFlag in the world map. A
   * city seed has a deterministic id and name derived from the world seed
   * + tileId so re-runs are stable.
   */
  private async ensureCities(worldSeed: number): Promise<void> {
    if (!this.cityRepo || !this.worldMap) return;
    const existing = await this.cityRepo.list();
    const existingByTile = new Set(existing.map((c) => c.tileId));
    let created = 0;
    for (const cell of Object.values(this.worldMap.cells)) {
      if (!cell.citySeedFlag || existingByTile.has(cell.tileId)) continue;
      const cityId = await cityIdFor(worldSeed, cell.tileId);
      const name = pickCityName(worldSeed, cell.tileId);
      const state = defaultCityState(worldSeed, cell.tileId);
      await this.cityRepo.create({
        cityId,
        name,
        tileId: cell.tileId,
        state: state as unknown as Record<string, unknown>,
      });
      created++;
    }
    if (created > 0) console.log(`[Coordinator] seeded ${created} new cities`);
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

/**
 * Load the world map from `world_map` if a row exists, otherwise generate
 * one from config and write it. Idempotent — once a row is in the table
 * it's authoritative; only `compose-reset` can wipe it.
 */
async function ensureWorldMap(config: CoordinatorConfig): Promise<WorldMapPayload> {
  const repo = config.worldMapRepo!;
  const existing = await repo.get();
  if (existing) {
    try {
      return decodeWorldMap(existing.payload);
    } catch (err) {
      // Schema bumped or row corrupt. Regenerating clobbers the row,
      // which is fine because the world is regenerable from seed.
      console.warn(`[Coordinator] world_map row unreadable (${(err as Error).message}); regenerating`);
    }
  }

  const seed = config.worldSeed ?? 1;
  const tileIds = config.worldTileIds ?? ["tile_0", "tile_1", "tile_2", "tile_3"];
  const width = config.worldWidth ?? 2;
  const height = config.worldHeight ?? 2;

  const payload = generateWorldMap({ seed, tileIds, width, height });
  await repo.put({ seed: BigInt(seed), payload: encodeWorldMap(payload) });
  console.log(`[Coordinator] generated + persisted world map (seed=${seed})`);
  return payload;
}
