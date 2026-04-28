/// <reference path="./types/webtransport.d.ts" />
/**
 * Tile-server → Gateway privileged WebTransport link (T-139).
 *
 * Sits alongside the HTTP register/heartbeat lifecycle. The HTTP path
 * keeps the registry warm and is the source of truth for "is this tile
 * alive"; the WT link is the bidirectional event/command channel:
 *
 *   tile  → gateway  : WorldEventEnvelope (gateway forwards to coordinator)
 *   gateway → tile   : TileCommandEnvelope (originating from coordinator)
 *
 * Resilience: on any failure (handshake rejected, stream error, gateway
 * unreachable) we wait `retryMs` and reconnect. The tick loop runs
 * regardless of link state.
 */
import { encodeFrame, makeFrameReader } from "@voxim/protocol";
import type {
  ServiceHandshake,
  ServiceHandshakeAck,
  TileCommandEnvelope,
  WorldEventEnvelope,
} from "@voxim/protocol";

export interface GatewayLinkConfig {
  /** WebTransport URL of the gateway, e.g. "https://gateway:8080". */
  url: string;
  tileId: string;
  serviceSecret: string;
  /** Hex SHA-256 of the gateway's cert — required for self-signed dev. */
  gatewayCertHashHex?: string;
  /** Reconnect delay in ms. Default 5000. */
  retryMs?: number;
  /** Called when a TileCommand frame arrives. */
  onCommand?: (cmd: TileCommandEnvelope) => void;
}

export class GatewayLink {
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private transport: WebTransport | null = null;
  private closed = false;
  /** True between a successful handshake and the session closing. */
  connected = false;

  constructor(private readonly config: GatewayLinkConfig) {}

  /** Kick off the connect/reconnect loop in the background. */
  start(): void {
    void this.runForever();
  }

  async stop(): Promise<void> {
    this.closed = true;
    try { this.writer?.close().catch(() => {}); } catch { /* ignore */ }
    try { this.transport?.close(); } catch { /* ignore */ }
    this.connected = false;
  }

  /**
   * Publish a WorldEvent to the gateway. Drops silently if the link
   * isn't currently connected — events are best-effort by design.
   */
  async publish(event: WorldEventEnvelope): Promise<void> {
    if (!this.writer) return;
    try {
      await this.writer.write(encodeFrame(event));
    } catch (err) {
      console.warn(`[GatewayLink] publish failed: ${(err as Error).message}`);
    }
  }

  private async runForever(): Promise<void> {
    while (!this.closed) {
      try {
        await this.connectOnce();
      } catch (err) {
        console.warn(`[GatewayLink] connect failed: ${(err as Error).message}`);
      }
      if (this.closed) return;
      await new Promise((r) => setTimeout(r, this.config.retryMs ?? 5000));
    }
  }

  private async connectOnce(): Promise<void> {
    // deno-lint-ignore no-explicit-any
    const opts: Record<string, any> = {};
    if (this.config.gatewayCertHashHex) {
      const hashBytes = Uint8Array.from(
        this.config.gatewayCertHashHex.match(/../g)!.map((h) => parseInt(h, 16)),
      );
      opts.serverCertificateHashes = [{ algorithm: "sha-256", value: hashBytes.buffer }];
    }
    console.log(`[GatewayLink] dialing ${this.config.url}`);
    const transport = new WebTransport(this.config.url, opts);
    this.transport = transport;
    await transport.ready;

    const stream = await transport.createBidirectionalStream();
    const writer = stream.writable.getWriter();
    const reader = stream.readable.getReader();
    this.writer = writer;

    const handshake: ServiceHandshake = {
      type: "service_handshake",
      kind: "tile",
      id: this.config.tileId,
      secret: this.config.serviceSecret,
    };
    await writer.write(encodeFrame(handshake));

    const frames = makeFrameReader(reader);
    const ack = await frames.readJson() as ServiceHandshakeAck | null;
    if (!ack || ack.type !== "service_handshake_ack" || !ack.ok) {
      throw new Error(`handshake rejected: ${ack?.reason ?? "no ack"}`);
    }

    this.connected = true;
    console.log(`[GatewayLink] handshake ok (tileId=${this.config.tileId})`);

    try {
      while (!this.closed) {
        const msg = await frames.readJson();
        if (msg === null) break;
        const cmd = msg as TileCommandEnvelope;
        if (cmd?.type === "tile_command" && cmd.command) {
          this.config.onCommand?.(cmd);
        } else {
          console.warn("[GatewayLink] dropped unknown frame:", msg);
        }
      }
    } catch (err) {
      console.warn(`[GatewayLink] stream error: ${(err as Error).message}`);
    } finally {
      this.connected = false;
      try { writer.close().catch(() => {}); } catch { /* ignore */ }
      try { transport.close(); } catch { /* ignore */ }
      this.writer = null;
      this.transport = null;
    }
  }
}
