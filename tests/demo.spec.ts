/**
 * Playwright smoke test for the game demo served from the tile server admin port.
 *
 * Verifies:
 *   1. The /game page loads (HTML + game.js bundle)
 *   2. /cert-hash returns a valid SHA-256 hex string
 *   3. The browser opens a WebTransport session and completes the join handshake
 *      (evidenced by the "[Game] tile-assigned player ID" console log)
 *   4. Three.js initialises and renders to the canvas (non-zero pixel data)
 *   5. No uncaught page errors
 *
 * Prerequisites:
 *   - TLS certs present at ./certs/ (deno task gen-certs)
 *   - game.js bundle built (deno task bundle)
 *   - Tile server running or startable via playwright.config webServer
 */
/// <reference lib="dom" />
import { test, expect, type Page } from "playwright/test";

// ── helpers ──────────────────────────────────────────────────────────────────

/** Polls until a log line containing `needle` appears or the timeout expires. */
async function waitForLog(page: Page, logs: string[], needle: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (logs.some((l) => l.includes(needle))) return;
    await page.waitForTimeout(200);
  }
  const dump = logs.map((l) => "  " + l).join("\n") || "  (none)";
  throw new Error(`Timed out waiting for "${needle}".\nBrowser console:\n${dump}`);
}

/** Reads a 1×1 pixel from the centre of the WebGL canvas. */
function sampleCanvasCentre(page: Page): Promise<[number, number, number, number]> {
  return page.evaluate(() => {
    const canvas = document.getElementById("canvas") as HTMLCanvasElement;
    const gl =
      (canvas.getContext("webgl2") ?? canvas.getContext("webgl")) as WebGLRenderingContext | null;
    if (!gl) return [0, 0, 0, 0];
    const px = new Uint8Array(4);
    gl.readPixels(
      Math.floor(canvas.width / 2),
      Math.floor(canvas.height / 2),
      1, 1,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      px,
    );
    return Array.from(px) as [number, number, number, number];
  });
}

// ── tests ────────────────────────────────────────────────────────────────────

test.describe("game demo (/game)", () => {
  test("cert-hash endpoint returns a 64-char hex SHA-256", async ({ request }) => {
    const resp = await request.get("/cert-hash");
    expect(resp.status()).toBe(200);

    const body = await resp.json();
    expect(typeof body.sha256).toBe("string");
    expect(body.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test("game.js bundle is served", async ({ request }) => {
    const resp = await request.get("/game.js");
    expect(resp.status()).toBe(200);
    expect(resp.headers()["content-type"]).toContain("javascript");

    const text = await resp.text();
    expect(text.length).toBeGreaterThan(1000); // must be a real bundle, not the stub error
  });

  test("page loads, connects, and renders", async ({ page }) => {
    const logs: string[] = [];
    page.on("console", (msg) => logs.push(msg.text()));

    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));

    await page.goto("/game");

    // Canvas must be present immediately after load
    const canvas = page.locator("canvas#canvas");
    await expect(canvas).toBeVisible();

    // Wait for the tile server to assign a player ID — confirms full handshake
    await page.waitForFunction(
      () => (window as unknown as Record<string, unknown>)._voxim_connected === true,
      { timeout: 15_000 },
    ).catch(async () => {
      const consoleDump = logs.map((l) => "  " + l).join("\n") || "  (none)";
      throw new Error(`WebTransport join handshake timed out.\nBrowser console:\n${consoleDump}`);
    });

    // No unhandled JS errors
    expect(errors, `unexpected page errors: ${errors.join("; ")}`).toHaveLength(0);

    // Give Three.js a moment to render the first frame
    await page.waitForTimeout(500);

    // Canvas must have real dimensions
    const bb = await canvas.boundingBox();
    expect(bb).not.toBeNull();
    expect(bb!.width).toBeGreaterThan(0);
    expect(bb!.height).toBeGreaterThan(0);

    // The centre pixel should not be pure black — Three.js sky is #8bbfff
    const [r, g, b, a] = await sampleCanvasCentre(page);
    expect(a, "alpha should be 255 — canvas is opaque").toBe(255);
    expect(r + g + b, "pixel should not be pure black").toBeGreaterThan(0);
  });
});
