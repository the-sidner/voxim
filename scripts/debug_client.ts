/**
 * Minimal debug client for the tile server.
 *
 * Connects via WebTransport, performs the join handshake, then prints a
 * one-line summary every server tick-second (every 20 ticks by default).
 * Sends idle input datagrams at 20 Hz so the server sees an active session.
 *
 * Usage:
 *   deno run --allow-net --allow-read --allow-env --unstable-net scripts/debug_client.ts
 *
 * Environment variables (all optional):
 *   SERVER_URL      WebTransport URL            default: https://127.0.0.1:4434
 *   CERT_FILE       Server TLS cert (PEM)       default: ./certs/cert.pem
 *   PRINT_INTERVAL  Print every N ticks         default: 20
 *   VERBOSE         Print every tick if set     (any value)
 */

import type { StateMessage } from "@voxim/protocol";
import type { TileJoinRequest, TileJoinAck } from "@voxim/protocol";
import { inputDatagramCodec } from "@voxim/protocol";

// ── config ───────────────────────────────────────────────────────────────────

const serverUrl     = Deno.env.get("SERVER_URL")      ?? "https://127.0.0.1:4434";
const certFile      = Deno.env.get("CERT_FILE")       ?? "./certs/cert.pem";
const printInterval = parseInt(Deno.env.get("PRINT_INTERVAL") ?? "20");
const verbose       = Deno.env.has("VERBOSE");

// ── helpers ───────────────────────────────────────────────────────────────────

/** Compute SHA-256 fingerprint of a PEM-encoded certificate (DER bytes). */
async function certFingerprint(pemPath: string): Promise<ArrayBuffer> {
  const pem = await Deno.readTextFile(pemPath);
  const b64 = pem.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return await crypto.subtle.digest("SHA-256", der);
}

/** Encode a value as a 4-byte LE length-prefixed JSON message. */
function encodeMsg(value: unknown): Uint8Array {
  const payload = new TextEncoder().encode(JSON.stringify(value));
  const out = new Uint8Array(4 + payload.byteLength);
  new DataView(out.buffer).setUint32(0, payload.byteLength, true);
  out.set(payload, 4);
  return out;
}

/** Read exactly `n` bytes from a ReadableStream reader. */
async function readExact(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  n: number,
): Promise<Uint8Array | null> {
  const buf = new Uint8Array(n);
  let offset = 0;
  while (offset < n) {
    const { value, done } = await reader.read();
    if (done || !value) return null;
    const take = Math.min(value.byteLength, n - offset);
    buf.set(value.subarray(0, take), offset);
    offset += take;
  }
  return buf;
}

/** Read one 4-byte-length-prefixed JSON message. */
async function readMsg(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<unknown | null> {
  const header = await readExact(reader, 4);
  if (!header) return null;
  const len = new DataView(header.buffer).getUint32(0, true);
  const payload = await readExact(reader, len);
  if (!payload) return null;
  return JSON.parse(new TextDecoder().decode(payload));
}

/** Decode a StateMessage from the stream, including Uint8Array revival. */
async function readStateMsg(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<StateMessage | null> {
  const header = await readExact(reader, 4);
  if (!header) return null;
  const len = new DataView(header.buffer).getUint32(0, true);
  const payload = await readExact(reader, len);
  if (!payload) return null;
  return JSON.parse(new TextDecoder().decode(payload), (_k, v) => {
    if (v && typeof v === "object" && v.__t === "u8") {
      return Uint8Array.from(atob(v.b as string), (c) => c.charCodeAt(0));
    }
    return v;
  }) as StateMessage;
}

// ── connect ───────────────────────────────────────────────────────────────────

console.log(`[debug-client] connecting to ${serverUrl}`);
const certHash = await certFingerprint(certFile);

// deno-lint-ignore no-explicit-any
const transport = new (globalThis as any).WebTransport(serverUrl, {
  serverCertificateHashes: [{ algorithm: "sha-256", value: certHash }],
});
await transport.ready;
console.log("[debug-client] transport open");

// ── join handshake ────────────────────────────────────────────────────────────

const { readable: joinR, writable: joinW } = await transport.createBidirectionalStream();
const jWriter = joinW.getWriter();
const jReader = joinR.getReader();

const joinReq: TileJoinRequest = { type: "join" };
await jWriter.write(encodeMsg(joinReq));
await jWriter.close();

const ack = await readMsg(jReader) as TileJoinAck | null;
jReader.releaseLock();

if (!ack || ack.type !== "joined") {
  console.error("[debug-client] join rejected:", ack);
  transport.close();
  Deno.exit(1);
}

const playerId = ack.playerId;
console.log(`[debug-client] joined as player ${playerId}`);

// ── state stream (server → client unidirectional) ─────────────────────────────

const uniReader = transport.incomingUnidirectionalStreams.getReader();
const { value: stateStream } = await uniReader.read();
uniReader.releaseLock();
const stateReader = stateStream.getReader();

// ── input heartbeat (20 Hz) ────────────────────────────────────────────────────

let seq = 0;
let clientTick = 0;
const datagramWriter = transport.datagrams.writable.getWriter();

const inputTimer = setInterval(() => {
  const dg = inputDatagramCodec.encode({
    seq: seq++,
    tick: clientTick,
    timestamp: Date.now(),
    facing: 0,
    movementX: 0,
    movementY: 0,
    actions: 0,
    interactSlot: 0,
  });
  datagramWriter.write(dg).catch(() => clearInterval(inputTimer));
}, 50);

// ── receive loop ──────────────────────────────────────────────────────────────

console.log("[debug-client] receiving state (Ctrl-C to stop)\n");

let lastTick = -1;

while (true) {
  const msg = await readStateMsg(stateReader);
  if (!msg) break;

  clientTick = msg.serverTick;
  lastTick = msg.serverTick;

  const shouldPrint = verbose || msg.serverTick % printInterval === 0;
  if (!shouldPrint && msg.events.length === 0) continue;

  // Summarise component deltas: {Position: 3, Velocity: 3, ...}
  const counts: Record<string, number> = {};
  for (const d of msg.entityDeltas) {
    counts[d.componentName] = (counts[d.componentName] ?? 0) + 1;
  }
  const deltaStr = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k}×${n}`)
    .join(", ");

  console.log(
    `tick ${String(msg.serverTick).padStart(6)} | ` +
    `ack=${msg.ackInputSeq} | ` +
    `deltas=${msg.entityDeltas.length}${deltaStr ? ` [${deltaStr}]` : ""} | ` +
    `destroys=${msg.entityDestroys.length} | ` +
    `events=${msg.events.length}`,
  );

  for (const ev of msg.events) {
    console.log("  event:", JSON.stringify(ev));
  }
}

clearInterval(inputTimer);
transport.close();
console.log(`[debug-client] disconnected after tick ${lastTick}`);
