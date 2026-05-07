/**
 * Atlas inspector — single-page edit/bake/tune tool.
 *
 *   Layout: left bake form | main canvas (world or tile view) | right context panel
 *
 *   Routing (URL hash): #world (default) | #tile/<x>/<y>
 *
 *   State:
 *     - activeWorld    — fetched at boot from GET /world
 *     - defaults       — fetched once from GET /genparams/defaults
 *     - formParams     — what the bake form is editing (clones activeWorld.params)
 *     - formMeta       — { name, seed, width, height } the bake form is editing
 *
 *   Bake flow:
 *     1. POST /world/bake with body { name, seed, width, height, params }.
 *     2. Atlas inserts a new worlds row + cells + tile_init.
 *     3. Tile-server + coordinator's polling loops detect the new world
 *        within ~5s and exit; docker restarts them against the new world.
 *     4. Inspector polls GET /world; when world.id changes, full reload.
 */

const canvas    = document.getElementById("canvas");
const ctx       = canvas.getContext("2d");
const meta      = document.getElementById("meta");
const crumbs    = document.getElementById("crumbs");
const aside     = document.getElementById("context");
const bakeForm  = document.getElementById("bake-form");
const activeBadge = document.getElementById("active-world");
const toastEl   = document.getElementById("toast");

let view = null;          // "world" | "tile"
let world = null;         // { world, cells } from GET /world
let summaries = null;     // Map<"x,y", number>
let worldBbox = null;
let tile = null;          // { tileId, cellX, cellY, payload, world } from GET /tile/x/y
let tileLayer = "rooms";  // "rooms" | "height" | "materials" | "kinds"
let defaults = null;      // GenParams from GET /genparams/defaults
let presets = null;       // Record<key, {name, description, params}> from /genparams/presets
let formParams = null;    // GenParams currently in the form (matches input values)
let formMeta = { name: "", seed: 1, width: 2, height: 2 };

const NO_GATE = 0xF;
const EDGE_NIBBLE = { north: 0, east: 1, south: 2, west: 3 };
function nibbleAt(s, e) { return (s >> (EDGE_NIBBLE[e] * 4)) & 0xF; }
function reachable(s, a, b) {
  const na = nibbleAt(s, a), nb = nibbleAt(s, b);
  return na !== NO_GATE && nb !== NO_GATE && na === nb;
}

// ---- per-knob input config -----------------------------------------------
// step + min/max per slice. Keys missing here default to step 0.01, no bounds.

const KNOB_CONFIG = {
  biome: {
    frequency:       { step: 0.01, min: 0.01 },
    octaves:         { step: 1, min: 1, max: 8, integer: true },
    biasTemperature: { step: 0.05, min: -1, max: 1 },
    biasMoisture:    { step: 0.05, min: -1, max: 1 },
    biasAltitude:    { step: 0.05, min: -1, max: 1 },
    biasRuggedness:  { step: 0.05, min: -1, max: 1 },
  },
  river: {
    sourceAltitude: { step: 0.01, min: 0, max: 1 },
    minSeparation:  { step: 1, min: 0, integer: true },
    widthPixels:    { step: 1, min: 1, max: 16, integer: true },
  },
  noise: {
    baseFrequency:               { step: 0.001, min: 0 },
    extraFrequencyPerRuggedness: { step: 0.001 },
    baseThreshold:               { step: 0.05 },
    extraThresholdPerRuggedness: { step: 0.05 },
    octaves:                     { step: 1, min: 1, max: 8, integer: true },
  },
  terrain: {
    wallHeight:        { step: 0.5, min: 0.75 },
    floorBaseline:     { step: 0.5 },
    floorModAmplitude: { step: 0.1, min: 0 },
    floorModFrequency: { step: 0.005, min: 0 },
  },
  room: {
    targetCount:         { step: 1, min: 1, max: 64, integer: true },
    minSeparation:       { step: 4, min: 8, max: 384, integer: true },
    sizeMin:             { step: 25, min: 25, max: 30000, integer: true },
    sizeMax:             { step: 25, min: 25, max: 60000, integer: true },
    compactness:         { step: 0.05, min: 0, max: 2.0 },
    roomChanceBase:      { step: 0.05, min: 0, max: 1 },
    roomChancePerDegree: { step: 0.05, min: 0, max: 1 },
  },
  network: {
    maxEdgeLength:        { step: 8, min: 8, max: 1024, integer: true },
    loopRate:             { step: 0.05, min: 0, max: 1 },
    widthMin:             { step: 1, min: 0, max: 12, integer: true },
    widthMax:             { step: 1, min: 0, max: 12, integer: true },
    segments:             { step: 1, min: 1, max: 12, integer: true },
    curvature:            { step: 0.02, min: 0, max: 1.0 },
    bezierSamples:        { step: 10, min: 20, max: 800, integer: true },
    branchRate:           { step: 0.05, min: 0, max: 1 },
    branchMaxDepth:       { step: 1, min: 0, max: 5, integer: true },
    branchLengthFraction: { step: 0.05, min: 0, max: 1 },
  },
  kinds: {
    // Most kinds knobs are 0..1 thresholds (uniform default works);
    // the density stride is in world units, integer.
    forestDensityStride: { step: 1, min: 2, max: 64, integer: true },
  },
  // materials: every knob is a 0..1 threshold; uniform default.
};

