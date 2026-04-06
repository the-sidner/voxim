/**
 * Generate a self-signed TLS certificate for local development.
 *
 * WebTransport requires HTTPS even on localhost, and Chrome additionally
 * requires the SAN field to contain the IP/hostname being used.
 *
 * Output: ./certs/cert.pem and ./certs/key.pem
 *
 * Run: deno task gen-certs
 *
 * Requires openssl to be available on PATH.
 */
await Deno.mkdir("certs", { recursive: true });

const cmd = new Deno.Command("openssl", {
  args: [
    "req", "-x509",
    "-newkey", "rsa:2048",
    "-keyout", "certs/key.pem",
    "-out", "certs/cert.pem",
    "-days", "365",
    "-nodes",
    "-subj", "/CN=localhost",
    "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost",
  ],
});

const { code, stderr } = await cmd.output();

if (code !== 0) {
  console.error("openssl failed:");
  console.error(new TextDecoder().decode(stderr));
  Deno.exit(1);
}

console.log("Generated certs/cert.pem and certs/key.pem (valid 365 days)");
console.log("");
console.log("Chrome / Edge: launch with --ignore-certificate-errors-spki-list");
console.log("or trust the cert in your OS keychain for a cleaner dev experience.");
