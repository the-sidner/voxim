FROM denoland/deno:alpine-2.7.11

WORKDIR /app

COPY deno.json deno.lock ./
COPY packages ./packages
COPY scripts ./scripts

# Pre-cache the static dev server + the voxel-editor bundler.  serve_devtools
# only serves files; build_voxel_editor pulls in esbuild + the JSX runtime.
# Caching here keeps the first request fast (no on-demand npm fetches).
RUN deno cache --node-modules-dir=auto scripts/serve_devtools.ts scripts/build_voxel_editor.ts || true

EXPOSE 8888

# The runtime command builds the voxel-editor bundle once at container start
# (the dist/ inside the image may be stale or missing) and then serves on 8888.
# In dev mode the compose override bind-mounts ./packages so subsequent edits
# become visible after a manual rebuild via `docker compose exec devtools ...`.
CMD ["sh", "-c", "deno run -A --node-modules-dir=auto scripts/build_voxel_editor.ts && deno run -A --node-modules-dir=auto scripts/serve_devtools.ts"]
