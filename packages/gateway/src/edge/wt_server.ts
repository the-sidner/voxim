/// <reference path="../types/webtransport.d.ts" />
/**
 * WebTransport listener for the gateway's privileged service streams.
 *
 * Tiles and the world coordinator open a WebTransport session to the
 * gateway. The first frame on a bidirectional stream is a JSON
 * `ServiceHandshake` carrying the shared secret and a `kind`. After the
 * handshake the stream stays open as the multiplexed event/command channel.
 *
 * Routing (T-139):
 *   tile  → gateway  : WorldEventEnvelope  → forwarded to coordinator
 *   coord → gateway  : TileCommandEnvelope → forwarded to target tile
 *
 * If the coordinator isn't connected, tile events are dropped (logged
 * once, no buffering). Tile commands targeting an unknown / disconnected
 * tile are dropped likewise. Both decisions are deliberate: we picked
 * in-memory, no-replay routing in ARCHITECTURE.md ("Out of scope:
 * Durable event log replay") to keep this layer simple.
 */

import { encodeFrame, makeFrameReader } from "@voxim/protocol";
import type {
  ServiceHandshake,
  ServiceHandshakeAck,
  WorldEventEnvelope,
  TileCommandEnvelope,
} from "@voxim/protocol";

export interface WtServerConfig {
  port: number;
  cert: string;
  key: string;
  serviceSecret: string;
}

interface TileLink {
  tileId: string;
  send(value: unknown): Promise<void>;
  close(): void;
}

interface CoordinatorLink {
  send(value: unknown): Promise<void>;
  close(): void;
}

export class WtServer {
  private coordinator: CoordinatorLink | null = null;
  private tileLinks = new Map<string, TileLink>();

  constructor(private readonly config: WtServerConfig) {}

  get hasCoordinator(): boolean {
    return this.coordinator !== null;
  }

  start(): void {
    type QuicIncoming = { accept(): Promise<unknown> };
    type QuicEndpoint = { listen(opts: unknown): AsyncIterable<QuicIncoming> };
    // deno-lint-ignore no-explicit-any
    const DenoAny = Deno as any;

    let endpoint: QuicEndpoint;
    try {
      endpoint = new DenoAny.QuicEndpoint({
        hostname: "0.0.0.0",
        port: this.config.port,
      }) as QuicEndpoint;
    } catch (err) {
      console.warn(
        `[Gateway] WebTransport unavailable on UDP/${this.config.port} (${(err as Error).message}). ` +
        `Service streams disabled — HTTP-only.`,
      );
      return;
    }

    const listener = endpoint.listen({
      cert: this.config.cert,
      key: this.config.key,
      alpnProtocols: ["h3"],
    });

    console.log(`[Gateway] WT service listener on UDP/${this.config.port}`);

    (async () => {
      for await (const incoming of listener) {
        incoming.accept()
          // deno-lint-ignore no-explicit-any
          .then((conn) => (Deno as any).upgradeWebTransport(conn))
          .then((session: WebTransportSession) => this.handleSession(session))
          .catch((err: unknown) => {
            console.error("[Gateway] WT accept error:", err);
          });
      }
    })().catch((err: unknown) => {
      console.error("[Gateway] WT listener error:", err);
    });
  }

  private async handleSession(session: WebTransportSession): Promise<void> {
    await session.ready;

    const streamReader = session.incomingBidirectionalStreams.getReader();
    const { value: stream, done } = await streamReader.read();
    if (done || !stream) {
      console.warn("[Gateway] WT session closed before handshake");
      session.close();
      return;
    }

    const bidi = stream as WebTransportBidirectionalStream;
    const writer = bidi.writable.getWriter();
    const innerReader = bidi.readable.getReader();
    const frames = makeFrameReader(innerReader);

    let handshake: ServiceHandshake | null = null;
    try {
      const first = await frames.readJson() as ServiceHandshake | null;
      if (first && first.type === "service_handshake") handshake = first;
    } catch (err) {
      console.error("[Gateway] handshake decode error:", err);
    }

    if (!handshake) {
      await this.sendAck(writer, { type: "service_handshake_ack", ok: false, reason: "expected service_handshake" });
      session.close({ closeCode: 1, reason: "no handshake" });
      return;
    }

    if (handshake.secret !== this.config.serviceSecret) {
      await this.sendAck(writer, { type: "service_handshake_ack", ok: false, reason: "bad secret" });
      session.close({ closeCode: 2, reason: "auth" });
      return;
    }

    if (handshake.kind === "coordinator") {
      await this.acceptCoordinator(session, writer, frames);
      return;
    }

    if (handshake.kind === "tile") {
      const id = handshake.id?.trim();
      if (!id) {
        await this.sendAck(writer, { type: "service_handshake_ack", ok: false, reason: "tile handshake missing id" });
        session.close({ closeCode: 4, reason: "no tile id" });
        return;
      }
      await this.acceptTile(id, session, writer, frames);
      return;
    }

    await this.sendAck(writer, { type: "service_handshake_ack", ok: false, reason: `unknown kind: ${(handshake as { kind?: string }).kind}` });
    session.close({ closeCode: 5, reason: "bad kind" });
  }