// Tooltips per knob: short hint shown on hover so designers know which
// knob to reach for without re-reading the source.
const KNOB_HINT = {
  biome: {
    frequency:       "Lower → larger biome regions.",
    octaves:         "More → more detail at biome boundaries.",
    biasTemperature: "Push the WHOLE world warmer / cooler.",
    biasMoisture:    "Push the world wetter / drier (forest / desert).",
    biasAltitude:    "Push the world higher / lower (cliffs / valleys).",
    biasRuggedness:  "Push terrain rougher / smoother.",
  },
  river: {
    sourceAltitude: "Min altitude to start a river. Lower → more rivers.",
    minSeparation:  "Cells between river sources. Lower → denser.",
    widthPixels:    "River brush radius. Larger → wider rivers.",
  },
  noise: {
    baseFrequency:               "Higher → finer noise detail (chamber walls more wiggly).",
    extraFrequencyPerRuggedness: "How much frequency rises with ruggedness.",
    baseThreshold:               "Vestigial under chamber-flood gen. Used downstream.",
    extraThresholdPerRuggedness: "How threshold rises with ruggedness.",
    octaves:                     "More → wigglier chamber silhouettes.",
  },
  terrain: {
    wallHeight:        "Vertical step at cliff walls. Must exceed 0.75.",
    floorBaseline:     "Baseline ground height in open regions.",
    floorModAmplitude: "How bumpy the floor is.",
    floorModFrequency: "Bump frequency.",
  },
  room: {
    targetCount:         "How many JUNCTIONS per tile (graph nodes; only some become rooms).",
    minSeparation:       "Min spacing between junction seeds (px).",
    sizeMin:             "Smallest room pixel count when grown.",
    sizeMax:             "Largest room pixel count when grown.",
    compactness:         "Room shape tightness. 0 = noise lobes (snake), 0.3 = chunky organic, 1 = round Voronoi.",
    roomChanceBase:      "Probability a degree-1 junction becomes a room. Most stay invisible bends.",
    roomChancePerDegree: "Extra room chance per additional incident edge. Convergent junctions become rooms.",
  },
  network: {
    maxEdgeLength:        "Cap on chamber-to-chamber edge length (px). Bigger → longer corridors.",
    loopRate:             "Extra-corridor rate. 0 = tree (one path). 1 = full Delaunay net.",
    widthMin:             "Min corridor brush half-width. 0 = 1px wide path.",
    widthMax:             "Max corridor brush half-width. Each edge picks uniformly in range.",
    segments:             "Spline segments per corridor. 1 = single arc, 4 = winding, 8 = very twisty.",
    curvature:             "Per-waypoint perpendicular jitter (frac of edge length). 0 = straight polyline.",
    bezierSamples:         "Brush stamps PER SEGMENT. Total stamps ≈ segments × this.",
    branchRate:            "Per-corridor chance to spawn branch sub-paths. 0 = none, 1 = always (twice per attempt).",
    branchMaxDepth:        "Max branch recursion. 0 = disabled, 2-3 typical for maze feel.",
    branchLengthFraction:  "Branch length as fraction of parent. Halves at each recursion level.",
  },
  materials: {
    detailFrequency:           "Per-pixel material noise scale.",
    stoneAltitudeStrict:       "Above this altitude → stone (no other check).",
    stoneAltitudeRugged:       "Above this altitude AND rugged → stone.",
    stoneRuggednessThreshold:  "Ruggedness needed for the rugged-stone branch.",
    sandTemperature:           "Hot enough for sand.",
    sandMoisture:              "Below this moisture, hot pixels are sand.",
    waterMoisture:             "Wet enough for water puddles.",
    waterAltitude:             "Below this altitude, wet pixels can be water.",
    waterDetail:               "Detail-noise threshold for water puddles.",
    grassMoisture:             "Above this moisture, fall back to grass.",
  },
  kinds: {
    detailFrequency:           "Per-pixel kind noise scale.",
    stoneAltitudeStrict:       "Above this altitude → stone wall (no other check).",
    stoneAltitudeRugged:       "Above this altitude AND rugged → stone wall.",
    stoneRuggednessThreshold:  "Ruggedness needed for the rugged-stone branch.",
    forestMoisture:            "Above this moisture → forest wall (with trees). LOW → forest dominates.",
    forestDensityStride:       "Tree spawn stride (world units). Smaller → denser forest. ~2200 trees/tile @ 6.",
  },
};

const SLICE_LABELS = {
  biome:     "Biome",
  river:     "River",
  noise:     "Noise (room blobs emerge here)",
  room:      "Rooms (cleanup of noise blobs)",
  network:   "Network (corridor planning + carve)",
  terrain:   "Terrain (heightmap)",
  materials: "Materials",
  kinds:     "Boundary kinds",
};

// ---- routing ------------------------------------------------------------

addEventListener("hashchange", route);
addEventListener("resize", () => { resize(); redraw(); });
canvas.addEventListener("click", onCanvasClick);

bootstrap();

async function bootstrap() {
  [defaults, presets] = await Promise.all([
    fetch("genparams/defaults").then(r => r.json()).then(r => r.defaults),
    fetch("genparams/presets").then(r => r.json()).then(r => r.presets),
  ]);
  await loadActiveWorld();
  renderBakeForm();
  route();
  startActiveWorldPoller();
}

