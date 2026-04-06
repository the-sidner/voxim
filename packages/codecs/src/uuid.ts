/**
 * UUID ↔ bytes helpers for the wire protocol.
 *
 * UUIDs on the wire are 16 raw bytes in hex-pair order (no dashes).
 */

/** Convert UUID string "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" to 16-byte Uint8Array */
export function uuidToBytes(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, "");
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
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
