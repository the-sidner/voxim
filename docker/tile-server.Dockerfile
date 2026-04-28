FROM denoland/deno:alpine-2.7.11

WORKDIR /app

COPY deno.json deno.lock ./
COPY packages ./packages
COPY scripts ./scripts

RUN deno cache packages/tile-server/main.ts

EXPOSE 4433/udp 14433

CMD ["deno", "run", \
     "--allow-net", "--allow-read", "--allow-write", "--allow-env", \
     "--unstable-net", \
     "packages/tile-server/main.ts"]
