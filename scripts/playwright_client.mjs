/**
 * Playwright debug client — launches Chromium and connects to the tile server
 * via the browser's native WebTransport API.
 *
 * Usage:
 *   node scripts/playwright_client.mjs [seconds]
 *
 * The optional argument controls how long to run before disconnecting (default 15s).
 */

import { chromium } from "playwright";

const runSeconds = parseInt(process.argv[2] ?? "15");

// ── start browser ──────────────────────────────────────────────────────────────
const browser = await chromium.launch({
  headless: false,
  args: [
    "--ignore-certificate-errors",
    "--enable-quic",
    "--origin-to-force-quic-on=127.0.0.1:4434",
  ],
});
const page = await browser.newPage();

// Forward browser console to node stdout
page.on("console", (msg) => {
  const type = msg.type();
  const text = msg.text();
  if (type === "error") process.stderr.write(`[browser:error] ${text}\n`);
  else process.stdout.write(`[browser] ${text}\n`);
});

// Navigate to the debug page and click Connect — the page's own JS handles everything
await page.goto("http://127.0.0.1:14434/");
await page.click("#btn");

// Stay open for N seconds so the user can watch, then disconnect and close
await new Promise((resolve) => setTimeout(resolve, runSeconds * 1000));
await page.evaluate(() => window._wtCleanup?.()).catch(() => {});
await browser.close();
process.stdout.write(`[playwright_client] done after ${runSeconds}s\n`);
