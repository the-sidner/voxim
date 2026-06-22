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

// BLOCK_WORKER=1 simulates the bake-worker module failing to load (404 / wrong
// MIME / CSP) — the exact failure that wedged the model build and left the
// character unanimated. With the BakePool resilience fix the skeleton must
// still build via the synchronous fallback, so the animProbe assertions below
// have to pass even with the worker dead. This is the regression test for it.
if (process.env.BLOCK_WORKER) {
  await page.route('**/bake_worker.js', (r) => r.abort());
  console.log('BLOCK_WORKER: bake_worker.js routed to abort (sync-fallback test)');
}

const cli = [];
page.on('console', (m) => cli.push({ t: Date.now(), src: 'CLI', msg: `${m.type()}: ${m.text()}` }));
page.on('pageerror', (e) => cli.push({ t: Date.now(), src: 'CLI', msg: `pageerror: ${e.message}` }));

const sinceUnix = Math.floor(Date.now() / 1000);
await page.goto(CLIENT, { waitUntil: 'domcontentloaded' });

// Dismiss the character-creation screen if a fresh character lands on it (T-071):
// accept the default species and enter the world. No-op for existing characters.
await page.getByText("Enter the world", { exact: false }).click({ timeout: 8000 }).catch(() => {});

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
// input steps: [["key","KeyW",ms], ...]  — hold each `ms` then release.
// Drive through _voxim_game.testInput (the real IntentTranslator path) rather
// than page.keyboard, which the unfocusable canvas drops unreliably.
const keyDown = (code) => page.evaluate((c) => globalThis._voxim_game?.testInput.down(c), code);
const keyUp = (code) => page.evaluate((c) => globalThis._voxim_game?.testInput.up(c), code);
for (const [kind, code, ms] of (process.env.STEPS ? JSON.parse(process.env.STEPS) : [])) {
  if (kind === 'key') { await keyDown(code); await page.waitForTimeout(ms || 50); await keyUp(code); }
}
const after = await posOf();
console.log('pos', JSON.stringify(before), '->', JSON.stringify(after));

