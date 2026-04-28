FROM denoland/deno:alpine-2.7.11

WORKDIR /app

COPY deno.json deno.lock ./
COPY packages ./packages

RUN deno cache --unstable-net packages/coordinator/main.ts

CMD ["deno", "run", \
     "--allow-net", "--allow-read", "--allow-env", \
     "--unstable-net", \
     "packages/coordinator/main.ts"]
