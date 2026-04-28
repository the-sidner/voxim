/// <reference path="../types/webtransport.d.ts" />
/**
 * WebTransport listener for the gateway's privileged service streams.
 *
 * Tiles and the world coordinator open a WebTransport session to the
 * gateway. The first frame on a bidirectional stream is a JSON
 * `ServiceHandshake` carrying the shared secret and a `kind`. After the
 * handshake the stream stays open as the multiplexed event/command channel
 * (T-139 wires the actual routing).
 *
 * This module owns:
 *   - the QuicEndpoint listener (port 8080/UDP by default)
 *   - per-session handshake validation
 *   - the single coordinator-link slot (rejects a second concurrent
 *     coordinator)
 *
 * It does NOT own:
 *   - per-tile WT registration (tiles still use POST /register today; a
 *     future ticket can fold tile registration into the same WT
 *     handshake)
 *   - event/command routing — T-139 builds that on top.
 */

import { encodeFrame, makeFrameReader } from "@voxim/protocol";
import type { ServiceHandshake, ServiceHandshakeAck } from "@voxim/protocol";

export interface WtServerConfig {
  port: number;
  cert: string;
  key: string;
  serviceSecret: string;
  onCoordinatorConnected?: (link: CoordinatorLink) => void;
  onCoordinatorDisconnected?: () => void;
}

export interface CoordinatorLink {
  /** Send one length-prefixed JSON frame to the coordinator. */
  send(value: unknown): Promise<void>;
  /** Read the next length-prefixed JSON frame from the coordinator. */
  recv(): Promise<unknown | null>;
  /** Close the underlying stream. */
  close(): void;
}

export class WtServer {
  private coordinatorLink: CoordinatorLink | null = null;

  constructor(private readonly config: WtServerConfig) {}

  /** True if a coordinator is currently linked. */
  get hasCoordinator(): boolean {
    return this.coordinatorLink !== null;
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

    // Read the first bidirectional stream — that's the handshake.
    const streamReader = session.incomingBidirectionalStreams.getReader();
    const { value: stream, done } = await streamReader.read();
    if (done || !stream) {
      console.warn("[Gateway] WT session closed before handshake");
      session.close();
      return;
    }

    const bidi = stream as WebTransportBidirectionalStream;
    const writer = bidi.writable.getWriter();
    const readerInner = bidi.readable.getReader();
    const frames = makeFrameReader(readerInner);

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
      if (this.coordinatorLink) {
        await this.sendAck(writer, { type: "service_handshake_ack", ok: false, reason: "coordinator already connected" });
        session.close({ closeCode: 3, reason: "duplicate coordinator" });
        return;
      }
      const link: CoordinatorLink = {
        send: async (value) => {
          await writer.write(encodeFrame(value));
        },
        recv: async () => await frames.readJson(),
        close: () => session.close(),
      };
      this.coordinatorLink = link;
      await this.sendAck(writer, { type: "service_handshake_ack", ok: true });
      console.log("[Gateway] coordinator connected");
      this.config.onCoordinatorConnected?.(link);

      // Wire teardown: when the WT session closes, drop the slot.
      session.closed
        .catch(() => {/* normal close throws on some Deno versions */})
        .finally(() => {
          if (this.coordinatorLink === link) {
            this.coordinatorLink = null;
            this.config.onCoordinatorDisconnected?.();
            console.log("[Gateway] coordinator disconnected");
          }
        });
      return;
    }

    if (handshake.kind === "tile") {
      // T-139 will route tile event frames here. For now we only accept
      // the handshake so a future tile WT migration can begin without
      // gateway changes; the stream is left open but no frames are
      // consumed.
      await this.sendAck(writer, { type: "service_handshake_ack", ok: true });
      console.log(`[Gateway] tile WT stream connected: ${handshake.id ?? "(no id)"}`);
      return;
    }

    await this.sendAck(writer, { type: "service_handshake_ack", ok: false, reason: `unknown kind: ${(handshake as { kind?: string }).kind}` });
    session.close({ closeCode: 4, reason: "bad kind" });
  }

  private async sendAck(writer: WritableStreamDefaultWriter<Uint8Array>, ack: ServiceHandshakeAck): Promise<void> {
    try {
      await writer.write(encodeFrame(ack));
    } catch {
      // Peer may have closed already — ignore.
    }
  }
}
