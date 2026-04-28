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
import type { WorldEventEnvelope, TileCommandEnvelope } from "@voxim/protocol";
import { GatewayLink } from "./gateway_link.ts";

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
}

export class Coordinator {
  readonly world = new World();
  private link: GatewayLink | null = null;
  private tickTimer: number | null = null;
  private tick = 0;
  /** Tracks tiles that have published at least one event recently. */
  private liveTiles = new Set<string>();

  async start(config: CoordinatorConfig): Promise<void> {
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
    if (wasNew) {
      console.log(`[Coordinator] first event from ${env.sourceTileId} — kind=${env.event.kind}`);
    } else {
      // Quieter steady-state log so the dev loop is observable without
      // being noisy. Real handlers will replace this in T-140 / T-142.
      if (this.tick % 10 === 0) {
        console.log(`[Coordinator] event from ${env.sourceTileId} kind=${env.event.kind}`);
      }
    }
  }

  private runTick(_dt: number): void {
    this.tick++;
    if (this.tick % 10 === 0) {
      console.log(
        `[Coordinator] tick ${this.tick} (link=${this.link?.connected ? "up" : "down"}, tiles=${this.liveTiles.size})`,
      );
    }

    // T-139 sanity check: every 60 ticks (~60s at 1 Hz) ping each known
    // tile with a noop tile_command so we can observe the down-channel
    // works end-to-end. T-140 / T-148 replace this with real commands.
    if (this.tick % 60 === 0 && this.link?.connected) {
      for (const tileId of this.liveTiles) {
        void this.tellTile(tileId, { kind: "noop_ping", at: Date.now() });
      }
    }
  }
}
