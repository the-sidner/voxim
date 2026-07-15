/**
 * UUID ↔ bytes helpers for the wire protocol.
 *
 * UUIDs on the wire are 16 raw bytes in hex-pair order (no dashes).
 *
 * uuidToBytes is the hottest string in the server's send path — one call per
 * delta / spawn / removal / destroy / event field per session per tick, plus
 * one per WorldSnapshot entity per page. Two things keep it cheap:
 *
 *   1. Nibble decoding is charCode arithmetic through a precomputed table —
 *      no regex, no substring allocation, no parseInt.
 *   2. The 16-byte encoding is cached per uuid string. Entity ids are
 *      long-lived, so steady-state cost is one Map hit. The cache is bounded
 *      (cleared wholesale past MAX_CACHE) so churning short-lived ids
 *      (projectiles, dropped items) can't grow it forever.
 *
 * The returned Uint8Array is the SHARED cached instance — callers must copy
 * from it (u8.set / writeBytes), never mutate it. Both wire call sites do.
 */

/** charCode → hex nibble value; -1 for non-hex characters. */
const HEX_NIBBLE = new Int8Array(128).fill(-1);
for (let i = 0; i < 10; i++) HEX_NIBBLE[0x30 + i] = i; // '0'-'9'
for (let i = 0; i < 6; i++) {
  HEX_NIBBLE[0x61 + i] = 10 + i; // 'a'-'f'
  HEX_NIBBLE[0x41 + i] = 10 + i; // 'A'-'F'
}

const cache = new Map<string, Uint8Array>();
const MAX_CACHE = 16384;

/**
 * Convert UUID string "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" to 16 bytes.
 * Returns a shared cached array — treat as immutable, copy before storing.
 */
export function uuidToBytes(uuid: string): Uint8Array {
  const hit = cache.get(uuid);
  if (hit) return hit;

  const bytes = new Uint8Array(16);
  let bi = 0;
  for (let i = 0; i < uuid.length && bi < 16; i++) {
    const c0 = uuid.charCodeAt(i);
    if (c0 === 0x2d) continue; // '-'
    const hi = HEX_NIBBLE[c0 & 0x7f];
    const lo = HEX_NIBBLE[uuid.charCodeAt(++i) & 0x7f];
    bytes[bi++] = (hi << 4) | lo;
  }

  if (cache.size >= MAX_CACHE) cache.clear();
  cache.set(uuid, bytes);
  return bytes;
}

/** Convert 16 bytes at 'offset' within 'bytes' back to UUID string */
export function bytesToUuid(bytes: Uint8Array, offset: number): string {
  const h = (n: number) => bytes[offset + n].toString(16).padStart(2, "0");
  return (
    h(0) + h(1) + h(2) + h(3) + "-" +
    h(4) + h(5) + "-" +
    h(6) + h(7) + "-" +
    h(8) + h(9) + "-" +
    h(10) + h(11) + h(12) + h(13) + h(14) + h(15)
  );
}
