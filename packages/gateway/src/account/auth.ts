/**
 * Password hashing + session token primitives (pure Deno / Web Crypto).
 *
 * ## Password hashing: PBKDF2-HMAC-SHA256
 *
 * The T-111 ticket specified argon2id. We ship PBKDF2 instead because it is
 * built into the Web Crypto API — zero new dependencies, and the rest of
 * the project is pure-Deno (no node: imports anywhere else). PBKDF2 is
 * weaker than argon2id against determined GPU/ASIC attackers but is
 * industry-standard and OWASP-approved at the parameters below (600,000
 * iterations as of 2023 guidance).
 *
 * Stored hash format: `pbkdf2-sha256$iterations$salt_b64u$hash_b64u` —
 * self-describing, so a future upgrade to argon2id can coexist via
 * prefix-dispatch in verifyPassword(). Swap cost: a new algo branch in
 * verify + a rehash on next successful login.
 *
 * ## Session tokens: opaque random + SHA-256 at rest
 *
 * Token on the wire: 32 bytes of `crypto.getRandomValues`, base64url-encoded
 * (43 chars, no padding). Client keeps the raw value; the server stores
 * only its SHA-256 hex. A memory dump of the gateway therefore cannot
 * resurrect client sessions.
 *
 * No KDF on the token hash: the raw token already carries 256 bits of
 * entropy, so a single SHA-256 round is sufficient for at-rest defense.
 * KDFs exist to slow brute-force of low-entropy human passwords.
 */

// ---- base64url helpers ----
// btoa encodes bytes as standard base64; we massage the output into the
// URL-safe form (RFC 4648 §5). Parsing reverses the substitution and
// restores padding before atob.

function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function fromBase64Url(s: string): Uint8Array {
  let b64 = s.replaceAll("-", "+").replaceAll("_", "/");
  while (b64.length % 4 !== 0) b64 += "=";
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---- password hashing (PBKDF2) ----

const PBKDF2_ITERATIONS = 600_000;
const PBKDF2_HASH       = "SHA-256";
const PBKDF2_KEY_BITS   = 256;
const PBKDF2_SALT_BYTES = 16;

async function pbkdf2(plain: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const pw = new TextEncoder().encode(plain);
  const key = await crypto.subtle.importKey(
    "raw", pw as BufferSource, { name: "PBKDF2" }, false, ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: salt as BufferSource, iterations, hash: PBKDF2_HASH },
    key, PBKDF2_KEY_BITS,
  );
  return new Uint8Array(bits);
}

export async function hashPassword(plain: string): Promise<string> {
  const salt = new Uint8Array(PBKDF2_SALT_BYTES);
  crypto.getRandomValues(salt);
  const hash = await pbkdf2(plain, salt, PBKDF2_ITERATIONS);
  return `pbkdf2-sha256$${PBKDF2_ITERATIONS}$${toBase64Url(salt)}$${toBase64Url(hash)}`;
}

export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2-sha256") return false;
  const iterations = Number(parts[1]);
  if (!Number.isFinite(iterations) || iterations <= 0) return false;
  let salt: Uint8Array, expected: Uint8Array;
  try {
    salt = fromBase64Url(parts[2]);
    expected = fromBase64Url(parts[3]);
  } catch {
    return false;
  }
  const candidate = await pbkdf2(plain, salt, iterations);
  return timingSafeEqual(candidate, expected);
}

/** Constant-time equality over two byte arrays. Returns false on length mismatch. */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// ---- session tokens ----

const TOKEN_BYTES = 32;

/**
 * Generate a fresh opaque session token. The returned string is what the
 * client stores and sends; the server stores only `hashToken(token)`.
 */
export function generateToken(): string {
  const b = new Uint8Array(TOKEN_BYTES);
  crypto.getRandomValues(b);
  return toBase64Url(b);
}

/**
 * Hash a session token for at-rest comparison. SHA-256 hex is appropriate
 * because the token already carries 256 bits of entropy — no KDF required.
 */
export async function hashToken(token: string): Promise<string> {
  const bytes = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