// ---- animation assertions (ANIM=1) ---------------------------------------
// Proves the character is actually animated, not frozen in its rest pose:
//   1. skeleton built (the bake pipeline produced bone groups)
//   2. a clip is playing at rest
//   3. idle keeps the limbs near-static
//   4. moving swaps in a locomotion clip AND the limbs visibly sweep
//   5. an attack drives a primary action (weaponActionId / arm sweep)
// Drives input through the real IntentTranslator path (testInput) and reads the
// live AnimationState + sampled bone world-positions via game.animProbe. Each
// check prints PASS/FAIL and the process exits non-zero on any failure so this
// doubles as a CI gate. Pair with BLOCK_WORKER=1 to prove the synchronous bake
// fallback still animates when the bake worker can't load.
let animFails = null;
if (process.env.ANIM) {
  const BONES = ['lower_leg_l', 'lower_leg_r', 'lower_arm_r', 'hand_r'];
  const probe = () => page.evaluate((bones) => {
    const g = globalThis._voxim_game;
    return g?.animProbe ? g.animProbe(undefined, bones) : { error: 'no animProbe' };
  }, BONES).catch((e) => ({ error: String(e) }));
  // Limb motion that survives the character sliding AND turning to face its
  // heading: the Euclidean distance between two bones is invariant under any
  // rigid-body transform, so it changes ONLY when the pose itself flexes. Across
  // the captured frames, take the largest swing (max−min) of any bone-pair gap —
  // a stride opens and closes the distance between contralateral limbs, while a
  // frozen rig holds every gap constant. (Centroid-subtraction was too weak: in
  // a gait all limbs translate together, so it cancelled most of the signal and
  // walking read no higher than idle breathing.)
  const gaitRange = (frames) => {
    const valid = (frames || []).filter(Boolean);
    if (valid.length < 2) return 0;
    const keys = Object.keys(valid[0]).filter((k) => valid.every((f) => f[k]));
    let best = 0;
    for (let a = 0; a < keys.length; a++) for (let b = a + 1; b < keys.length; b++) {
      let lo = Infinity, hi = -Infinity;
      for (const f of valid) {
        const p = f[keys[a]], q = f[keys[b]];
        const d = Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
        if (d < lo) lo = d; if (d > hi) hi = d;
      }
      if (hi - lo > best) best = hi - lo;
    }
    return best;
  };
  const clipIds = (p) => (p.clips || []).map((c) => `${c.clipId}:${c.weight.toFixed(2)}`);
  // Hold `code` and sample the pose across a full motion cycle. Returns the peak
  // limb sweep (largest centered-pose change between ANY two of the N samples —
  // robust to phase aliasing, since a short two-sample window can land on two
  // similar phases and read ~0), whether a clip matching `clipRe` was ever
  // active, and how far the player translated (separates "input reached the
  // server" from "the pose animated"). One settle gap precedes sampling so
  // server-side state (locomotion / action phase) has engaged.
  const captureWhile = async (code, clipReSrc, { samples = 8, gapMs = 160, settleMs = 300, awaitMove = false, repress = false } = {}) => {
    // Run the whole hold→sample→release loop INSIDE one page.evaluate. Driving
    // the key and reading state across separate Playwright evaluates (with
    // waitForTimeout between) raced badly under BLOCK_WORKER — the held key
    // didn't translate into movement by sample time. A single in-page loop is
    // the pattern the EVAL diagnostic proved reliable in every mode.
    const raw = await page.evaluate(async (args) => {
      const g = globalThis._voxim_game;
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const pos = () => { const e = g.world.get(g.playerId); return e?.position ? { x: e.position.x, y: e.position.y } : null; };
      const re = new RegExp(args.clipReSrc, 'i');
      const start = pos();
      const inputReady = !!g.input;
      if (args.code) g.testInput.down(args.code); // code=null → passive idle-baseline capture
      const keyRegistered = (g.input?.keys?.size ?? 0) > 0;
      if (args.awaitMove) {
        for (let i = 0; i < 24; i++) { await sleep(150); const p = pos(); if (p && start && Math.hypot(p.x - start.x, p.y - start.y) > 0.2) break; }
      } else { await sleep(args.settleMs); }
      const frames = []; let clipSeen = false, actionSeen = false, midClips = [];
      for (let i = 0; i < args.samples; i++) {
        // repress: re-fire a one-shot action bit (e.g. attack) each sample so a
        // single press eaten by a sync-bake stall can't make the brief swing
        // window unobservable — keeps swinging until a sample lands mid-action.
        if (args.repress && args.code) g.testInput.down(args.code);
        await sleep(args.gapMs);
        const pr = g.animProbe(undefined, args.bones);
        frames.push(pr.bones);
        if ((pr.clips || []).some((c) => re.test(c.clipId))) clipSeen = true;
        if (pr.weaponActionId) actionSeen = true;
        if (i === (args.samples >> 1)) midClips = (pr.clips || []).map((c) => `${c.clipId}:${c.weight.toFixed(2)}`);
      }
      if (args.code) g.testInput.up(args.code);
      const end = pos();
      const moved = start && end ? Math.hypot(end.x - start.x, end.y - start.y) : 0;
      return { frames, clipSeen, actionSeen, midClips, moved, inputReady, keyRegistered, start, end };
    }, { code, clipReSrc, samples, gapMs, settleMs, awaitMove, repress, bones: BONES }).catch((e) => ({ frames: [], clipSeen: false, actionSeen: false, midClips: [`err:${e}`], moved: 0 }));
    return { sweep: gaitRange(raw.frames), clipSeen: raw.clipSeen, actionSeen: raw.actionSeen, moved: raw.moved, clips: raw.midClips, inputReady: raw.inputReady, keyRegistered: raw.keyRegistered, start: raw.start, end: raw.end };
  };
  const checks = [];
  const ok = (name, cond, detail) => { checks.push({ name, pass: !!cond }); console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name} — ${detail}`); };

  console.log('--- ANIM checks ---');
  // The rig builds asynchronously (bake → upgradeToSkeletonModel), so poll for
  // it rather than sampling once. This is the load-bearing check for the
  // BakePool fix: under BLOCK_WORKER it must STILL flip true via the sync bake.
  let rest0 = await probe();
  for (let i = 0; i < 25 && !rest0.hasSkeleton; i++) { await page.waitForTimeout(120); rest0 = await probe(); }
  ok('skeleton built (rig present)', rest0.hasSkeleton, `hasSkeleton=${rest0.hasSkeleton}`);
  ok('a clip plays at rest', (rest0.clips || []).some((c) => c.weight > 0), `clips=${JSON.stringify(clipIds(rest0))}`);

  // Passive idle baseline (no key) — same metric as the walk, so the walking bar
  // is "distinctly more limb motion than just standing there".
  const idle = await captureWhile(null, 'idle', { samples: 6, gapMs: 150 });
  ok('idle keeps limbs near-static', idle.clipSeen || idle.sweep < 0.1, `idleSweep=${idle.sweep.toFixed(3)} clips=${JSON.stringify(idle.clips)}`);
  // The walk must flex the limbs distinctly more than idle, with an absolute
  // floor so a near-zero baseline can't make the bar trivially easy.
  const SWEEP_MIN = Math.max(0.06, idle.sweep * 3);

  // Locomotion: the headless player has a FIXED facing (no cursor) so a movement
  // key always pushes one world direction, and its position PERSISTS between
  // runs — a prior run can leave it wedged against terrain on that side, so a
  // single key reads moved=0 not because locomotion is broken but because the
  // wall is there. Try directions until one is clear; locomotion is proven by
  // ANY direction translating, and we don't care which way is open.
  const fmt = (p) => p ? `[${p.x.toFixed(1)},${p.y.toFixed(1)}]` : 'null';
  let walk = null, walkDir = 'KeyW';
  for (const dir of ['KeyW', 'KeyS', 'KeyA', 'KeyD']) {
    walkDir = dir;
    walk = await captureWhile(dir, 'walk|run|loco|move', { awaitMove: true });
    if (walk.moved > 0.3) break;
  }
  ok('player translates on movement input', walk.moved > 0.3, `moved=${walk.moved.toFixed(2)} via ${walkDir} ${fmt(walk.start)}->${fmt(walk.end)} (inputReady=${walk.inputReady} keyReg=${walk.keyRegistered})`);
  ok('locomotion clip while moving', walk.clipSeen, `clips=${JSON.stringify(walk.clips)}`);
  ok('limbs sweep while moving', walk.sweep > SWEEP_MIN, `walkSweep=${walk.sweep.toFixed(3)} (>${SWEEP_MIN.toFixed(3)}, idle=${idle.sweep.toFixed(3)})`);

  // Mid-walk screenshot for the human "looks good" gate — a dedicated brief hold
  // in the proven-clear direction so the frame is a genuine walking pose (the
  // metric loop above holds the page busy in one evaluate, uncapturable
  // mid-stride; and the walking clip is velocity-derived, so it must be moving).
  await keyDown(walkDir); await page.waitForTimeout(650);
  await page.screenshot({ path: OUT.replace(/\.png$/, '_walk.png') });
  await keyUp(walkDir);

  // A swing is brief; sample a tighter, faster window and accept either a named
  // weapon action on the wire or a clear arm sweep.
  const swing = await captureWhile('KeyZ', 'slash|swing|thrust|attack|stab', { samples: 12, gapMs: 80, settleMs: 80, repress: true });
  ok('attack drives a primary action', swing.actionSeen || swing.clipSeen || swing.sweep > SWEEP_MIN, `weaponAction=${swing.actionSeen} clips=${JSON.stringify(swing.clips)} swingSweep=${swing.sweep.toFixed(3)}`);

  const failed = checks.filter((c) => !c.pass);
  animFails = failed.length;
  console.log(`ANIM: ${checks.length - failed.length}/${checks.length} passed` + (failed.length ? ` — FAILED: ${failed.map((c) => c.name).join(', ')}` : ''));
}

// EVAL: run an arbitrary probe in page context after join. Body is a function
// body string with `game` (= globalThis._voxim_game) in scope; may be async.
if (process.env.EVAL) {
  const r = await page.evaluate((src) => {
    const fn = new Function('game', 'return (async () => {' + src + '\n})()');
    return fn(globalThis._voxim_game);
  }, process.env.EVAL).catch((e) => ({ evalError: String(e) }));
  console.log('EVAL →', JSON.stringify(r));
  await page.waitForTimeout(700); // let any dispatched command round-trip
}

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

// Exit non-zero when the ANIM gate ran and any animation check failed.
if (animFails) process.exitCode = 1;
