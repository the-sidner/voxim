/**
 * Generate a self-signed TLS certificate for local development.
 *
 * Chromium's WebTransport serverCertificateHashes mechanism (the path we use
 * for self-signed local dev) requires the cert to be:
 *   - ECDSA on the P-256 curve
 *   - valid for at most 14 days
 * An RSA cert or a longer validity window will be rejected at handshake with
 * "WebTransport connection rejected" / QUIC crypto error 43.
 *
 * Rerun `deno task gen-certs` whenever the cert expires (roughly weekly).
 *
 * Output: ./certs/cert.pem and ./certs/key.pem
 * Requires openssl on PATH.
 */
await Deno.mkdir("certs", { recursive: true });

const genKey = await new Deno.Command("openssl", {
  args: ["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", "certs/key.pem"],
}).output();

if (genKey.code !== 0) {
  console.error("openssl ecparam failed:");
  console.error(new TextDecoder().decode(genKey.stderr));
  Deno.exit(1);
}

const genCert = await new Deno.Command("openssl", {
  args: [
    "req", "-x509", "-new",
    "-key", "certs/key.pem",
    "-out", "certs/cert.pem",
    "-days", "14",
    "-subj", "/CN=localhost",
    "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost",
  ],
}).output();

if (genCert.code !== 0) {
  console.error("openssl req failed:");
  console.error(new TextDecoder().decode(genCert.stderr));
  Deno.exit(1);
}

console.log("Generated certs/cert.pem and certs/key.pem (ECDSA P-256, valid 14 days)");
