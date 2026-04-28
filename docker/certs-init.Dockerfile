FROM alpine:3.20

RUN apk add --no-cache openssl

WORKDIR /work

# One-shot: if /out/cert.pem is missing, generate an ECDSA P-256 cert valid
# for 14 days into /out (mounted as a named volume by compose). On second
# run with the volume already populated, exit cleanly.
#
# The 14-day cap and ECDSA-P256 requirement come from Chromium's
# WebTransport serverCertificateHashes mechanism. See scripts/gen_certs.ts
# for the host-side equivalent.
CMD ["sh", "-c", "\
  if [ -f /out/cert.pem ] && [ -f /out/key.pem ]; then \
    echo '[certs-init] /out/cert.pem already present, skipping' && exit 0; \
  fi && \
  echo '[certs-init] generating ECDSA P-256 cert into /out' && \
  openssl ecparam -name prime256v1 -genkey -noout -out /out/key.pem && \
  openssl req -x509 -new \
    -key /out/key.pem \
    -out /out/cert.pem \
    -days 14 \
    -subj '/CN=localhost' \
    -addext 'subjectAltName=IP:127.0.0.1,DNS:localhost,DNS:gateway,DNS:tile-1,DNS:tile-2,DNS:tile-3,DNS:tile-4' && \
  echo '[certs-init] done'\
"]
