/// <reference lib="dom" />
/**
 * Tile server connection.
 *
 * Join handshake (on connect):
 *   1. Client opens a bidirectional stream and sends TileJoinRequest (length-prefixed JSON).
 *   2. Server responds with TileJoinAck containing the canonical playerId.
 *   3. Server opens a unidirectional stream (server → client) for state messages.
 *   4. Client opens a content bidi stream and a command bidi stream.
 *   5. Client sends movement as unreliable datagrams; discrete commands go on
 *      the reliable command stream (T-273 — datagrams dropped commands under load).
 */
import type {
  MovementDatagram, CommandDatagram, BinaryStateMessage, BootstrapHeader, TileJoinRequest, TileJoinAck,
  WorldSnapshot, ContentRequest, ContentResponse,
} from "@voxim/protocol";
import {
  movementDatagramCodec, commandDatagramCodec, binaryStateMessageCodec,
  worldSnapshotCodec, contentRequestCodec, contentResponseCodec,
  encodeFrame, makeFrameReader,
} from "@voxim/protocol";

/**
 * Character-creation selections (T-071) sent in the join handshake for a fresh
 * spawn. Mirror of the optional `TileJoinRequest` fields — the server is
 * authoritative and validates both against content.
 */
export interface CharacterCreation {
  speciesId: string;
  initialFragmentIds: string[];
}

export class TileConnection {
  private transport: WebTransport | null = null;
  private datagramWriter: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private contentWriter: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private commandWriter: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private contentResolvers: Array<(resp: ContentResponse) => void> = [];

  onStateMessage: ((msg: BinaryStateMessage) => void) | null = null;
  onSnapshot:     ((snap: WorldSnapshot) => void) | null = null;
  onClose:        (() => void) | null = null;

  /**
   * Bootstrap blob received on the join stream after TileJoinAck (T-177).
   * Decoded by BootstrapSource.load() into a ContentService once the
   * handshake completes. Stored as raw bytes here so the connection layer
   * stays content-agnostic — the game-init code performs the decode.
   */
  private _bootstrapBlob: Uint8Array | null = null;
  bootstrapBlob(): Uint8Array | null { return this._bootstrapBlob; }

  /**
   * Drain-style counters for the HUD diagnostic panel.  Incremented by
   * the state-stream loop; the FPS-window sampler reads + zeroes them
   * via `drainNetStats()` once per ~500 ms so it can compute kbps and
   * tick rate.
   */
  private _stateBytesIn   = 0;
  private _stateMsgsIn    = 0;

