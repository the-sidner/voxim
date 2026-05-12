FROM denoland/deno:alpine-2.7.11

WORKDIR /app

COPY deno.json deno.lock ./
COPY packages ./packages
COPY scripts ./scripts

# Pre-cache the static dev server + both bundlers (old voxel-editor + new
# studio at /studio). serve_devtools only serves files; the bundlers pull
# in esbuild + the JSX runtime. Caching here keeps the first request fast.
RUN deno cache --node-modules-dir=auto scripts/serve_devtools.ts scripts/build_voxel_editor.ts scripts/build_studio.ts || true

EXPOSE 8888

# Build both bundles at container start (dist/ inside the image may be
# stale or missing), then serve on 8888. Bind-mounted ./packages in dev
# override makes source edits visible after a manual rebuild via
# `docker compose exec devtools deno task build-studio`.
CMD ["sh", "-c", "deno run -A --node-modules-dir=auto scripts/build_voxel_editor.ts && deno run -A --node-modules-dir=auto scripts/build_studio.ts && deno run -A --node-modules-dir=auto scripts/serve_devtools.ts"]
