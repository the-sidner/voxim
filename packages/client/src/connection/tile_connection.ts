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
  InputDatagram, BinaryStateMessage, TileJoinRequest, TileJoinAck,
  WorldSnapshot, ContentRequest, ContentResponse,
} from "@voxim/protocol";
import {
  inputDatagramCodec, binaryStateMessageCodec,
  worldSnapshotCodec, contentRequestCodec, contentResponseCodec,
} from "@voxim/protocol";

const enc = new TextEncoder();
const dec = new TextDecoder();

function encodeMessage(value: unknown): Uint8Array {
  const payload = enc.encode(JSON.stringify(value));
  const out = new Uint8Array(4 + payload.byteLength);
  new DataView(out.buffer).setUint32(0, payload.byteLength, true);
  out.set(payload, 4);
  return out;
}

/**
 * Creates a stateful reader that handles chunk boundaries correctly.
 * reader.read() may deliver more bytes than requested in one chunk;
 * leftovers are kept in a closure and prepended to the next read.
 */
function makeMessageReader(reader: ReadableStreamDefaultReader<Uint8Array>) {
  let overflow: Uint8Array | null = null;

  async function readExact(n: number): Promise<Uint8Array | null> {
    const buf = new Uint8Array(n);
    let offset = 0;

    if (overflow) {
      const take = Math.min(overflow.byteLength, n);
      buf.set(overflow.subarray(0, take), 0);
      offset = take;
      overflow = overflow.byteLength > take ? overflow.subarray(take) : null;
    }

    while (offset < n) {
      const { value, done } = await reader.read();
      if (done || !value) return null;
      const take = Math.min(value.byteLength, n - offset);
      buf.set(value.subarray(0, take), offset);
      offset += take;
      if (value.byteLength > take) overflow = value.subarray(take);
    }
    return buf;
  }

  /** Read the next length-prefixed JSON message. */
  async function readMessage(): Promise<unknown | null> {
    const header = await readExact(4);
    if (!header) return null;
    const len = new DataView(header.buffer).getUint32(0, true);
    const payload = await readExact(len);
    if (!payload) return null;
    return JSON.parse(dec.decode(payload));
  }

  /** Read the next length-prefixed frame as raw bytes (header+payload combined). */
  async function readFrame(): Promise<Uint8Array | null> {
    const header = await readExact(4);
    if (!header) return null;
    const len = new DataView(header.buffer).getUint32(0, true);
    const payload = await readExact(len);
    if (!payload) return null;
    const full = new Uint8Array(4 + len);
    full.set(header, 0);
    full.set(payload, 4);
    return full;
  }

  /** Read the next length-prefixed frame's payload bytes only (no header). */
  async function readPayload(): Promise<Uint8Array | null> {
    const header = await readExact(4);
    if (!header) return null;
    const len = new DataView(header.buffer).getUint32(0, true);
    return readExact(len);
  }

  return { readMessage, readFrame, readPayload };
}

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
   * @param playerId     The player ID assigned by the gateway (for handoff reconnects).
   * @param certHashHex  SHA-256 fingerprint (hex) of the server TLS cert — required for
   *                     self-signed certs (dev/demo). Omit when the cert is CA-signed.
   * @returns            The canonical player ID assigned by the tile server.
   */
  async connect(tileAddress: string, playerId?: string, certHashHex?: string): Promise<string> {
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
    const msgReader = makeMessageReader(jReader);

    const req: TileJoinRequest = { type: "join", ...(playerId ? { playerId } : {}) };
    await jWriter.write(encodeMessage(req));
    jWriter.close().catch(() => {}); // signal FIN without blocking on remote ACK

    const ack = await msgReader.readMessage() as TileJoinAck | null;
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

  sendInput(input: InputDatagram): void {
    if (!this.datagramWriter) return;
    this.datagramWriter.write(inputDatagramCodec.encode(input)).catch(() => {});
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
    const { readFrame } = makeMessageReader(reader);
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
    const { readPayload } = makeMessageReader(reader);
    try {
      while (true) {
        const payload = await readPayload();
        if (!payload) break;
        try {
          this.onStateMessage?.(binaryStateMessageCodec.decode(payload));
        } catch (err) {
          console.error("[TileConn] state decode error:", err);
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
