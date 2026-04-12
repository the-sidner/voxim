/// <reference path="./types/webtransport.d.ts" />
import type { EntityId } from "@voxim/engine";
import type { CommandPayload } from "@voxim/protocol";
import { decodeDatagram, worldSnapshotCodec, contentRequestCodec, contentResponseCodec, makeFrameReader } from "@voxim/protocol";
import type { WorldSnapshot, ContentRequest, ContentResponse } from "@voxim/protocol";
import type { ContentStore } from "@voxim/content";
import { InputRingBuffer } from "./input_buffer.ts";

/**
 * Per-connection state for one connected client.
 *
 * Three concurrent activities:
 *   1. receiveInputs()  — reads datagrams, routes to inputBuffer (movement) or commandQueue (commands)
 *   2. sendState()      — called by tick loop, reliable unidirectional stream
 *   3. sendSnapshot()   — called by tick loop, unreliable datagram
 *   4. serveContent()   — serves the client-opened content bidi stream
 */
export class ClientSession {
  readonly playerId: EntityId;
  readonly inputBuffer: InputRingBuffer;

  /**
   * Commands received this session since the last tick drain.
   * The tick loop drains this each tick to build the pendingCommands TickContext entry.
   * Commands are appended in arrival order; the server processes them in order.
   */
  readonly commandQueue: CommandPayload[] = [];

  /** Entities this session currently knows about — used for AoI spawn/despawn tracking. */
  readonly knownEntities: Set<EntityId> = new Set();

  /**
   * Exponential moving average of round-trip time in milliseconds.
   * Updated on every received MovementDatagram via updateRtt().
   * Written into InputState.rttMs each tick so any system can read it.
   */
  rttMs = 0;

  private outWriter:      WritableStreamDefaultWriter<Uint8Array> | null = null;
  private datagramWriter: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private _closed = false;
  /** Serialised write queue — ensures chunks from consecutive messages never interleave. */
  private _writeQueue: Promise<void> = Promise.resolve();

  constructor(playerId: EntityId) {
    this.playerId = playerId;
    this.inputBuffer = new InputRingBuffer();
  }

  /**
   * Attach the server-opened unidirectional stream (reliable state channel).
   * Called once, immediately after session.createUnidirectionalStream() resolves.
   */
  attachOutputStream(stream: WritableStream<Uint8Array>): void {
    this.outWriter = stream.getWriter();
  }

  /**
   * Attach the WebTransport session's datagram writer (unreliable snapshot channel).
   * Called once during handleSession setup.
   */
  attachDatagramWriter(writer: WritableStreamDefaultWriter<Uint8Array>): void {
    this.datagramWriter = writer;
  }

  /**
   * Update the RTT estimate with a new sample using exponential moving average.
   * Called by the tick loop after draining the input buffer.
   * alpha: weight of the new sample (0–1). Lower = smoother, slower to react.
   */
  updateRtt(sampleMs: number, alpha: number): void {
    this.rttMs = this.rttMs === 0
      ? sampleMs                                      // cold start: accept first sample directly
      : alpha * sampleMs + (1 - alpha) * this.rttMs;
  }

  // ── receive ──────────────────────────────────────────────────────────────

