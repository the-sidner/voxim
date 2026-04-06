/**
 * WireWriter / WireReader — low-level binary codec primitives.
 *
 * All multi-byte values are little-endian.
 * String layout  : [u16 byteLength][UTF-8 bytes]
 * Nullable layout: [u8 present (0|1)][value if present]
 * Array layout   : [u16 count][elements...]
 * UUID layout    : 16 raw bytes in hex-pair order (no dashes)
 */

import { uuidToBytes, bytesToUuid } from "./uuid.ts";

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

// ---------------------------------------------------------------------------
// WireWriter
// ---------------------------------------------------------------------------

/** Dynamically-growing binary writer. Starts at 256 bytes, doubles when full. */
export class WireWriter {
  private buf: ArrayBuffer;
  private view: DataView;
  private u8: Uint8Array;
  private pos: number;

  constructor() {
    this.buf  = new ArrayBuffer(256);
    this.view = new DataView(this.buf);
    this.u8   = new Uint8Array(this.buf);
    this.pos  = 0;
  }

  // -- internal helpers --

  private ensure(n: number): void {
    if (this.pos + n <= this.buf.byteLength) return;
    let newSize = this.buf.byteLength;
    while (newSize < this.pos + n) newSize *= 2;
    const next = new ArrayBuffer(newSize);
    new Uint8Array(next).set(this.u8);
    this.buf  = next;
    this.view = new DataView(this.buf);
    this.u8   = new Uint8Array(this.buf);
  }

  // -- write methods --

  writeU8(v: number): void {
    this.ensure(1);
    this.view.setUint8(this.pos, v);
    this.pos += 1;
  }

  writeU16(v: number): void {
    this.ensure(2);
    this.view.setUint16(this.pos, v, true);
    this.pos += 2;
  }

  writeU32(v: number): void {
    this.ensure(4);
    this.view.setUint32(this.pos, v >>> 0, true);
    this.pos += 4;
  }

  writeI32(v: number): void {
    this.ensure(4);
    this.view.setInt32(this.pos, v, true);
    this.pos += 4;
  }

  writeF32(v: number): void {
    this.ensure(4);
    this.view.setFloat32(this.pos, v, true);
    this.pos += 4;
  }

  writeF64(v: number): void {
    this.ensure(8);
    this.view.setFloat64(this.pos, v, true);
    this.pos += 8;
  }

  /** [u16 byteLength][UTF-8 bytes] */
  writeStr(s: string): void {
    const encoded = TEXT_ENCODER.encode(s);
    this.writeU16(encoded.byteLength);
    this.writeBytes(encoded);
  }

  /** Raw bytes — no length prefix. */
  writeBytes(b: Uint8Array): void {
    this.ensure(b.byteLength);
    this.u8.set(b, this.pos);
    this.pos += b.byteLength;
  }

  /** 16 raw bytes from uuidToBytes. */
  writeUuid(uuid: string): void {
    this.writeBytes(uuidToBytes(uuid));
  }

  /** Returns exactly the written bytes (not the full internal buffer). */
  toBytes(): Uint8Array {
    return this.u8.slice(0, this.pos);
  }
}

// ---------------------------------------------------------------------------
// WireReader
// ---------------------------------------------------------------------------

/** Cursor-based reader that wraps an existing Uint8Array. */
export class WireReader {
  private readonly view: DataView;
  private readonly u8: Uint8Array;
  private pos: number;

  constructor(bytes: Uint8Array) {
    this.u8   = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.pos  = 0;
  }

  // -- cursor --

  get offset(): number { return this.pos; }
  get done(): boolean  { return this.pos >= this.u8.byteLength; }

  // -- read methods --

  readU8(): number {
    const v = this.view.getUint8(this.pos);
    this.pos += 1;
    return v;
  }

  readU16(): number {
    const v = this.view.getUint16(this.pos, true);
    this.pos += 2;
    return v;
  }

  readU32(): number {
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }

  readI32(): number {
    const v = this.view.getInt32(this.pos, true);
    this.pos += 4;
    return v;
  }

  readF32(): number {
    const v = this.view.getFloat32(this.pos, true);
    this.pos += 4;
    return v;
  }

  readF64(): number {
    const v = this.view.getFloat64(this.pos, true);
    this.pos += 8;
    return v;
  }

  /** Reads [u16 byteLength][UTF-8 bytes] */
  readStr(): string {
    const len = this.readU16();
    return TEXT_DECODER.decode(this.readBytes(len));
  }

  /** Reads exactly n bytes, advancing the cursor. */
  readBytes(n: number): Uint8Array {
    const slice = this.u8.subarray(this.pos, this.pos + n);
    this.pos += n;
    return slice;
  }

  /** Reads 16 bytes and returns a UUID string. */
  readUuid(): string {
    const start = this.pos;
    this.pos += 16;
    return bytesToUuid(this.u8, start);
  }
}
