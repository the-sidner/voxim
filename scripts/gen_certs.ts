/**
 * Generate a self-signed TLS certificate for local development.
 *
 * Chromium/Firefox's WebTransport serverCertificateHashes mechanism (the path
 * we use for self-signed local dev) requires the cert to be ECDSA on the P-256
 * curve and valid for at most 14 days. An RSA cert or a longer validity window
 * is rejected at handshake with "WebTransport connection rejected" /
 * SSL_ERROR_BAD_CERTIFICATE.
 *
 * The tile-server also regenerates this automatically at boot when it's
 * missing or expiring (see dev_cert.ts) — this script is the manual entry
 * point and shares the same implementation.
 *
 * Output: ./certs/cert.pem and ./certs/key.pem. Requires openssl on PATH.
 */
import { generateDevCert } from "../packages/tile-server/src/dev_cert.ts";

await generateDevCert("certs/cert.pem", "certs/key.pem");
console.log("Generated certs/cert.pem and certs/key.pem (ECDSA P-256, valid 14 days)");
