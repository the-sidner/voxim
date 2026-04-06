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
 */
import { VoximGame } from "./game.ts";

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

    game.start({ canvas, gatewayUrl })
      .catch((err) => console.error("[Voxim] failed to start:", err));
  }
})();