  /**
   * Concurrent datagram receiver — reads datagrams from the WebTransport session
   * and routes them by type:
   *   - MovementDatagram (type=1) → inputBuffer (ring buffer, latest-wins)
   *   - CommandDatagram  (type=2) → commandQueue (ordered, drained each tick)
   *   - Unknown type              → silently discarded
   */
  async receiveInputs(session: WebTransportSession): Promise<void> {
    const reader = (session.datagrams.readable as ReadableStream<Uint8Array>).getReader();
    try {
      while (!this._closed) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value || value.byteLength === 0) continue;
        try {
          const decoded = decodeDatagram(value);
          if (decoded.kind === "movement") {
            this.inputBuffer.push(decoded.data);
          } else if (decoded.kind === "command") {
            this.commandQueue.push(decoded.data.command);
          }
          // decoded.kind === "unknown" is silently discarded
        } catch {
          // Malformed datagram — discard silently
        }
      }
    } catch {
      // Connection reset or closed
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * Content stream handler — reads ContentRequests from the client-opened
   * bidi stream and responds with model/material definitions from the store.
   *
   * Long-lived: runs for the lifetime of the session.
   */
  async serveContent(
    stream: { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> },
    content: ContentStore,
  ): Promise<void> {
    const reader = (stream.readable as ReadableStream<Uint8Array>).getReader();
    const writer = (stream.writable as WritableStream<Uint8Array>).getWriter();
    const { readFrame } = makeFrameReader(reader);

    async function readRequest(): Promise<ContentRequest | null> {
      const frame = await readFrame();
      if (!frame) return null;
      try {
        return contentRequestCodec.decode(frame);
      } catch {
        return null;
      }
    }

    try {
      while (!this._closed) {
        const req = await readRequest();
        if (!req) break;

        let resp: ContentResponse;

        if (req.type === "model_req") {
          const def = content.getModel(req.modelId);
          resp = def
            ? { type: "model_def", modelId: req.modelId, version: def.version, def }
            : { type: "not_found", id: req.modelId };
        } else if (req.type === "material_req") {
          const def = content.getMaterial(req.materialId);
          resp = def
            ? { type: "material_def", materialId: req.materialId, def }
            : { type: "not_found", id: String(req.materialId) };
        } else {
          // skeleton_req
          const def = content.getSkeleton(req.skeletonId);
          resp = def
            ? { type: "skeleton_def", skeletonId: req.skeletonId, def }
            : { type: "not_found", id: req.skeletonId };
        }

        try {
          await writer.write(contentResponseCodec.encode(resp));
        } catch {
          break;
        }
      }
    } finally {
      reader.releaseLock();
      writer.releaseLock();
    }
  }

  // ── send ─────────────────────────────────────────────────────────────────

  /**
   * Send a WorldSnapshot as an unreliable datagram.
   * Fire-and-forget — loss is acceptable; the next tick supersedes this one.
   */
  sendSnapshot(snap: WorldSnapshot): void {
    if (this._closed || !this.datagramWriter) return;
    try {
      this.datagramWriter.write(worldSnapshotCodec.encode(snap)).catch(() => {});
    } catch {
      // Datagram writer gone — session likely closing
    }
  }

  /**
   * Send pre-encoded state bytes over the reliable unidirectional stream.
   *
   * Writes are chunked at 64 KiB and serialised through _writeQueue so that
   * QUIC flow-control back-pressure is respected: a large initial spawn (e.g.
   * terrain heightmap ≈ 1.6 MB) previously caused a deadlock because a single
   * writer.write(1.6MB) filled the QUIC send window while the receiver was
   * still waiting for its first reader.read() to resolve.
   */
  private static readonly CHUNK_SIZE = 65536;

  sendStateRaw(bytes: Uint8Array): void {
    if (this._closed || !this.outWriter) return;
    const writer = this.outWriter;
    const chunk = ClientSession.CHUNK_SIZE;
    this._writeQueue = this._writeQueue.then(async () => {
      if (this._closed) return;
      for (let i = 0; i < bytes.byteLength; i += chunk) {
        await writer.write(bytes.subarray(i, Math.min(i + chunk, bytes.byteLength)));
      }
    }).catch((err) => {
      console.error(`[Session] ${this.playerId.slice(-8)}: write failed, closing session —`, err);
      this._closed = true;
    });
  }

  close(): void {
    this._closed = true;
    if (this.outWriter) {
      this.outWriter.close().catch(() => {});
      this.outWriter = null;
    }
    if (this.datagramWriter) {
      this.datagramWriter.releaseLock();
      this.datagramWriter = null;
    }
  }

  get isOpen(): boolean {
    return !this._closed;
  }
}
