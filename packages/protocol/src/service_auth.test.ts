/**
 * Control-plane service-secret auth (T-258).
 *
 * The helper gates every cross-service HTTP endpoint. These tests pin the
 * two security-critical behaviours: a request with the correct secret
 * passes, anything else (missing header, wrong value, empty configured
 * secret) is rejected; and startup resolution fails closed in production.
 */

import { assertEquals, assertThrows } from "jsr:@std/assert";
import {
  SERVICE_SECRET_HEADER,
  constantTimeEqualStrings,
  isProduction,
  resolveServiceSecret,
  verifyServiceSecret,
} from "./service_auth.ts";

const SECRET = "a-sufficiently-long-test-secret-value";

function reqWithSecret(value: string | null): Request {
  const headers = new Headers();
  if (value !== null) headers.set(SERVICE_SECRET_HEADER, value);
  return new Request("http://tile/handoff", { method: "POST", headers });
}

Deno.test("verifyServiceSecret: correct secret passes", () => {
  assertEquals(verifyServiceSecret(reqWithSecret(SECRET), SECRET), true);
});

Deno.test("verifyServiceSecret: header is case-insensitive (Headers normalises)", () => {
  const headers = new Headers();
  headers.set("X-Voxim-Service-Secret", SECRET);
  const req = new Request("http://tile/handoff", { method: "POST", headers });
  assertEquals(verifyServiceSecret(req, SECRET), true);
});

Deno.test("verifyServiceSecret: missing header rejected", () => {
  assertEquals(verifyServiceSecret(reqWithSecret(null), SECRET), false);
});

Deno.test("verifyServiceSecret: wrong secret rejected", () => {
  assertEquals(verifyServiceSecret(reqWithSecret("not-the-secret-but-long-enough"), SECRET), false);
});

Deno.test("verifyServiceSecret: empty presented value rejected", () => {
  assertEquals(verifyServiceSecret(reqWithSecret(""), SECRET), false);
});

Deno.test("verifyServiceSecret: empty configured secret fails closed even with empty header", () => {
  // An unconfigured server must never authenticate anyone, including a
  // caller that also sends an empty header.
  assertEquals(verifyServiceSecret(reqWithSecret(""), ""), false);
  assertEquals(verifyServiceSecret(reqWithSecret("anything"), ""), false);
});

Deno.test("constantTimeEqualStrings: equal/unequal/length-mismatch", () => {
  assertEquals(constantTimeEqualStrings("abc", "abc"), true);
  assertEquals(constantTimeEqualStrings("abc", "abd"), false);
  assertEquals(constantTimeEqualStrings("abc", "abcd"), false);
  assertEquals(constantTimeEqualStrings("", ""), true);
});

// ---- startup resolution (reads VOXIM_ENV / VOXIM_SERVICE_SECRET) ----

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) prev[k] = Deno.env.get(k);
  try {
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
    fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  }
}

Deno.test("resolveServiceSecret: uses env secret when long enough", () => {
  withEnv({ VOXIM_ENV: undefined, VOXIM_SERVICE_SECRET: SECRET }, () => {
    assertEquals(resolveServiceSecret(), SECRET);
  });
});

Deno.test("resolveServiceSecret: dev falls back to a non-empty default when unset", () => {
  withEnv({ VOXIM_ENV: undefined, VOXIM_SERVICE_SECRET: undefined }, () => {
    const s = resolveServiceSecret();
    assertEquals(s.length >= 16, true);
  });
});

Deno.test("resolveServiceSecret: production fails closed when unset", () => {
  withEnv({ VOXIM_ENV: "production", VOXIM_SERVICE_SECRET: undefined }, () => {
    assertThrows(() => resolveServiceSecret(), Error, "production");
  });
});

Deno.test("resolveServiceSecret: production uses env secret when present", () => {
  withEnv({ VOXIM_ENV: "production", VOXIM_SERVICE_SECRET: SECRET }, () => {
    assertEquals(resolveServiceSecret(), SECRET);
  });
});

Deno.test("resolveServiceSecret: too-short secret throws rather than silently defaulting", () => {
  withEnv({ VOXIM_ENV: undefined, VOXIM_SERVICE_SECRET: "tooshort" }, () => {
    assertThrows(() => resolveServiceSecret(), Error);
  });
});

Deno.test("isProduction: true only when VOXIM_ENV=production", () => {
  withEnv({ VOXIM_ENV: "production" }, () => assertEquals(isProduction(), true));
  withEnv({ VOXIM_ENV: "dev" }, () => assertEquals(isProduction(), false));
  withEnv({ VOXIM_ENV: undefined }, () => assertEquals(isProduction(), false));
});