  // ---- coordinator ----

  private async acceptCoordinator(
    session: WebTransportSession,
    writer: WritableStreamDefaultWriter<Uint8Array>,
    frames: ReturnType<typeof makeFrameReader>,
  ): Promise<void> {
    if (this.coordinator) {
      await this.sendAck(writer, { type: "service_handshake_ack", ok: false, reason: "coordinator already connected" });
      session.close({ closeCode: 3, reason: "duplicate coordinator" });
      return;
    }

    const link: CoordinatorLink = {
      send: async (value) => { await writer.write(encodeFrame(value)); },
      close: () => session.close(),
    };
    this.coordinator = link;
    await this.sendAck(writer, { type: "service_handshake_ack", ok: true });
    console.log("[Gateway] coordinator connected");

    session.closed
      .catch(() => {/* normal close throws on some Deno versions */})
      .finally(() => {
        if (this.coordinator === link) {
          this.coordinator = null;
          console.log("[Gateway] coordinator disconnected");
        }
      });

    // Read commands from the coordinator and route to target tiles.
    try {
      while (true) {
        const msg = await frames.readJson();
        if (msg === null) break;
        await this.routeFromCoordinator(msg);
      }
    } catch (err) {
      console.warn(`[Gateway] coordinator stream error: ${(err as Error).message}`);
    }
  }

  private async routeFromCoordinator(msg: unknown): Promise<void> {
    const env = msg as TileCommandEnvelope;
    if (!env || env.type !== "tile_command" || typeof env.targetTileId !== "string" || !env.command) {
      console.warn("[Gateway] dropped malformed coordinator frame:", msg);
      return;
    }
    const tile = this.tileLinks.get(env.targetTileId);
    if (!tile) {
      console.warn(`[Gateway] dropped tile_command for unknown/offline tile ${env.targetTileId}`);
      return;
    }
    await tile.send(env);
  }

  // ---- tile ----

  private async acceptTile(
    tileId: string,
    session: WebTransportSession,
    writer: WritableStreamDefaultWriter<Uint8Array>,
    frames: ReturnType<typeof makeFrameReader>,
  ): Promise<void> {
    // If a stream for this tile already exists, replace it. Tiles don't
    // open multiple WT links by design; a duplicate means the previous
    // session died and the tile is reconnecting.
    const existing = this.tileLinks.get(tileId);
    if (existing) existing.close();

    const link: TileLink = {
      tileId,
      send: async (value) => { await writer.write(encodeFrame(value)); },
      close: () => session.close(),
    };
    this.tileLinks.set(tileId, link);

    await this.sendAck(writer, { type: "service_handshake_ack", ok: true });
    console.log(`[Gateway] tile WT stream connected: ${tileId}`);

    session.closed
      .catch(() => {/* normal close */})
      .finally(() => {
        if (this.tileLinks.get(tileId) === link) {
          this.tileLinks.delete(tileId);
          console.log(`[Gateway] tile WT stream disconnected: ${tileId}`);
        }
      });

    // Read events from the tile and forward to coordinator if connected.
    try {
      while (true) {
        const msg = await frames.readJson();
        if (msg === null) break;
        await this.routeFromTile(tileId, msg);
      }
    } catch (err) {
      console.warn(`[Gateway] tile ${tileId} stream error: ${(err as Error).message}`);
    }
  }

  private async routeFromTile(tileId: string, msg: unknown): Promise<void> {
    const env = msg as WorldEventEnvelope;
    if (!env || env.type !== "world_event" || !env.event) {
      console.warn(`[Gateway] dropped malformed tile frame from ${tileId}:`, msg);
      return;
    }
    if (!this.coordinator) {
      // Drop silently most of the time — events are best-effort. Log
      // first occurrence so a misconfigured cluster is observable.
      if (!this.warnedNoCoordinator) {
        console.warn("[Gateway] world_event arrived but no coordinator connected (further drops suppressed)");
        this.warnedNoCoordinator = true;
      }
      return;
    }
    // Pass through unchanged — gateway is just a switchboard.
    await this.coordinator.send(env);
  }

  private warnedNoCoordinator = false;

  private async sendAck(
    writer: WritableStreamDefaultWriter<Uint8Array>,
    ack: ServiceHandshakeAck,
  ): Promise<void> {
    try {
      await writer.write(encodeFrame(ack));
    } catch {
      /* peer closed — ignore */
    }
  }
}
