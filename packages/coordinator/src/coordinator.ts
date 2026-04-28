/**
 * Coordinator — macro-world ECS driver.
 *
 * One per cluster. Owns the world map, cities, caravans, trade, and macro
 * events. Runs a slow tickloop (default 1 Hz) on top of `@voxim/engine`'s
 * World. T-137 ships an empty world + the gateway WT link; T-138 (world
 * map), T-142 (city state + utility AI), and T-139 (event/command flow)
 * fill it in.
 */
import { World } from "@voxim/engine";
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

  async start(config: CoordinatorConfig): Promise<void> {
    const tickRate = config.tickRateHz ?? 1;
    const intervalMs = Math.max(1, Math.round(1000 / tickRate));

    this.link = new GatewayLink({
      url: config.gatewayWtUrl,
      serviceSecret: config.serviceSecret,
      gatewayCertHashHex: config.gatewayCertHashHex,
    });
    // Connect in the background — the tickloop runs whether the gateway
    // is up or not (so coordinator restarts don't all-or-nothing).
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

  private runTick(_dt: number): void {
    this.tick++;
    // Heartbeat log every 10 ticks (10s at 1 Hz). Real macro work lands
    // in T-142; for now we just prove the loop is alive.
    if (this.tick % 10 === 0) {
      console.log(`[Coordinator] tick ${this.tick} (link=${this.link?.connected ? "up" : "down"})`);
    }
  }
}
