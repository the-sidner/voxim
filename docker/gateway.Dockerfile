FROM denoland/deno:alpine-2.7.11

WORKDIR /app

COPY deno.json deno.lock ./
COPY packages ./packages
COPY scripts ./scripts

# Pre-cache dependencies so cold start is fast.
RUN deno cache packages/gateway/main.ts

EXPOSE 8080/udp 8081

CMD ["deno", "run", \
     "--allow-net", "--allow-read", "--allow-env", \
     "--unstable-net", \
     "packages/gateway/main.ts"]
