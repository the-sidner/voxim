/**
 * Synchronous byte-plane run-length encoding for the T-311 per-cell field grids
 * (VegFieldGrid / SurfaceStateGrid). zlib/gzip is RULED OUT: the only compression
 * helper in the repo (bootstrap_codec CompressionStream) is ASYNC, but
 * `Serialiser<T>.encode/decode` are synchronous and called synchronously on the
 * spawn-build (server) and decode (client) hot paths. RLE is sync, zero-dep, and
 * suits these spatially-coherent fields (long runs — canopyLight over a clearing,
 * wetness 0 over dry ground) — they pack to a handful of bytes; the codec adds a
 * raw escape so the worst case is bounded at the plane size.
 *
 * Token stream: [count u8 1..255][value u8], repeated. Runs longer than 255 emit
 * multiple tokens. Framing (raw-vs-rle mode, length) is the caller's job via
 * WireWriter — never roll a custom length prefix.
 */

/** RLE-encode a byte plane into a [count][value] token stream. */
export function rleEncodeU8(plane: Uint8Array): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < plane.length;) {
    const v = plane[i];
    let run = 1;
    while (i + run < plane.length && plane[i + run] === v && run < 255) run++;
    out.push(run, v);
    i += run;
  }
  return new Uint8Array(out);
}

/** Decode a [count][value] token stream back into a fresh `expectedLen` plane. */
export function rleDecodeU8(bytes: Uint8Array, expectedLen: number): Uint8Array {
  const out = new Uint8Array(expectedLen);
  let o = 0;
  for (let i = 0; i + 1 < bytes.length && o < expectedLen; i += 2) {
    const run = bytes[i], v = bytes[i + 1];
    for (let k = 0; k < run && o < expectedLen; k++) out[o++] = v;
  }
  return out;
}
