FROM denoland/deno:alpine-2.7.11

WORKDIR /app

COPY deno.json deno.lock ./
COPY packages ./packages

# Pre-cache dependencies so cold start is fast.
RUN deno cache packages/atlas/main.ts

EXPOSE 8082

CMD ["deno", "run", \
     "--allow-net", "--allow-read", "--allow-env", \
     "packages/atlas/main.ts"]