  /**
   * Connect to the tile server and perform the join handshake.
   *
   * @param tileAddress  "hostname:port" as returned by the gateway.
   * @param playerId     The player ID (== userId) assigned by the gateway.
   * @param token        Session token. Tile server re-validates it against
   *                     the gateway before accepting the join.
   * @param displayName  Optional login label shipped in the join request and
   *                     written to the player entity's `Name` component.
   *                     Empty / undefined → server falls back to a
   *                     playerId-derived stub.
   * @param certHashHex  SHA-256 fingerprint (hex) of the server TLS cert —
   *                     required for self-signed certs (dev/demo). Omit when
   *                     the cert is CA-signed.
   * @param creation     Character-creation selections (T-071) for a fresh
   *                     spawn — chosen species + lore. Carried in the join
   *                     handshake; the server validates and falls back to its
   *                     defaults. Omit for an existing character.
   * @returns            The canonical player ID assigned by the tile server.
   */
  async connect(
    tileAddress: string,
    playerId: string,
    token: string,
    displayName: string,
    certHashHex?: string,
    creation?: CharacterCreation,
  ): Promise<string> {
    // deno-lint-ignore no-explicit-any
    const options: Record<string, any> = {};
    if (certHashHex) {
      const hashBytes = Uint8Array.from(
        certHashHex.match(/../g)!.map((h) => parseInt(h, 16)),
      );
      options.serverCertificateHashes = [{ algorithm: "sha-256", value: hashBytes.buffer }];
    }
    console.log(`[TileConn] opening WebTransport → https://${tileAddress} (certHash=${certHashHex ? "yes" : "no"})`);
    this.transport = new WebTransport(`https://${tileAddress}`, options);
    await this.transport.ready;
    console.log("[TileConn] transport ready, sending join request");

    // --- join handshake ---
    // Start accepting the server's incoming unidirectional stream BEFORE reading the
    // ack to ensure Chrome's QUIC receive loop stays unblocked while we wait.
    const stateStreamPromise = this.transport.incomingUnidirectionalStreams.getReader().read();

    const joinStream = await this.transport.createBidirectionalStream();
    const jWriter = joinStream.writable.getWriter();
    const jReader = joinStream.readable.getReader();

    const req: TileJoinRequest = {
      type: "join", playerId, token, displayName,
      ...(creation && {
        speciesId: creation.speciesId,
        initialFragmentIds: creation.initialFragmentIds,
      }),
    };
    await jWriter.write(encodeFrame(req));
    jWriter.close().catch(() => {}); // signal FIN without blocking on remote ACK
    console.log("[TileConn] join sent, awaiting ack");

    // Read the ack and the bootstrap blob from the same stream — server
    // writes both before closing. Frame reader reuses the same buffered
    // reader across both reads, so leftover bytes after readJson don't
    // confuse the second read.
    const frameReader = makeFrameReader(jReader);
    const ack = await frameReader.readJson() as TileJoinAck | null;
    if (!ack || ack.type !== "joined") {
      jReader.releaseLock();
      throw new Error("Tile server join handshake failed");
    }
    console.log(`[TileConn] joined, server-assigned playerId=${ack.playerId.slice(0, 8)}`);

    // Bootstrap blob (T-177) — chunked. Read header announcing chunk count
    // + total size, then concatenate that many binary frames in order.
    const header = await frameReader.readJson() as BootstrapHeader | null;
    if (!header || header.type !== "bootstrap") {
      jReader.releaseLock();
      throw new Error("Tile server handshake missing bootstrap header");
    }
    const blob = new Uint8Array(header.totalBytes);
    let off = 0;
    for (let i = 0; i < header.chunks; i++) {
      const chunk = await frameReader.readPayload();
      if (!chunk) {
        jReader.releaseLock();
        throw new Error(`Tile server bootstrap stream ended at chunk ${i}/${header.chunks}`);
      }
      blob.set(chunk, off);
      off += chunk.byteLength;
    }
    if (off !== header.totalBytes) {
      jReader.releaseLock();
      throw new Error(`Tile server bootstrap size mismatch: expected ${header.totalBytes}, got ${off}`);
    }
    this._bootstrapBlob = blob;
    console.log(`[TileConn] bootstrap blob: ${(blob.length / 1024).toFixed(1)} KB across ${header.chunks} chunk(s)`);
    jReader.releaseLock();

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

    // --- command bidi stream (client-opened, long-lived) ---
    // Discrete commands (equip, trade, place, debug) ride this reliable stream
    // rather than unreliable datagrams (T-273): a dropped equip/trade/place is a
    // visible bug, and datagrams were measured dropping under load. The server
    // accepts incoming bidi streams in open order, so this must follow content.
    const commandStream = await this.transport.createBidirectionalStream();
    this.commandWriter = commandStream.writable.getWriter();

    return ack.playerId;
  }

  sendMovement(datagram: MovementDatagram): void {
    if (!this.datagramWriter) return;
    this.datagramWriter.write(movementDatagramCodec.encode(datagram)).catch(() => {});
  }

  sendCommand(datagram: CommandDatagram): void {
    // Reliable, ordered delivery over the command stream (T-273). The codec's
    // self-describing TLV body is length-prefixed via encodeFrame so the server
    // can frame-read it back; the seq survives for client-side bookkeeping.
    if (!this.commandWriter) return;
    this.commandWriter.write(encodeFrame(commandDatagramCodec.encode(datagram))).catch(() => {});
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
        this._stateBytesIn += payload.byteLength;
        this._stateMsgsIn  += 1;
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

  /**
   * Reads + zeroes the state-stream byte and message counters since
   * the last call. Used by the HUD's FPS-window sampler to derive
   * kbps and tick-rate without retaining a per-frame history.
   */
  drainNetStats(): { bytes: number; messages: number } {
    const out = { bytes: this._stateBytesIn, messages: this._stateMsgsIn };
    this._stateBytesIn = 0;
    this._stateMsgsIn  = 0;
    return out;
  }

  close(): void {
    this.datagramWriter?.close().catch(() => {});
    this.contentWriter?.close().catch(() => {});
    this.commandWriter?.close().catch(() => {});
    this.transport?.close();
    this.transport = null;
    this.datagramWriter = null;
    this.contentWriter = null;
    this.commandWriter = null;
    this.contentResolvers = [];
  }
}
