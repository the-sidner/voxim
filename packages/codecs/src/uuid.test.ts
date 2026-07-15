import { assertEquals, assert } from "jsr:@std/assert";
import { uuidToBytes, bytesToUuid } from "./uuid.ts";

Deno.test("uuidToBytes ↔ bytesToUuid roundtrip", () => {
  const uuid = "01234567-89ab-cdef-0123-456789abcdef";
  const bytes = uuidToBytes(uuid);
  assertEquals(bytes.length, 16);
  assertEquals(
    Array.from(bytes),
    [0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef, 0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef],
  );
  assertEquals(bytesToUuid(bytes, 0), uuid);
});

Deno.test("uuidToBytes decodes uppercase hex", () => {
  assertEquals(
    Array.from(uuidToBytes("FFEEDDCC-BBAA-9988-7766-554433221100")),
    [0xff, 0xee, 0xdd, 0xcc, 0xbb, 0xaa, 0x99, 0x88, 0x77, 0x66, 0x55, 0x44, 0x33, 0x22, 0x11, 0x00],
  );
});

Deno.test("uuidToBytes handles random crypto uuids at an offset", () => {
  for (let i = 0; i < 100; i++) {
    const uuid = crypto.randomUUID();
    const buf = new Uint8Array(40);
    buf.set(uuidToBytes(uuid), 7);
    assertEquals(bytesToUuid(buf, 7), uuid);
  }
});

Deno.test("uuidToBytes returns the shared cached instance on repeat calls", () => {
  const uuid = crypto.randomUUID();
  const first = uuidToBytes(uuid);
  assert(uuidToBytes(uuid) === first, "second call must be a cache hit");
});
