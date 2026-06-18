FROM alpine:3.20

RUN apk add --no-cache openssl

WORKDIR /work

# One-shot: generate an ECDSA P-256 cert valid for 14 days into /out (a named
# volume mounted by compose) when it's MISSING or EXPIRING. The volume persists
# across `compose up`, so a presence-only check would reuse the same cert
# forever — and it expires after 14 days, failing the WebTransport handshake
# with an opaque SSL_ERROR_BAD_CERTIFICATE. `openssl x509 -checkend` regenerates
# it before that, so every `compose up` self-heals an expired cert.
#
# The 14-day cap and ECDSA-P256 requirement come from the browser's WebTransport
# serverCertificateHashes mechanism. See scripts/dev_cert.ts for the host-side
# equivalent the non-docker `deno task tile/gateway` launchers use.
CMD ["sh", "-c", "\
  if [ -f /out/cert.pem ] && [ -f /out/key.pem ] && \
     openssl x509 -checkend 172800 -noout -in /out/cert.pem 2>/dev/null; then \
    echo '[certs-init] /out/cert.pem present and valid >2 days, skipping' && exit 0; \
  fi && \
  echo '[certs-init] generating ECDSA P-256 cert into /out (missing or expiring)' && \
  openssl ecparam -name prime256v1 -genkey -noout -out /out/key.pem && \
  openssl req -x509 -new \
    -key /out/key.pem \
    -out /out/cert.pem \
    -days 14 \
    -subj '/CN=localhost' \
    -addext 'subjectAltName=IP:127.0.0.1,DNS:localhost,DNS:gateway,DNS:tile-1,DNS:tile-2,DNS:tile-3,DNS:tile-4' && \
  echo '[certs-init] done'\
"]
