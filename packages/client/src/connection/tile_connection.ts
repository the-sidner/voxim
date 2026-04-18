/// <reference lib="dom" />
/**
 * Tile server connection.
 *
 * Join handshake (on connect):
 *   1. Client opens a bidirectional stream and sends TileJoinRequest (length-prefixed JSON).
 *   2. Server responds with TileJoinAck containing the canonical playerId.
 *   3. Server opens a unidirectional stream (server → client) for state messages.
 *   4. Client sends input as unreliable datagrams.
 */
import type {
  MovementDatagram, CommandDatagram, BinaryStateMessage, TileJoinRequest, TileJoinAck,
  WorldSnapshot, ContentRequest, ContentResponse,
} from "@voxim/protocol";
import {
  movementDatagramCodec, commandDatagramCodec, binaryStateMessageCodec,
  worldSnapshotCodec, contentRequestCodec, contentResponseCodec,
  encodeFrame, makeFrameReader,
} from "@voxim/protocol";

export class TileConnection {
  private transport: WebTransport | null = null;
  private datagramWriter: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private contentWriter: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private contentResolvers: Array<(resp: ContentResponse) => void> = [];

  onStateMessage: ((msg: BinaryStateMessage) => void) | null = null;
  onSnapshot:     ((snap: WorldSnapshot) => void) | null = null;
  onClose:        (() => void) | null = null;

  /**
   * Connect to the tile server and perform the join handshake.
   *
   * @param tileAddress  "hostname:port" as returned by the gateway.
   * @param playerId     The player ID (== userId) assigned by the gateway.
   * @param token        Session token. Tile server re-validates it against
   *                     the gateway before accepting the join.
   * @param certHashHex  SHA-256 fingerprint (hex) of the server TLS cert —
   *                     required for self-signed certs (dev/demo). Omit when
   *                     the cert is CA-signed.
   * @returns            The canonical player ID assigned by the tile server.
   */
  async connect(tileAddress: string, playerId: string, token: string, certHashHex?: string): Promise<string> {
    // deno-lint-ignore no-explicit-any
    const options: Record<string, any> = {};
    if (certHashHex) {
      const hashBytes = Uint8Array.from(
        certHashHex.match(/../g)!.map((h) => parseInt(h, 16)),
      );
      options.serverCertificateHashes = [{ algorithm: "sha-256", value: hashBytes.buffer }];
    }
    this.transport = new WebTransport(`https://${tileAddress}`, options);
    await this.transport.ready;

    // --- join handshake ---
    // Start accepting the server's incoming unidirectional stream BEFORE reading the
    // ack to ensure Chrome's QUIC receive loop stays unblocked while we wait.
    const stateStreamPromise = this.transport.incomingUnidirectionalStreams.getReader().read();

    const joinStream = await this.transport.createBidirectionalStream();
    const jWriter = joinStream.writable.getWriter();
    const jReader = joinStream.readable.getReader();

    const req: TileJoinRequest = { type: "join", playerId, token };
    await jWriter.write(encodeFrame(req));
    jWriter.close().catch(() => {}); // signal FIN without blocking on remote ACK

    const ack = await makeFrameReader(jReader).readJson() as TileJoinAck | null;
    jReader.releaseLock();

    if (!ack || ack.type !== "joined") {
      throw new Error("Tile server join handshake failed");
    }

    // --- datagram writer for input (C→S) ---
    this.datagramWriter = this.transport.datagrams.writable.getWriter();

    // --- snapshot receiver (S→C datagrams) ---
    this.receiveSnapshots().catch(() => {});

    // --- state message receiver (use the already-started read) ---
    this.receiveStatesFromPromise(stateStreamPromise).catch((err) => {
      console.error("[TileConnection] receive error", err);
      this.onClose?.();
    });

    // --- content bidi stream (client-opened, long-lived) ---
    const contentStream = await this.transport.createBidirectionalStream();
    this.contentWriter = contentStream.writable.getWriter();
    this.drainContentStream(contentStream.readable).catch(() => {});

    return ack.playerId;
  }

  sendMovement(datagram: MovementDatagram): void {
    if (!this.datagramWriter) return;
    this.datagramWriter.write(movementDatagramCodec.encode(datagram)).catch(() => {});
  }

  sendCommand(datagram: CommandDatagram): void {
    if (!this.datagramWriter) return;
    this.datagramWriter.write(commandDatagramCodec.encode(datagram)).catch(() => {});
  }

  /** Send a content request and return the response (in-order, pipelined). */
  async requestContent(req: ContentRequest): Promise<ContentResponse> {
    if (!this.contentWriter) throw new Error("Content stream not open");
    return new Promise((resolve) => {
      this.contentResolvers.push(resolve);
      this.contentWriter!.write(contentRequestCodec.encode(req)).catch(() => {});
    });
  }

  private async receiveSnapshots(): Promise<void> {
    if (!this.transport) return;
    const reader = (this.transport.datagrams.readable as ReadableStream<Uint8Array>).getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done || !value) break;
        try {
          this.onSnapshot?.(worldSnapshotCodec.decode(value));
        } catch {
          // Malformed datagram — discard
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  private async drainContentStream(stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stream.getReader();
    const { readFrame } = makeFrameReader(reader);
    try {
      while (true) {
        const frame = await readFrame();
        if (!frame) break;
        try {
          const resp = contentResponseCodec.decode(frame);
          this.contentResolvers.shift()?.(resp);
        } catch {
          // Malformed — skip
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  private async receiveStatesFromPromise(
    streamPromise: Promise<ReadableStreamReadResult<unknown>>,
  ): Promise<void> {
    const { value: stream, done } = await streamPromise;
    if (done || !stream) return;
    await this.drainStateStream(stream as ReadableStream<Uint8Array>);
  }

  private async drainStateStream(stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stream.getReader();
    const { readPayload } = makeFrameReader(reader);
    let msgCount = 0;
    try {
      while (true) {
        const payload = await readPayload();
        if (!payload) { console.log(`[TileConn] state stream ended after ${msgCount} messages`); break; }
        msgCount++;
        try {
          this.onStateMessage?.(binaryStateMessageCodec.decode(payload));
        } catch (err) {
          console.error(`[TileConn] state decode error on msg #${msgCount}:`, err);
        }
      }
    } finally {
      reader.releaseLock();
      this.onClose?.();
    }
  }

  close(): void {
    this.datagramWriter?.close().catch(() => {});
    this.contentWriter?.close().catch(() => {});
    this.transport?.close();
    this.transport = null;
    this.datagramWriter = null;
    this.contentWriter = null;
    this.contentResolvers = [];
  }
}
