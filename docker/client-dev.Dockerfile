FROM denoland/deno:alpine-2.7.11

WORKDIR /app

COPY deno.json deno.lock ./
COPY packages ./packages
COPY scripts ./scripts

# Pre-cache scripts/serve_client.ts so esbuild + Deno deps are downloaded at
# build time, not on first request.
RUN deno cache --node-modules-dir=auto scripts/serve_client.ts || true

EXPOSE 3000

CMD ["deno", "run", "-A", "--node-modules-dir=auto", \
     "scripts/serve_client.ts"]
