// Test-play harness — drive the real browser client with Playwright so the agent
// can SEE (screenshot), DRIVE (input), READ (live world state), and CORRELATE
// client console + tile-server/gateway logs on one timeline to verify wiring.
//
// Auths against the gateway for a real session token, injects it, and connects in
// gateway mode (the docker tile validates tokens, so direct-tile/dev-token fails).
//
//   node scripts/testplay.mjs
//   OUT=/tmp/x.png STEPS='[["key","KeyW",800],["key","Digit1",0]]' node scripts/testplay.mjs
//   LOG_GREP='ActionDispatcher|Trigger|join' node scripts/testplay.mjs   # keep only matching log lines
//   HEADLESS=0 node scripts/testplay.mjs                                  # watch it live
import { chromium } from 'playwright';
import { execSync } from 'node:child_process';

const CLIENT  = process.env.CLIENT || 'http://localhost:14433/';
const GW      = process.env.GW     || 'http://localhost:8081';
const OUT     = process.env.OUT    || '/tmp/voxim_shot.png';
const HEADLESS = process.env.HEADLESS !== '0';
const EXE     = process.env.CHROME || '/home/work/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome';
const TILE_C  = process.env.TILE_C || 'voxim-tile-1-1';
const GW_C    = process.env.GW_C   || 'voxim-gateway-1';
const creds   = { loginName: process.env.USER_NAME || 'agentbot', password: 'agentbot-pass-123' };

// noise we never want in the correlated stream (per-second link retries, repeated GL warnings)
const DROP = /GatewayLink|unhandled rejection \(suppressed\): timed out|^\s*Error: timed out|THREE\.Material: parameter|willReadFrequently/;
const GREP = process.env.LOG_GREP ? new RegExp(process.env.LOG_GREP) : null;

async function auth() {
  for (const path of ['/account/login', '/account/register']) {
    const r = await fetch(GW + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(creds) }).catch(() => null);
    if (r?.ok) { const j = await r.json(); if (j.token) return j.token; }
  }
  throw new Error('auth failed against ' + GW);
}

function dockerLogs(container, src, sinceUnix) {
  try {
    const out = execSync(`docker logs -t --since ${sinceUnix} ${container} 2>&1`, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    return out.split('\n').filter(Boolean).map((line) => {
      const sp = line.indexOf(' ');
      const ts = Date.parse(line.slice(0, sp));
      return { t: Number.isNaN(ts) ? sinceUnix * 1000 : ts, src, msg: line.slice(sp + 1) };
    });
  } catch (e) {
    return [{ t: Date.now(), src, msg: `(docker logs ${container} failed: ${e.message})` }];
  }
}

const token = await auth();
console.log('auth ok (token len ' + token.length + ')');

const browser = await chromium.launch({ headless: HEADLESS, executablePath: EXE, args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, ignoreHTTPSErrors: true });
await ctx.addInitScript((t) => { globalThis.VOXIM_SESSION_TOKEN = t; }, token);
const page = await ctx.newPage();
const cli = [];
page.on('console', (m) => cli.push({ t: Date.now(), src: 'CLI', msg: `${m.type()}: ${m.text()}` }));
page.on('pageerror', (e) => cli.push({ t: Date.now(), src: 'CLI', msg: `pageerror: ${e.message}` }));

const sinceUnix = Math.floor(Date.now() / 1000);
await page.goto(CLIENT, { waitUntil: 'domcontentloaded' });

// wait until the local player entity exists (fully joined)
const isJoined = () => page.evaluate(() => {
  const g = globalThis._voxim_game;
  return !!(g && g.playerId && g.world?.get && g.world.get(g.playerId));
}).catch(() => false);
let joined = false;
for (let i = 0; i < 60 && !joined; i++) { joined = await isJoined(); if (!joined) await page.waitForTimeout(400); }
console.log('joined:', joined);

const posOf = () => page.evaluate(() => {
  const e = globalThis._voxim_game?.world?.get(globalThis._voxim_game.playerId);
  return e?.position ? { x: Math.round(e.position.x * 100) / 100, y: Math.round(e.position.y * 100) / 100 } : null;
}).catch(() => null);

const before = await posOf();
// input steps: [["key","KeyW",ms], ...]  — hold each `ms` then release
for (const [kind, code, ms] of (process.env.STEPS ? JSON.parse(process.env.STEPS) : [])) {
  if (kind === 'key') { await page.keyboard.down(code); await page.waitForTimeout(ms || 50); await page.keyboard.up(code); }
}
const after = await posOf();
console.log('pos', JSON.stringify(before), '->', JSON.stringify(after));

await page.waitForTimeout(1200);
await page.screenshot({ path: OUT });

const snap = await page.evaluate(() => {
  const g = globalThis._voxim_game;
  const hud = document.getElementById('ui')?.innerText ?? '';
  let ents = 0, me = null;
  try {
    ents = [...g.world.entries()].length;
    const e = g.world.get(g.playerId);
    if (e) me = { health: e.health, resource: e.resource && Object.fromEntries(Object.entries(e.resource.values).map(([k, v]) => [k, Math.round(v.value)])) };
  } catch { /* world shape drift */ }
  return { hud, ents, me };
}).catch((e) => ({ err: String(e) }));
console.log('entities:', snap.ents, '| me:', JSON.stringify(snap.me));
console.log('HUD:', JSON.stringify((snap.hud || '').replace(/\s+/g, ' ').trim().slice(0, 240)));

await browser.close();

// merge client + server logs on one timeline
let all = [...cli, ...dockerLogs(TILE_C, 'SRV', sinceUnix), ...dockerLogs(GW_C, 'GW', sinceUnix)]
  .filter((l) => !DROP.test(l.msg));
if (GREP) all = all.filter((l) => GREP.test(l.msg));
all.sort((a, b) => a.t - b.t);
const t0 = all.length ? all[0].t : Date.now();
console.log('--- correlated log: ' + all.length + ' lines (CLI/SRV/GW) ---');
for (const l of all.slice(-70)) console.log(`+${String(l.t - t0).padStart(6)}ms [${l.src}] ${l.msg}`);
console.log('screenshot:', OUT);
