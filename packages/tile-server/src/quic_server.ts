/// <reference path="./types/webtransport.d.ts" />
/**
 * QUIC / WebTransport listener.
 *
 * Opens a Deno.QuicEndpoint on the given port, upgrades incoming connections
 * to WebTransport sessions, and calls onSession for each one.
 *
 * Requires Deno's --unstable-net flag and TLS cert + key.
 */

export interface QuicListenerConfig {
  port: number;
  cert: string;
  key: string;
}

/**
 * Start listening for incoming WebTransport connections.
 * Each accepted session is passed to `onSession` as a fire-and-forget task.
 * Logs a warning and returns without listening if QUIC is unavailable (e.g. no --unstable-net).
 */
export function listenQuic(
  config: QuicListenerConfig,
  onSession: (session: WebTransportSession) => void,
): void {
  type QuicIncoming = { accept(): Promise<unknown> };
  type QuicEndpoint = { listen(opts: unknown): AsyncIterable<QuicIncoming> };
  // deno-lint-ignore no-explicit-any
  const DenoAny = Deno as any;

  let endpoint: QuicEndpoint;
  try {
    endpoint = new DenoAny.QuicEndpoint({ hostname: "0.0.0.0", port: config.port }) as QuicEndpoint;
  } catch (err) {
    console.warn(
      `[TileServer] WebTransport/QUIC unavailable (${(err as Error).message}). ` +
      `Continuing without WebTransport — admin/HTTP only.`,
    );
    return;
  }

  const listener = endpoint.listen({
    cert: config.cert,
    key: config.key,
    alpnProtocols: ["h3"],
  });

  console.log(`Listening on https://0.0.0.0:${config.port}/`);

  (async () => {
    for await (const incoming of listener) {
      incoming.accept()
        // deno-lint-ignore no-explicit-any
        .then((conn) => (Deno as any).upgradeWebTransport(conn))
        .then((wt: WebTransportSession) => onSession(wt))
        .catch((err: unknown) => {
          console.error("[TileServer] connection error", err);
        });
    }
  })().catch((err: unknown) => {
    console.error("[TileServer] QUIC listener error", err);
  });
}
