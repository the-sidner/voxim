/// <reference lib="dom" />
/**
 * Browser entry point — bundled to dist/game.js by `deno task bundle`.
 *
 * Connection mode resolution (first match wins):
 *   Direct tile (demo/dev):
 *     1. globalThis.VOXIM_TILE_ADDRESS — "hostname:port", set by embedding page
 *     2. ?tile=<address>               — URL query param
 *   Gateway (production):
 *     3. globalThis.VOXIM_GATEWAY_URL  — set by parent application before loading
 *     4. ?gateway=<url>                — URL query param
 *     5. https://localhost:8080        — fallback for local dev
 *
 * In direct tile mode the cert hash is resolved as:
 *     1. globalThis.VOXIM_CERT_HASH    — hex string, set by embedding page
 *     2. ?certHash=<hex>               — URL query param
 *     3. GET /cert-hash                — fetched from same-origin admin server (demo default)
 *
 * Gateway mode requires a session token. Resolution order:
 *     1. globalThis.VOXIM_SESSION_TOKEN — test-only injection
 *     2. localStorage['voxim.session_token'] — populated by the login UI
 *     3. (absent) — show the login screen, which populates localStorage on
 *        success and then continues into the game.
 */
import { VoximGame } from "./game.ts";
import { clearToken, loadToken, showLoginScreen, validateStoredToken } from "./ui/login.ts";

const canvas = document.getElementById("canvas") as HTMLCanvasElement;
canvas.width  = innerWidth;
canvas.height = innerHeight;

addEventListener("resize", () => {
  canvas.width  = innerWidth;
  canvas.height = innerHeight;
});

(async () => {
  const g = globalThis as unknown as Record<string, unknown>;
  const params = new URLSearchParams(location.search);

  const directTileAddress: string | null =
    (g.VOXIM_TILE_ADDRESS as string | undefined) ??
    params.get("tile") ??
    null;

  const game = new VoximGame();

  // Expose debug helpers for playwright/devtools
  (g as Record<string, unknown>)._voxim_game = game;

  if (directTileAddress) {
    // Direct tile mode — skip gateway, used by demo server and local dev.
    let certHashHex: string | undefined =
      (g.VOXIM_CERT_HASH as string | undefined) ??
      params.get("certHash") ??
      undefined;

    if (!certHashHex) {
      try {
        const data = await fetch("/cert-hash").then((r) => r.json()) as { sha256: string };
        certHashHex = data.sha256;
      } catch {
        console.warn("[Voxim] could not fetch /cert-hash — WebTransport may fail for self-signed certs");
      }
    }

    game.start({ canvas, directTile: { address: directTileAddress, certHashHex } })
      .catch((err) => console.error("[Voxim] failed to start:", err));
  } else {
    const gatewayUrl: string =
      (g.VOXIM_GATEWAY_URL as string | undefined) ??
      params.get("gateway") ??
      "https://localhost:8080";

    console.log(`[Voxim] gateway mode → ${gatewayUrl}`);

    const injectedToken = g.VOXIM_SESSION_TOKEN as string | undefined;
    const storedToken = injectedToken ?? loadToken();

    // If we have a cached token, probe /account/me to see if it still works.
    // A 401 on the probe is benign — we drop the token and show login.
    // A network error (null) degrades to "show login so the user can retry
    // manually" — better than a stuck spinner.
    let existing: string | null = null;
    if (storedToken) {
      const ok = await validateStoredToken(gatewayUrl, storedToken);
      if (ok === true) {
        existing = storedToken;
      } else if (ok === false) {
        clearToken();
      }
    }

    const host = document.getElementById("ui") ?? document.body;
    const startGame = (token: string) => {
      game.start({ canvas, gatewayUrl, sessionToken: token }).catch((err) => {
        // The gateway rejected us — most likely the token expired between the
        // /account/me probe and the connect. Clear it and fall back to the
        // login screen rather than leaving the player stuck.
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("unauthenticated")) {
          clearToken();
          showLoginScreen({ gatewayUrl, container: host, onAuthenticated: startGame });
          return;
        }
        console.error("[Voxim] failed to start:", err);
      });
    };

    if (existing) {
      startGame(existing);
    } else {
      showLoginScreen({
        gatewayUrl,
        container: host,
        onAuthenticated: startGame,
      });
    }
  }
})();