async function loadActiveWorld() {
  const res = await fetch("world").then(r => r.json());
  world = res; // { world: WorldRow, cells: [...] }
  if (world.world) {
    activeBadge.textContent =
      `${world.world.name} · ${world.world.width}×${world.world.height} · ` +
      `seed ${world.world.seed} · baked ${shortDate(world.world.bakedAt)}`;
    formParams = clone(world.world.params);
    formMeta = {
      name:   "",
      seed:   world.world.seed,
      width:  world.world.width,
      height: world.world.height,
    };
  } else {
    activeBadge.textContent = "no world baked";
    formParams = clone(defaults);
    formMeta = { name: "", seed: 1, width: 2, height: 2 };
  }
  // Summaries are world-scoped; reload them too.
  const sm = (await fetch("world/summaries").then(r => r.json())).summaries;
  summaries = new Map(sm.map(s => [`${s.cellX},${s.cellY}`, s.summary]));
  if (world.cells.length > 0) {
    worldBbox = world.cells.reduce((a, c) => ({
      minX: Math.min(a.minX, c.cellX), minY: Math.min(a.minY, c.cellY),
      maxX: Math.max(a.maxX, c.cellX), maxY: Math.max(a.maxY, c.cellY),
    }), { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
  }
}

function route() {
  const m = location.hash.match(/^#tile\/(-?\d+)\/(-?\d+)$/);
  if (m) loadTile(parseInt(m[1]), parseInt(m[2]));
  else { view = "world"; setCrumbs({ label: "World" }); renderContextWorld(); resize(); drawWorld(); }
}

function setCrumbs(...parts) {
  crumbs.innerHTML = parts.map((p, i) =>
    i === parts.length - 1
      ? `<span>${escape(p.label)}</span>`
      : `<a href="${p.href}">${escape(p.label)}</a><span class="sep">›</span>`
  ).join("");
}

// ---- bake form -----------------------------------------------------------

function renderBakeForm() {
  const html = [];

  // ---- preset picker ----
  const presetOpts = Object.entries(presets ?? {})
    .map(([k, p]) => `<option value="${escape(k)}">${escape(p.name)}</option>`)
    .join("");
  const activeDesc = "Pick a strong starting point, then tweak.";
  html.push(`<section>
    <h2>Preset</h2>
    <div class="row" style="gap:6px">
      <select id="preset" class="full"
        style="background:#0e0f12;color:var(--text);border:1px solid var(--border);padding:3px 6px;font:inherit;border-radius:3px;flex:1;">
        <option value="">— pick —</option>
        ${presetOpts}
      </select>
      <button id="preset-apply">Apply</button>
    </div>
    <div id="preset-desc" style="font-size:11px;color:var(--text-dim);margin-top:4px">${escape(activeDesc)}</div>
  </section>`);

  // ---- top-level meta ----
  html.push(`<section>
    <h2>Bake new world</h2>
    <div class="row"><label>Name</label>
      <input id="f-name" type="text" class="full" placeholder="bake-${nowSlug()}"></div>
    <div class="row"><label>Seed</label>
      <input id="f-seed" type="number" step="1" value="${formMeta.seed}"></div>
    <div class="row"><label>Width</label>
      <input id="f-width" type="number" step="1" min="1" max="32" value="${formMeta.width}"></div>
    <div class="row"><label>Height</label>
      <input id="f-height" type="number" step="1" min="1" max="32" value="${formMeta.height}"></div>
  </section>`);

  // ---- per-slice knob sections ----
  for (const slice of Object.keys(formParams)) {
    const knobs = Object.keys(formParams[slice]);
    html.push(`<details data-slice="${slice}">
      <summary>${SLICE_LABELS[slice] ?? slice} <span class="count">${knobs.length} knobs</span></summary>
      <div class="body">
        ${knobs.map(k => knobInput(slice, k, formParams[slice][k])).join("")}
        <div class="btn-row">
          <button class="flex" data-act="reset-slice" data-slice="${slice}">↺ defaults</button>
        </div>
      </div>
    </details>`);
  }

  html.push(`<section>
    <div class="btn-row">
      <button id="reset-all" class="flex">Reset all</button>
      <button id="bake" class="primary flex">Bake & restart</button>
    </div>
  </section>`);

  bakeForm.innerHTML = html.join("");

  // Preset hookup: select highlights description; "Apply" copies into form.
  const presetSel  = bakeForm.querySelector("#preset");
  const presetDesc = bakeForm.querySelector("#preset-desc");
  presetSel.addEventListener("change", () => {
    const p = presets[presetSel.value];
    presetDesc.textContent = p ? p.description : "Pick a strong starting point, then tweak.";
  });
  bakeForm.querySelector("#preset-apply").addEventListener("click", () => {
    const p = presets[presetSel.value];
    if (!p) return;
    formParams = clone(p.params);
    if (!formMeta.name) formMeta.name = `${presetSel.value}-${nowSlug()}`;
    renderBakeForm();
    toast("info", `Loaded preset "${p.name}". Tweak and bake.`);
  });

  // Wire input listeners — each updates formParams + flags the slice as dirty.
  for (const slice of Object.keys(formParams)) {
    for (const k of Object.keys(formParams[slice])) {
      const el = document.getElementById(`f-${slice}-${k}`);
      if (!el) continue;
      el.addEventListener("input", () => {
        formParams[slice][k] = parseFloat(el.value);
        markDirty(slice, k, formParams[slice][k] !== defaults[slice][k]);
      });
      // Initial dirty marker.
      markDirty(slice, k, formParams[slice][k] !== defaults[slice][k]);
    }
  }
  for (const m of ["name", "seed", "width", "height"]) {
    document.getElementById(`f-${m}`).addEventListener("input", (e) => {
      formMeta[m] = m === "name" ? e.target.value : parseFloat(e.target.value);
    });
  }
  bakeForm.querySelector("#bake").addEventListener("click", onBake);
  bakeForm.querySelector("#reset-all").addEventListener("click", () => {
    formParams = clone(defaults);
    renderBakeForm();
  });
  for (const btn of bakeForm.querySelectorAll('[data-act="reset-slice"]')) {
    btn.addEventListener("click", () => {
      const s = btn.dataset.slice;
      formParams[s] = clone(defaults[s]);
      renderBakeForm();
    });
  }
}

function knobInput(slice, key, value) {
  const cfg  = KNOB_CONFIG[slice]?.[key] ?? { step: 0.01 };
  const hint = KNOB_HINT[slice]?.[key] ?? `${slice}.${key}`;
  const id = `f-${slice}-${key}`;
  const valStr = cfg.integer ? String(Math.round(value)) : String(value);
  return `<div class="row">
    <label title="${escape(hint)}">${escape(key)}</label>
    <input id="${id}" type="number" title="${escape(hint)}"
      step="${cfg.step}"
      ${cfg.min !== undefined ? `min="${cfg.min}"` : ""}
      ${cfg.max !== undefined ? `max="${cfg.max}"` : ""}
      value="${valStr}">
  </div>`;
}

function markDirty(slice, key, isDirty) {
  const el = document.getElementById(`f-${slice}-${key}`);
  if (!el) return;
  el.classList.toggle("dirty", isDirty);
}

async function onBake() {
  const btn = bakeForm.querySelector("#bake");
  btn.disabled = true;
  btn.textContent = "Baking…";
  toast("info", "Baking new world…");
  try {
    const body = {
      ...formMeta,
      name: formMeta.name || `bake-${nowSlug()}`,
      params: formParams,
    };
    const res = await fetch("world/bake", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    const { baked } = await res.json();
    toast("good", `Baked "${baked.name}". Services will restart in a few seconds…`);
    awaitWorldChange(baked.id);
  } catch (e) {
    toast("bad", `Bake failed: ${e.message}`);
    btn.disabled = false;
    btn.textContent = "Bake & restart";
  }
}

/**
 * Poll /world until the active world id matches `expectedId`. When it does,
 * the inspector reloads the page so all canvas state, summaries, etc.
 * regenerate from the new world.
 */
async function awaitWorldChange(expectedId) {
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    try {
      const r = await fetch("world").then(r => r.json());
      if (r.world?.id === expectedId) {
        toast("good", "New world live. Reloading…");
        await sleep(500);
        location.reload();
        return;
      }
    } catch { /* keep polling */ }
  }
  toast("bad", "Bake landed but services didn't pick it up within 30s. Check logs.");
}

/**
 * After page load, keep checking whether someone ELSE baked a new world
 * (e.g. via curl) and reload to reflect it. Slow cadence (10s) so it
 * doesn't compete with bake-driven polling.
 */
function startActiveWorldPoller() {
  const initialId = world?.world?.id;
  setInterval(async () => {
    try {
      const r = await fetch("world").then(r => r.json());
      if (r.world?.id && r.world.id !== initialId) location.reload();
    } catch { /* ignore */ }
  }, 10_000);
}

// ---- world view ----------------------------------------------------------

function renderContextWorld() {
  if (!world?.world) {
    aside.innerHTML = `<section><div>no world baked yet</div></section>`;
    return;
  }
  aside.innerHTML = `
    <section class="info">
      <h2>Active world</h2>
      <dl>
        <dt>name</dt><dd>${escape(world.world.name)}</dd>
        <dt>id</dt><dd>${escape(world.world.id.slice(0, 8))}…</dd>
        <dt>seed</dt><dd>${world.world.seed}</dd>
        <dt>dims</dt><dd>${world.world.width}×${world.world.height}</dd>
        <dt>baked</dt><dd>${shortDate(world.world.bakedAt)}</dd>
        <dt>cells</dt><dd>${world.cells.length}</dd>
        <dt>summaries</dt><dd>${summaries?.size ?? 0}</dd>
      </dl>
    </section>
    <section>
      <h2>Channels → colour</h2>
      <div class="legend">
        <div><span class="swatch" style="background:#ff4040"></span>R = temperature</div>
        <div><span class="swatch" style="background:#40ff40"></span>G = moisture</div>
        <div><span class="swatch" style="background:#4080ff"></span>B = altitude</div>
        <div><span class="swatch" style="background:#fff;border:1px solid #444"></span>· = gate</div>
      </div>
    </section>
    <section><h2>Click a cell to drill in</h2></section>
  `;
}

function worldLayout() {
  if (!world?.cells?.length || !worldBbox) return null;
  const w = worldBbox.maxX - worldBbox.minX + 1;
  const h = worldBbox.maxY - worldBbox.minY + 1;
  const margin = 24;
  const availW = canvas.clientWidth  - 2 * margin;
  const availH = canvas.clientHeight - 2 * margin;
  const cellPx = Math.floor(Math.min(availW / w, availH / h));
  const originX = margin + (availW - cellPx * w) / 2;
  const originY = margin + (availH - cellPx * h) / 2;
  return { cellPx, originX, originY };
}

function drawWorld() {
  ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
  const layout = worldLayout(); if (!layout) return;
  for (const c of world.cells) drawWorldCell(c, layout);
  for (const c of world.cells) drawConnectivityFor(c, layout);
  for (const c of world.cells) drawRiversFor(c, layout);
  meta.textContent = `${world.cells.length} cells · ${summaries.size} tile summaries`;
}

function drawWorldCell(c, layout) {
  const { cellPx, originX, originY } = layout;
  const x = originX + (c.cellX - worldBbox.minX) * cellPx;
  const y = originY + (c.cellY - worldBbox.minY) * cellPx;
  const r = Math.round(c.biome.temperature * 255);
  const g = Math.round(c.biome.moisture    * 255);
  const b = Math.round(c.biome.altitude    * 255);
  ctx.fillStyle = `rgb(${r},${g},${b})`;
  ctx.fillRect(x, y, cellPx - 1, cellPx - 1);

  ctx.fillStyle = "#fff";
  const dotR = Math.max(2, Math.round(cellPx * 0.04));
  const tile = 512;
  for (const edge of ["north", "east", "south", "west"]) {
    const g = c.gates[edge]; if (!g) continue;
    const along = g.offset / tile * cellPx;
    let gx, gy;
    if (edge === "north") { gx = x + along;     gy = y; }
    if (edge === "south") { gx = x + along;     gy = y + cellPx - 1; }
    if (edge === "west")  { gx = x;             gy = y + along; }
    if (edge === "east")  { gx = x + cellPx - 1; gy = y + along; }
    ctx.beginPath();
    ctx.arc(gx, gy, dotR, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawRiversFor(c, layout) {
  if (!c.rivers || c.rivers.length === 0) return;
  const { cellPx, originX, originY } = layout;
  const x0 = originX + (c.cellX - worldBbox.minX) * cellPx;
  const y0 = originY + (c.cellY - worldBbox.minY) * cellPx;
  const tile = 512;
  const u2px = cellPx / tile;
  const endpointToCanvas = (e) => {
    if (e.edge !== undefined && e.offset !== undefined) {
      const along = e.offset * u2px;
      switch (e.edge) {
        case "north": return [x0 + along,         y0];
        case "south": return [x0 + along,         y0 + cellPx - 1];
        case "west":  return [x0,                 y0 + along];
        case "east":  return [x0 + cellPx - 1,    y0 + along];
      }
    }
    return [x0 + (e.x ?? 0) * u2px, y0 + (e.y ?? 0) * u2px];
  };
  ctx.strokeStyle = "#3070ff";
  ctx.lineWidth = Math.max(2, cellPx * 0.04);
  ctx.lineCap = "round";
  for (const seg of c.rivers) {
    const [ax, ay] = endpointToCanvas(seg.a);
    const [bx, by] = endpointToCanvas(seg.b);
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
    ctx.stroke();
  }
}

function drawConnectivityFor(c, layout) {
  const summary = summaries.get(`${c.cellX},${c.cellY}`);
  if (summary === undefined) return;
  const { cellPx, originX, originY } = layout;
  const x = originX + (c.cellX - worldBbox.minX) * cellPx;
  const y = originY + (c.cellY - worldBbox.minY) * cellPx;
  const tile = 512;
  const points = {};
  for (const edge of ["north", "east", "south", "west"]) {
    const g = c.gates[edge]; if (!g) continue;
    const along = g.offset / tile * cellPx;
    let gx, gy;
    if (edge === "north") { gx = x + along;     gy = y; }
    if (edge === "south") { gx = x + along;     gy = y + cellPx - 1; }
    if (edge === "west")  { gx = x;             gy = y + along; }
    if (edge === "east")  { gx = x + cellPx - 1; gy = y + along; }
    points[edge] = { gx, gy };
  }
  ctx.strokeStyle = "rgba(255,255,255,0.7)";
  ctx.lineWidth = Math.max(1, cellPx * 0.015);
  const edges = ["north", "east", "south", "west"];
  for (let i = 0; i < edges.length; i++) {
    for (let j = i + 1; j < edges.length; j++) {
      if (!reachable(summary, edges[i], edges[j])) continue;
      const a = points[edges[i]], b = points[edges[j]];
      if (!a || !b) continue;
      ctx.beginPath();
      ctx.moveTo(a.gx, a.gy);
      ctx.lineTo(b.gx, b.gy);
      ctx.stroke();
    }
  }
}

// ---- tile view -----------------------------------------------------------

async function loadTile(cellX, cellY) {
  view = "tile";
  meta.textContent = `loading tile (${cellX},${cellY})…`;
  const res = await fetch(`tile/${cellX}/${cellY}`);
  if (!res.ok) {
    meta.textContent = await res.text();
    return;
  }
  tile = await res.json();
  meta.textContent = `tile ${tile.tileId} · seed ${tile.seed} · ${tile.payload.chambers.length} chambers · ${(tile.payload.corridors ?? []).length} corridors · ${tile.payload.rooms.length} components · ${tile.payload.portals.length} portals`;
  setCrumbs({ label: "World", href: "#world" }, { label: `Tile (${cellX},${cellY})` });
  renderContextTile(cellX, cellY);
  resize();
  drawTile();
}

function renderContextTile(cellX, cellY) {
  const p = tile.payload;
  const portalsHtml = p.portals.map((p) =>
    `<dt>portal ${p.edge}</dt><dd>room ${p.roomId}</dd>`
  ).join("");
  aside.innerHTML = `
    <section>
      <button class="full" id="back">← world</button>
    </section>
    <section>
      <h2>Layer</h2>
      <div class="btn-row" style="flex-wrap:wrap">
        <button data-layer="rooms"     class="flex">rooms</button>
        <button data-layer="height"    class="flex">height</button>
        <button data-layer="materials" class="flex">materials</button>
        <button data-layer="kinds"     class="flex">kinds</button>
      </div>
    </section>
    <section>
      <button class="full" id="tregen">Regenerate this tile</button>
    </section>
    <section class="info">
      <h2>Tile</h2>
      <dl>
        <dt>cell</dt><dd>(${cellX}, ${cellY})</dd>
        <dt>tile size</dt><dd>${p.tileSize}u</dd>
        <dt>grid</dt><dd>${p.gridSize}² (${(p.tileSize/p.gridSize).toFixed(1)}u/px)</dd>
        <dt>chambers</dt><dd>${p.chambers.length}</dd>
        <dt>corridors</dt><dd>${(p.corridors ?? []).length}</dd>
        <dt>components</dt><dd>${p.rooms.length}</dd>
        <dt>portals</dt><dd>${p.portals.length}</dd>
        ${portalsHtml}
      </dl>
    </section>
    ${renderSummarySection(p.gateSummary)}`;
  aside.querySelector("#back").addEventListener("click", () => { location.hash = "#world"; });
  aside.querySelector("#tregen").addEventListener("click", async () => {
    meta.textContent = "regenerating tile…";
    await fetch(`tile/${cellX}/${cellY}/regen`, { method: "POST" });
    await loadTile(cellX, cellY);
  });
  for (const btn of aside.querySelectorAll("[data-layer]")) {
    const layer = btn.dataset.layer;
    btn.style.borderColor = tileLayer === layer ? "var(--accent)" : "var(--border)";
    btn.style.color       = tileLayer === layer ? "var(--accent)" : "var(--text)";
    btn.addEventListener("click", () => {
      tileLayer = layer;
      renderContextTile(cellX, cellY);
      drawTile();
    });
  }
}

function renderSummarySection(summary) {
  const hex = "0x" + summary.toString(16).padStart(4, "0");
  const edges = ["north", "east", "south", "west"];
  const labelOf = (e) => ({ north: "N", east: "E", south: "S", west: "W" })[e];
  const nib = (e) => {
    const n = nibbleAt(summary, e);
    return n === NO_GATE ? "·" : String(n);
  };
  const matrix = `
    <table style="border-collapse:collapse;font-size:11px;width:100%;text-align:center">
      <thead><tr><th></th>${edges.map((e) => `<th>${labelOf(e)}</th>`).join("")}</tr></thead>
      <tbody>
        ${edges.map((from) => `
          <tr>
            <th style="text-align:right;padding-right:6px;color:var(--text-dim)">${labelOf(from)}</th>
            ${edges.map((to) => {
              if (from === to) return `<td style="color:var(--text-dim)">—</td>`;
              const ok = reachable(summary, from, to);
              const naLeft  = nibbleAt(summary, from) === NO_GATE;
              const naRight = nibbleAt(summary, to)   === NO_GATE;
              const cls = ok ? "color:var(--accent)" : "color:var(--text-dim)";
              const ch  = ok ? "✓" : (naLeft || naRight) ? "·" : " ";
              return `<td style="${cls}">${ch}</td>`;
            }).join("")}
          </tr>`).join("")}
      </tbody>
    </table>`;
  return `
    <section class="info">
      <h2>Gate summary</h2>
      <dl>
        <dt>u16</dt><dd>${hex}</dd>
        <dt>N · E · S · W</dt><dd>${nib("north")} · ${nib("east")} · ${nib("south")} · ${nib("west")}</dd>
      </dl>
      ${matrix}
    </section>`;
}

function tileLayout() {
  if (!tile) return null;
  const g = tile.payload.gridSize;
  const margin = 24;
  const availW = canvas.clientWidth  - 2 * margin;
  const availH = canvas.clientHeight - 2 * margin;
  const px = Math.floor(Math.min(availW / g, availH / g));
  const originX = margin + (availW - px * g) / 2;
  const originY = margin + (availH - px * g) / 2;
  return { px, originX, originY, g };
}

function drawTile() {
  ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
  const layout = tileLayout(); if (!layout) return;
  if (tileLayer === "rooms")     drawTileRooms(layout);
  else if (tileLayer === "height")    drawTileHeight(layout);
  else if (tileLayer === "materials") drawTileMaterials(layout);
  else if (tileLayer === "kinds")     drawTileKinds(layout);

  // portals on top regardless of layer
  ctx.fillStyle = "#fff";
  ctx.strokeStyle = "#000";
  ctx.lineWidth = 1;
  const { px, originX, originY } = layout;
  const dotR = Math.max(3, Math.round(px * 0.6));
  for (const p of tile.payload.portals) {
    const cx = originX + p.pixelX * px + px / 2;
    const cy = originY + p.pixelY * px + px / 2;
    ctx.beginPath();
    ctx.arc(cx, cy, dotR, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
}

function drawTileRooms({ px, originX, originY, g }) {
  // Three-tone view of the room network:
  //   - closed pixels   → dark grey (the maze walls)
  //   - chamber pixels  → bright per-chamber colour
  //   - corridor pixels → light grey (open in openMask but not in any chamber)
  // Plus overlays: chamber centroids (black dots) and bezier centerlines
  // for each carved corridor (so the network reads as drawn paths).
  const openMask  = bytesFromB64(tile.payload.openMaskB64);
  const chamberOf = u16FromB64(tile.payload.chamberOfB64);
  rasterLayer({ px, originX, originY, g }, (idx, buf, p) => {
    if (openMask[idx] === 0) {
      buf[p] = 0x1a; buf[p+1] = 0x1c; buf[p+2] = 0x21; buf[p+3] = 0xff;
    } else {
      const cid = chamberOf[idx];
      const c = cid === 0xFFFF ? CORRIDOR_RGB : roomRGB[cid % roomRGB.length];
      buf[p] = c[0]; buf[p+1] = c[1]; buf[p+2] = c[2]; buf[p+3] = 0xff;
    }
  });
  // Catmull-Rom centerlines for each corridor — so the planned path
  // reads even when brush stamps blur into chamber colours. Same
  // formula as bezier_carve.ts: each segment becomes a cubic bezier
  // with control points derived from neighbouring waypoints.
  for (const c of (tile.payload.corridors ?? [])) {
    const w = c.waypoints ?? [];
    if (w.length < 2) continue;
    ctx.strokeStyle = c.kind === "portal" ? "#ffffff" : "#103848";
    ctx.lineWidth   = c.kind === "portal" ? 1.6 : 1.2;
    ctx.beginPath();
    const toCanvas = (p) => ({
      x: originX + p.x * px + px / 2,
      y: originY + p.y * px + px / 2,
    });
    const reflect = (pivot, near) => ({ x: 2*pivot.x - near.x, y: 2*pivot.y - near.y });
    ctx.moveTo(toCanvas(w[0]).x, toCanvas(w[0]).y);
    for (let i = 0; i < w.length - 1; i++) {
      const w0 = w[i - 1] ?? reflect(w[i], w[i + 1]);
      const w1 = w[i];
      const w2 = w[i + 1];
      const w3 = w[i + 2] ?? reflect(w[i + 1], w[i]);
      const c1 = toCanvas({
        x: w1.x + (w2.x - w0.x) / 6,
        y: w1.y + (w2.y - w0.y) / 6,
      });
      const c2 = toCanvas({
        x: w2.x - (w3.x - w1.x) / 6,
        y: w2.y - (w3.y - w1.y) / 6,
      });
      const end = toCanvas(w2);
      ctx.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, end.x, end.y);
    }
    ctx.stroke();
    // Tiny dots at each waypoint so designers can see the segment joins.
    ctx.fillStyle = c.kind === "portal" ? "#ffffff" : "#225466";
    for (const p of w) {
      const cv = toCanvas(p);
      ctx.beginPath();
      ctx.arc(cv.x, cv.y, 1.4, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  // Chamber centroids — small black dots so even tiny chambers read.
  ctx.fillStyle = "#000";
  for (const r of tile.payload.chambers) {
    const cxPx = originX + (r.cx / tile.payload.tileSize) * (g * px);
    const cyPx = originY + (r.cy / tile.payload.tileSize) * (g * px);
    ctx.beginPath();
    ctx.arc(cxPx, cyPx, Math.max(1.5, px * 0.4), 0, Math.PI * 2);
    ctx.fill();
  }
}

const roomColours = [
  "#f57676","#7edb8b","#7eb6f5","#f5d976","#c47ef5","#76e9f5",
  "#f59f76","#9af576","#769ff5","#f576c4","#76f5b6","#cdf576",
  "#f57676","#86f586","#86b6f5","#f5e186","#cb86f5","#86e9f5",
  "#f5a586","#a5f586","#86a5f5","#f586cb","#86f5b6","#d6f586",
];

function drawTileHeight({ px, originX, originY, g }) {
  const heightMap = f32FromB64(tile.payload.heightMapB64);
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < heightMap.length; i++) {
    if (heightMap[i] < min) min = heightMap[i];
    if (heightMap[i] > max) max = heightMap[i];
  }
  const range = Math.max(1e-6, max - min);
  rasterLayer({ px, originX, originY, g }, (idx, buf, p) => {
    const t = (heightMap[idx] - min) / range;
    buf[p]   = Math.round(40  + t * 215);
    buf[p+1] = Math.round(60  + t * 100);
    buf[p+2] = Math.round(150 - t * 110);
    buf[p+3] = 0xff;
  });
}

const MATERIAL_COLOURS = {
  0: "#222", 1: "#5a8b3f", 2: "#7a5a3a", 3: "#7a7a7a", 4: "#d8c878", 5: "#3070b8",
};

function drawTileMaterials({ px, originX, originY, g }) {
  const materials = u16FromB64(tile.payload.materialsB64);
  const openMask  = bytesFromB64(tile.payload.openMaskB64);
  rasterLayer({ px, originX, originY, g }, (idx, buf, p) => {
    const base = MATERIAL_RGB[materials[idx]] ?? FALLBACK_RGB;
    const dim = openMask[idx] === 0 ? 0.55 : 1.0;
    buf[p]   = Math.round(base[0] * dim);
    buf[p+1] = Math.round(base[1] * dim);
    buf[p+2] = Math.round(base[2] * dim);
    buf[p+3] = 0xff;
  });
}

// Boundary-kind palette. Ids match @voxim/atlas BOUNDARY_KIND_*:
//   0 OPEN (light grey), 1 STONE (slate), 2 FOREST (deep green),
//   3 WATER (blue), 4 GRASS_MOUND (bright green).
const KIND_COLOURS = {
  0: "#dadada", 1: "#7a7a7a", 2: "#2a5a2a", 3: "#3070b8", 4: "#7ac74a",
};

function drawTileKinds({ px, originX, originY, g }) {
  const kindOf = u16FromB64(tile.payload.kindOfB64);
  rasterLayer({ px, originX, originY, g }, (idx, buf, p) => {
    const c = KIND_RGB[kindOf[idx]] ?? FALLBACK_RGB;
    buf[p] = c[0]; buf[p+1] = c[1]; buf[p+2] = c[2]; buf[p+3] = 0xff;
  });
}

// Pre-parsed RGB tables — avoids hexToRGB on every pixel and lets the
// per-pixel layer functions write directly into the ImageData buffer.
function hexToRGB(hex) {
  const n = parseInt(hex.slice(1).length === 3
    ? hex.slice(1).split("").map(c => c + c).join("")
    : hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}
const roomRGB     = roomColours.map(hexToRGB);
const MATERIAL_RGB = Object.fromEntries(
  Object.entries(MATERIAL_COLOURS).map(([k, v]) => [k, hexToRGB(v)]),
);
const KIND_RGB = Object.fromEntries(
  Object.entries(KIND_COLOURS).map(([k, v]) => [k, hexToRGB(v)]),
);
const CORRIDOR_RGB = [0x9a, 0x9a, 0xa3];
const FALLBACK_RGB = [0x44, 0x44, 0x44];

// Single offscreen canvas reused across redraws; holds one layer at the
// tile's native gridSize. Per-pixel logic writes into the ImageData buffer
// (constant time for putImageData), then we drawImage scaled-up to the
// main canvas with smoothing off so the pixel grid stays crisp. This is
// ~50× faster than the per-pixel fillRect we used to do (essential at
// gridSize=512 where the loop is 262 144 pixels).
const _layerOff = document.createElement("canvas");
function rasterLayer({ px, originX, originY, g }, fillFn) {
  if (_layerOff.width !== g || _layerOff.height !== g) {
    _layerOff.width = g;
    _layerOff.height = g;
  }
  const ictx = _layerOff.getContext("2d");
  const data = ictx.createImageData(g, g);
  const buf = data.data;
  for (let i = 0; i < g * g; i++) fillFn(i, buf, i * 4);
  ictx.putImageData(data, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(_layerOff, 0, 0, g, g, originX, originY, g * px, g * px);
}

// ---- shared --------------------------------------------------------------

function resize() {
  canvas.width  = canvas.clientWidth  * devicePixelRatio;
  canvas.height = canvas.clientHeight * devicePixelRatio;
  ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
}

function redraw() {
  if (view === "world") drawWorld();
  else if (view === "tile") drawTile();
}

function onCanvasClick(e) {
  if (view !== "world") return;
  const layout = worldLayout(); if (!layout) return;
  const rect = canvas.getBoundingClientRect();
  const px = e.clientX - rect.left;
  const py = e.clientY - rect.top;
  const cx = Math.floor((px - layout.originX) / layout.cellPx) + worldBbox.minX;
  const cy = Math.floor((py - layout.originY) / layout.cellPx) + worldBbox.minY;
  const cell = world.cells.find((c) => c.cellX === cx && c.cellY === cy);
  if (!cell) return;
  location.hash = `#tile/${cx}/${cy}`;
}

function bytesFromB64(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
function u16FromB64(b64) { const b = bytesFromB64(b64); return new Uint16Array(b.buffer, b.byteOffset, b.byteLength / 2); }
function f32FromB64(b64) { const b = bytesFromB64(b64); return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4); }

function clone(o) { return JSON.parse(JSON.stringify(o)); }
function escape(s) { return String(s).replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c])); }
function nowSlug() { return new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-"); }
function shortDate(iso) { return new Date(iso).toLocaleString(undefined, { hour12: false, dateStyle: "short", timeStyle: "medium" }); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

let toastTimer = null;
function toast(kind, text) {
  toastEl.className = `toast show ${kind}`;
  toastEl.textContent = text;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.className = "toast"; }, 4000);
}
