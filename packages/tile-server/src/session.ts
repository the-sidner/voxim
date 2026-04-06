/// <reference path="./types/webtransport.d.ts" />
import type { EntityId } from "@voxim/engine";
import { InputRingBuffer } from "./input_buffer.ts";
import { inputDatagramCodec } from "./codec/input.ts";
import { worldSnapshotCodec, contentRequestCodec, contentResponseCodec } from "@voxim/protocol";
import type { WorldSnapshot, ContentRequest, ContentResponse } from "@voxim/protocol";
import type { ContentStore } from "@voxim/content";

/**
 * Per-connection state for one connected client.
 *
 * Three concurrent activities:
 *   1. receiveInputs()  — reads input datagrams, pushes to inputBuffer
 *   2. sendState()      — called by tick loop, reliable unidirectional stream
 *   3. sendSnapshot()   — called by tick loop, unreliable datagram
 *   4. serveContent()   — serves the client-opened content bidi stream
 */
export class ClientSession {
  readonly playerId: EntityId;
  readonly inputBuffer: InputRingBuffer;
  /** Entities this session currently knows about — used for AoI spawn/despawn tracking. */
  readonly knownEntities: Set<EntityId> = new Set();

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

  // ── receive ──────────────────────────────────────────────────────────────

  /**
   * Concurrent input receiver — reads datagrams from the WebTransport session
   * and pushes them to the input ring buffer.
   */
  async receiveInputs(session: WebTransportSession): Promise<void> {
    const reader = (session.datagrams.readable as ReadableStream<Uint8Array>).getReader();
    try {
      while (!this._closed) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value || value.byteLength < 36) continue;
        try {
          this.inputBuffer.push(inputDatagramCodec.decode(value));
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

    async function readRequest(): Promise<ContentRequest | null> {
      const header = await readExact(4);
      if (!header) return null;
      const len = new DataView(header.buffer).getUint32(0, true);
      const payload = await readExact(len);
      if (!payload) return null;
      try {
        return contentRequestCodec.decode(new Uint8Array([...header, ...payload]));
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
    }).catch(() => { this._closed = true; });
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
