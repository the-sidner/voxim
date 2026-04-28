/**
 * Coordinator → Gateway WebTransport link.
 *
 * Opens a WT session to the gateway, performs the service handshake, and
 * keeps a single bidirectional stream open for future event/command
 * routing (T-139).
 *
 * Resilience: if the connection is refused or drops we wait `retryMs` and
 * try again. The coordinator's tick loop runs regardless — gateway being
 * down is a logged condition, not a fatal error.
 */
import { encodeFrame, makeFrameReader } from "@voxim/protocol";
import type { ServiceHandshake, ServiceHandshakeAck } from "@voxim/protocol";

export interface GatewayLinkConfig {
  /** WebTransport URL of the gateway, e.g. "https://gateway:8080". */
  url: string;
  serviceSecret: string;
  /** Hex SHA-256 of the gateway's cert — required for self-signed dev. */
  gatewayCertHashHex?: string;
  /** Reconnect delay in ms. Default 5000. */
  retryMs?: number;
}

export class GatewayLink {
  private transport: WebTransport | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private closed = false;
  /** True between a successful handshake and the session closing. */
  connected = false;

  constructor(private readonly config: GatewayLinkConfig) {}

  async connect(): Promise<void> {
    while (!this.closed) {
      try {
        await this.connectOnce();
      } catch (err) {
        console.warn(`[GatewayLink] connect failed: ${(err as Error).message}`);
      }
      if (this.closed) return;
      const wait = this.config.retryMs ?? 5000;
      await new Promise((r) => setTimeout(r, wait));
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    try { this.writer?.close().catch(() => {}); } catch { /* ignore */ }
    try { this.transport?.close(); } catch { /* ignore */ }
    this.connected = false;
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
      kind: "coordinator",
      secret: this.config.serviceSecret,
    };
    await writer.write(encodeFrame(handshake));

    const frames = makeFrameReader(reader);
    const ack = await frames.readJson() as ServiceHandshakeAck | null;
    if (!ack || ack.type !== "service_handshake_ack" || !ack.ok) {
      throw new Error(`handshake rejected: ${ack?.reason ?? "no ack"}`);
    }

    this.connected = true;
    console.log("[GatewayLink] handshake ok");

    // Block until the session closes. Subsequent T-139 work consumes
    // command frames here; for now we just keep the stream alive.
    try {
      while (!this.closed) {
        const frame = await frames.readJson();
        if (frame === null) break; // remote closed
        // T-139 will dispatch frame as a TileCommand-relayed-from-tile or
        // similar; for now log and discard so the dev loop is observable.
        console.log("[GatewayLink] received frame:", frame);
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

  /** Send an event/command up to the gateway. T-139 wires the actual senders. */
  async send(value: unknown): Promise<void> {
    if (!this.writer) throw new Error("gateway link not connected");
    await this.writer.write(encodeFrame(value));
  }
}
