/**
 * Dev TLS certificate management.
 *
 * WebTransport's `serverCertificateHashes` path (how the browser trusts our
 * self-signed local cert) requires the cert to be ECDSA P-256 AND valid for at
 * most 14 days. The short window means the cert expires constantly — and an
 * expired cert is rejected at the QUIC handshake with the cryptic
 * "WebTransport connection rejected" / SSL_ERROR_BAD_CERTIFICATE, with nothing
 * pointing at the cert as the cause.
 *
 * So the tile-server self-heals: `ensureFreshDevCert` regenerates the cert at
 * boot when it's missing or about to expire. Scoped to the default dev cert
 * path — a deployment that supplies its own TLS_CERT is left untouched.
 *
 * `openssl` must be on PATH (same requirement as `deno task gen-certs`).
 */

/** (Re)generate an ECDSA P-256, 14-day self-signed cert at the given paths. */
export async function generateDevCert(certPath: string, keyPath: string): Promise<void> {
  const slash = certPath.lastIndexOf("/");
  if (slash > 0) await Deno.mkdir(certPath.slice(0, slash), { recursive: true });

  const genKey = await new Deno.Command("openssl", {
    args: ["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", keyPath],
  }).output();
  if (!genKey.success) {
    throw new Error(`openssl ecparam failed: ${new TextDecoder().decode(genKey.stderr)}`);
  }

  const genCert = await new Deno.Command("openssl", {
    args: [
      "req", "-x509", "-new",
      "-key", keyPath,
      "-out", certPath,
      "-days", "14",
      "-subj", "/CN=localhost",
      "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost",
    ],
  }).output();
  if (!genCert.success) {
    throw new Error(`openssl req failed: ${new TextDecoder().decode(genCert.stderr)}`);
  }
}

/**
 * Regenerate the dev cert if it's missing or expires within 2 days. A no-op
 * when the cert is current. On failure (e.g. no openssl) it warns and leaves
 * the existing cert in place rather than aborting boot.
 */
export async function ensureFreshDevCert(certPath: string, keyPath: string): Promise<void> {
  let reason = "";
  try {
    await Deno.stat(certPath);
    await Deno.stat(keyPath);
    // `-checkend N`: exit 0 iff the cert stays valid for ≥ N more seconds.
    const check = await new Deno.Command("openssl", {
      args: ["x509", "-checkend", "172800", "-noout", "-in", certPath],
    }).output();
    if (!check.success) reason = "expired or expiring within 2 days";
  } catch {
    reason = "missing";
  }
  if (!reason) return;

  console.warn(
    `[dev-cert] ${certPath} is ${reason} — regenerating. WebTransport needs a ` +
    `current ECDSA P-256 cert valid ≤14 days, or the browser rejects the QUIC ` +
    `handshake with SSL_ERROR_BAD_CERTIFICATE.`,
  );
  try {
    await generateDevCert(certPath, keyPath);
    console.log(`[dev-cert] regenerated ${certPath} (ECDSA P-256, valid 14 days)`);
  } catch (err) {
    console.error(
      `[dev-cert] could not regenerate (${(err as Error).message}). ` +
      `Run 'deno task gen-certs' manually (needs openssl on PATH).`,
    );
  }
}
