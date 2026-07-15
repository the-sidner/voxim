// One-off perf probe — connects the real client (like testplay) and samples
// rAF FPS + the renderer's GPU/frame timings over a few seconds. Prints JSON.
//   node scripts/measure_fps.mjs
//   BYPASS=1 node scripts/measure_fps.mjs   # measure with post-FX bypassed
import { chromium } from 'playwright';

const CLIENT  = process.env.CLIENT || 'http://localhost:14433/';
const GW      = process.env.GW     || 'http://localhost:8081';
const EXE     = process.env.CHROME || '/home/work/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome';
const creds   = { loginName: process.env.USER_NAME || 'agentbot', password: 'agentbot-pass-123' };
const MS      = Number(process.env.MS || 3000);

async function auth() {
  for (const path of ['/account/login', '/account/register']) {
    const r = await fetch(GW + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(creds) }).catch(() => null);
    if (r?.ok) { const j = await r.json(); if (j.token) return j.token; }
  }
  throw new Error('auth failed');
}

const token = await auth();
const browser = await chromium.launch({ headless: process.env.HEADLESS !== '0', executablePath: EXE, args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, ignoreHTTPSErrors: true });
await ctx.addInitScript((t) => { globalThis.VOXIM_SESSION_TOKEN = t; }, token);
const page = await ctx.newPage();
await page.goto(CLIENT, { waitUntil: 'domcontentloaded' });
await page.getByText('Enter the world', { exact: false }).click({ timeout: 8000 }).catch(() => {});

const isJoined = () => page.evaluate(() => {
  const g = globalThis._voxim_game;
  return !!(g && g.playerId && g.world?.get && g.world.get(g.playerId));
}).catch(() => false);
for (let i = 0; i < 60; i++) { if (await isJoined()) break; await page.waitForTimeout(400); }
await page.waitForTimeout(1500); // let terrain/models settle

if (process.env.BYPASS) {
  await page.evaluate(() => globalThis._voxim_game?.renderer?.toggleBypassPostFX?.());
}

const result = await page.evaluate(async (ms) => {
  const g = globalThis._voxim_game;
  let frames = 0;
  const glSamples = [];
  const start = performance.now();
  await new Promise((resolve) => {
    const tick = () => {
      frames++;
      const ft = g?.renderer?.frameTimings;
      if (ft) glSamples.push(ft.glMs);
      if (performance.now() - start < ms) requestAnimationFrame(tick);
      else resolve();
    };
    requestAnimationFrame(tick);
  });
  const elapsed = performance.now() - start;
  const ft = g?.renderer?.frameTimings || {};
  const avg = (a) => a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
  return {
    fps: +(frames * 1000 / elapsed).toFixed(1),
    frames,
    elapsedMs: +elapsed.toFixed(0),
    glMsAvg: +avg(glSamples).toFixed(2),
    glMsMax: +Math.max(0, ...glSamples).toFixed(2),
    drawCalls: ft.drawCalls ?? 0,
    tris: ft.tris ?? 0,
    dpr: globalThis.devicePixelRatio,
  };
}, MS);

console.log(JSON.stringify(result));
await browser.close();
