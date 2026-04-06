/**
 * Low-level binary codec helpers.
 *
 * All codecs use little-endian byte order and DataView for portability.
 * No external dependencies — satisfies the Serialiser interface with a custom
 * binary format that is the natural upgrade path from protobuf per the spec.
 */

// ---- primitives ----

export function encodeF64(value: number): Uint8Array {
  const buf = new ArrayBuffer(8);
  new DataView(buf).setFloat64(0, value, true);
  return new Uint8Array(buf);
}

export function decodeF64(bytes: Uint8Array, offset = 0): number {
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 8).getFloat64(0, true);
}

export function encodeF32(value: number): Uint8Array {
  const buf = new ArrayBuffer(4);
  new DataView(buf).setFloat32(0, value, true);
  return new Uint8Array(buf);
}

export function decodeF32(bytes: Uint8Array, offset = 0): number {
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getFloat32(0, true);
}

export function encodeI32(value: number): Uint8Array {
  const buf = new ArrayBuffer(4);
  new DataView(buf).setInt32(0, value, true);
  return new Uint8Array(buf);
}

export function decodeI32(bytes: Uint8Array, offset = 0): number {
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getInt32(0, true);
}

// ---- codec builder ----

/**
 * Build a Serialiser<T> by describing how to read and write each field
 * into a fixed-size buffer. Simpler than a general schema system for the
 * small number of component types we have.
 */
export interface FieldSpec {
  type: "f32" | "f64" | "i32";
}

export type Schema<T> = { [K in keyof T]: FieldSpec };

const SIZES: Record<FieldSpec["type"], number> = { f32: 4, f64: 8, i32: 4 };

// deno-lint-ignore no-explicit-any
export function buildCodec<T extends Record<string, any>>(
  schema: Schema<T>,
): { encode(data: T): Uint8Array; decode(bytes: Uint8Array): T } {
  const keys = Object.keys(schema) as (keyof T)[];
  const totalBytes = keys.reduce((sum, k) => sum + SIZES[schema[k].type], 0);

  return {
    encode(data: T): Uint8Array {
      const buf = new ArrayBuffer(totalBytes);
      const view = new DataView(buf);
      let offset = 0;
      for (const key of keys) {
        const spec = schema[key];
        const val = data[key] as number;
        if (spec.type === "f64") {
          view.setFloat64(offset, val, true);
          offset += 8;
        } else if (spec.type === "f32") {
          view.setFloat32(offset, val, true);
          offset += 4;
        } else {
          view.setInt32(offset, val, true);
          offset += 4;
        }
      }
      return new Uint8Array(buf);
    },

    decode(bytes: Uint8Array): T {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const result: Partial<T> = {};
      let offset = 0;
      for (const key of keys) {
        const spec = schema[key];
        if (spec.type === "f64") {
          result[key] = view.getFloat64(offset, true) as T[keyof T];
          offset += 8;
        } else if (spec.type === "f32") {
          result[key] = view.getFloat32(offset, true) as T[keyof T];
          offset += 4;
        } else {
          result[key] = view.getInt32(offset, true) as T[keyof T];
          offset += 4;
        }
      }
      return result as T;
    },
  };
}
