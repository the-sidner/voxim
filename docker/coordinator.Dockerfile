FROM denoland/deno:alpine-2.7.11

WORKDIR /app

COPY deno.json deno.lock ./
COPY packages ./packages

# Coordinator package is created in T-137. Until then this Dockerfile builds
# but does not run anything (the service is started from compose only when
# packages/coordinator/main.ts exists).
RUN test -f packages/coordinator/main.ts && \
    deno cache packages/coordinator/main.ts || true

CMD ["sh", "-c", "if [ -f packages/coordinator/main.ts ]; then \
       deno run --allow-net --allow-read --allow-env packages/coordinator/main.ts; \
     else \
       echo 'coordinator not implemented yet (T-137); idling' && tail -f /dev/null; \
     fi"]
