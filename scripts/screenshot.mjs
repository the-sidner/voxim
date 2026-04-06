/**
 * Playwright screenshot helper.
 *
 * Launches Chromium, connects to the game at http://127.0.0.1:14434/game,
 * waits for the tile connection, optionally enables the skeleton overlay,
 * then saves a screenshot.
 *
 * Usage:
 *   node scripts/screenshot.mjs [--skeleton] [--wait <seconds>] [--out <path>]
 *
 * Options:
 *   --skeleton        Enable skeleton overlay before screenshotting
 *   --wait <n>        Seconds to wait after connect before screenshot (default 4)
 *   --out <path>      Output PNG path (default /tmp/voxim-screenshot.png)
 */

import { chromium } from "playwright";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    skeleton: { type: "boolean", default: false },
    wait:     { type: "string",  default: "4" },
    out:      { type: "string",  default: "/tmp/voxim-screenshot.png" },
  },
  strict: false,
});

const waitSeconds = parseInt(values.wait);
const outPath     = values.out;

const browser = await chromium.launch({
  headless: true,
  args: [
    "--ignore-certificate-errors",
    "--enable-quic",
    "--origin-to-force-quic-on=127.0.0.1:4434",
  ],
});

const page = await browser.newPage();
await page.setViewportSize({ width: 1280, height: 720 });

page.on("console", (msg) => {
  const text = msg.text();
  if (msg.type() === "error") process.stderr.write(`[browser:error] ${text}\n`);
  else                        process.stdout.write(`[browser] ${text}\n`);
});

process.stdout.write(`[screenshot] navigating to game…\n`);
await page.goto("http://127.0.0.1:14434/game");

// Wait for the tile connection to be established
process.stdout.write(`[screenshot] waiting for connection…\n`);
await page.waitForFunction(() => globalThis._voxim_connected === true, { timeout: 15000 });
process.stdout.write(`[screenshot] connected\n`);

if (values.skeleton) {
  await page.evaluate(() => globalThis._voxim_game?.toggleSkeletonOverlay());
  process.stdout.write(`[screenshot] skeleton overlay enabled\n`);
}

// Let the world render for a few seconds
await new Promise((r) => setTimeout(r, waitSeconds * 1000));

await page.screenshot({ path: outPath });
process.stdout.write(`[screenshot] saved → ${outPath}\n`);

await browser.close();
