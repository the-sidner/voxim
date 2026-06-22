/**
 * Shared service-to-service authentication for the control plane.
 *
 * Every privileged HTTP endpoint that one Voxim service calls on another
 * (gateway register/heartbeat/handoff, tile admin handoff/jobs, atlas
 * bake/restart, the account service's `/internal/*`) is gated by a single
 * shared secret presented in the `X-Voxim-Service-Secret` header and
 * compared constant-time to the value configured via `VOXIM_SERVICE_SECRET`.
 *
 * These are control-plane endpoints only. PLAYER-facing endpoints
 * (`/account/register`, `/account/login`, `/gateway/connect`) are public
 * and MUST NOT call `verifyServiceSecret`.
 *
 * The same secret authenticates the privileged WebTransport service streams
 * (see `ServiceHandshake.secret`) — one secret, every cross-service path.
 */

/** Header the caller presents the shared secret in. Lower-cased: Headers.get is case-insensitive but we match the convention used across the codebase. */
export const SERVICE_SECRET_HEADER = "x-voxim-service-secret";

/** Minimum acceptable secret length. A secret shorter than this is a config mistake, not a deployment we want to run. */
export const MIN_SERVICE_SECRET_LENGTH = 16;

/**
 * Constant-time string compare — avoids leaking the secret's length-prefix
 * match via early-exit timing. Length mismatch returns false up front (the
 * length itself is not secret).
 */
export function constantTimeEqualStrings(a: string, b: string): boolean {
  const aBytes = new TextEncoder().encode(a);
  const bBytes = new TextEncoder().encode(b);
  if (aBytes.length !== bBytes.length) return false;
  let diff = 0;
  for (let i = 0; i < aBytes.length; i++) diff |= aBytes[i] ^ bBytes[i];
  return diff === 0;
}

/**
 * True when the request carries the correct shared secret. A missing
 * header, an empty secret, or a mismatch all return false. Callers respond
 * 401 on false. When `expected` is empty the check always fails closed —
 * an unconfigured server never authenticates anyone.
 */
export function verifyServiceSecret(req: Request, expected: string): boolean {
  if (!expected) return false;
  const presented = req.headers.get(SERVICE_SECRET_HEADER) ?? "";
  return constantTimeEqualStrings(presented, expected);
}

/** True when the process is running in a production deployment (`VOXIM_ENV=production`). */
export function isProduction(): boolean {
  return Deno.env.get("VOXIM_ENV") === "production";
}

/**
 * Resolve the control-plane shared secret at startup, failing closed in
 * production. Behaviour:
 *
 *   - `VOXIM_SERVICE_SECRET` set & long enough → use it (dev and prod alike).
 *   - unset/too short in production (`VOXIM_ENV=production`) → throw, so a
 *     misconfigured deployment never boots with an unauthenticated control
 *     plane.
 *   - unset in dev → fall back to a well-known dev-only secret so a
 *     single-machine `deno task` stack still talks to itself.
 *
 * The fallback is intentionally obvious ("dev-local-only…") so it can never
 * be mistaken for a real secret in logs or config.
 */
export function resolveServiceSecret(): string {
  const fromEnv = Deno.env.get("VOXIM_SERVICE_SECRET");
  if (fromEnv && fromEnv.length >= MIN_SERVICE_SECRET_LENGTH) return fromEnv;

  if (isProduction()) {
    throw new Error(
      `VOXIM_SERVICE_SECRET must be set to at least ${MIN_SERVICE_SECRET_LENGTH} chars in production ` +
        `(VOXIM_ENV=production). Refusing to boot with an unauthenticated control plane.`,
    );
  }

  if (fromEnv) {
    // Set but too short — surface it rather than silently using the dev default.
    throw new Error(
      `VOXIM_SERVICE_SECRET is set but shorter than ${MIN_SERVICE_SECRET_LENGTH} chars. ` +
        `Use a longer secret or unset it to fall back to the dev default.`,
    );
  }

  return "dev-local-only-do-not-use-in-prod-0000";
}
