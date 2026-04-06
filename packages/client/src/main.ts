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

// ---- debug panel ----

function buildDebugPanel(game: VoximGame): void {
  const LAYERS: { id: "skeleton" | "facing" | "chunks" | "heightmap"; label: string }[] = [
    { id: "skeleton",  label: "Skeleton bones" },
    { id: "facing",    label: "Facing arrows" },
    { id: "chunks",    label: "Chunk borders" },
    { id: "heightmap", label: "Height map" },
  ];

  const state: Record<string, boolean> = {};
  LAYERS.forEach(l => state[l.id] = false);

  // Toggle button
  const btn = document.createElement("button");
  btn.textContent = "Debug";
  Object.assign(btn.style, {
    position: "fixed", top: "12px", right: "12px", zIndex: "1000",
    padding: "6px 14px", fontFamily: "monospace", fontSize: "13px",
    background: "#1a1a2e", color: "#8cf", border: "1px solid #334",
    borderRadius: "4px", cursor: "pointer", userSelect: "none",
  });

  // Panel
  const panel = document.createElement("div");
  Object.assign(panel.style, {
    position: "fixed", top: "42px", right: "12px", zIndex: "1000",
    background: "#0d0d1a", border: "1px solid #334", borderRadius: "6px",
    padding: "10px 14px", display: "none", flexDirection: "column", gap: "8px",
    fontFamily: "monospace", fontSize: "13px", color: "#ccc", minWidth: "180px",
  });

  const title = document.createElement("div");
  title.textContent = "Debug layers";
  Object.assign(title.style, { color: "#8cf", fontWeight: "bold", marginBottom: "4px" });
  panel.appendChild(title);

  for (const layer of LAYERS) {
    const row = document.createElement("label");
    Object.assign(row.style, { display: "flex", alignItems: "center", gap: "8px", cursor: "pointer" });

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = false;
    cb.addEventListener("change", () => {
      state[layer.id] = game.toggleDebug(layer.id);
      cb.checked = state[layer.id];
    });

    const lbl = document.createElement("span");
    lbl.textContent = layer.label;

    row.appendChild(cb);
    row.appendChild(lbl);
    panel.appendChild(row);
  }

  let open = false;
  btn.addEventListener("click", () => {
    open = !open;
    panel.style.display = open ? "flex" : "none";
    btn.style.background = open ? "#1a2e4a" : "#1a1a2e";
  });

  document.body.appendChild(btn);
  document.body.appendChild(panel);
}

(async () => {
  const g = globalThis as unknown as Record<string, unknown>;
  const params = new URLSearchParams(location.search);

  const directTileAddress: string | null =
    (g.VOXIM_TILE_ADDRESS as string | undefined) ??
    params.get("tile") ??
    null;

  const game = new VoximGame();
  buildDebugPanel(game);

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
