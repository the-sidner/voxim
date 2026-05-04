/**
 * Atlas inspector — single-page, hash-routed.
 *
 *   #world           default. Shows the worldmap (cells coloured by biome,
 *                    gates as dots). Click a cell → drills into #tile/x/y.
 *   #tile/<x>/<y>    Per-tile view. Renders openMask (bg), rooms (coloured),
 *                    portals (white dots).
 */

const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");
const meta = document.getElementById("meta");
const crumbs = document.getElementById("crumbs");
const aside = document.getElementById("aside");

// ---- routing --------------------------------------------------------------

addEventListener("hashchange", route);
addEventListener("resize", () => { resize(); redraw(); });
canvas.addEventListener("click", onCanvasClick);

let view = null; // "world" | "tile"
let world = null; // { seed, cells: [...] }
let summaries = null; // Map<"x,y", number>  — gateSummary u16 per cell
let worldBbox = null;
let tile = null; // { tileId, cellX, cellY, seed, payload: TileInitWire }
let tileLayer = "rooms"; // "rooms" | "height"

const NO_GATE = 0xF;
const EDGE_NIBBLE = { north: 0, east: 1, south: 2, west: 3 };
function nibbleAt(summary, edge) { return (summary >> (EDGE_NIBBLE[edge] * 4)) & 0xF; }
function reachable(summary, a, b) {
  const na = nibbleAt(summary, a), nb = nibbleAt(summary, b);
  return na !== NO_GATE && nb !== NO_GATE && na === nb;
}

route();

function route() {
  const m = location.hash.match(/^#tile\/(-?\d+)\/(-?\d+)$/);
  if (m) loadTile(parseInt(m[1]), parseInt(m[2]));
  else loadWorld();
}

function setCrumbs(...parts) {
  crumbs.innerHTML = parts.map((p, i) =>
    i === parts.length - 1
      ? `<span>${p.label}</span>`
      : `<a href="${p.href}">${p.label}</a><span class="sep">›</span>`
  ).join("");
}

// ---- world view -----------------------------------------------------------

async function loadWorld() {
  view = "world";
  const [worldRes, summariesRes] = await Promise.all([
    fetch("/world").then((r) => r.json()),
    fetch("/world/summaries").then((r) => r.json()),
  ]);
  world = worldRes;
  summaries = new Map(summariesRes.summaries.map((s) => [`${s.cellX},${s.cellY}`, s.summary]));
  if (world.cells.length === 0) {
    meta.textContent = "no worldmap";
    return;
  }
  worldBbox = world.cells.reduce((acc, c) => ({
    minX: Math.min(acc.minX, c.cellX), minY: Math.min(acc.minY, c.cellY),
    maxX: Math.max(acc.maxX, c.cellX), maxY: Math.max(acc.maxY, c.cellY),
  }), { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
  meta.textContent = `seed ${world.seed} · ${world.cells.length} cells · ${summaries.size} tiles generated`;
  setCrumbs({ label: "World" });
  renderWorldAside();
  resize();
  drawWorld();
}

function renderWorldAside() {
  const w = worldBbox.maxX - worldBbox.minX + 1;
  const h = worldBbox.maxY - worldBbox.minY + 1;
  aside.innerHTML = `
    <section>
      <h2>Regenerate world</h2>
      <div class="row"><label for="seed">Seed</label><input id="seed" type="number" value="${world.seed}"></div>
      <div class="row"><label for="width">Width</label><input id="width" type="number" value="${w}"></div>
      <div class="row"><label for="height">Height</label><input id="height" type="number" value="${h}"></div>
      <button id="regen">Regenerate</button>
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
    <section class="selected">
      <h2>Cell</h2>
      <div id="selected">click a cell to drill in</div>
    </section>`;
  document.getElementById("regen").addEventListener("click", regenWorld);
}

async function regenWorld() {
  const seed   = parseInt(document.getElementById("seed").value);
  const width  = parseInt(document.getElementById("width").value);
  const height = parseInt(document.getElementById("height").value);
  meta.textContent = "regenerating…";
  await fetch(`/world/regen?seed=${seed}&width=${width}&height=${height}`, { method: "POST" });
  await loadWorld();
}

function worldLayout() {
  if (!world) return null;
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
  // Three passes: cells + gates first, connectivity arcs in the middle,
  // rivers on top so they read as the strongest world-layer feature.
  for (const c of world.cells) drawWorldCell(c, layout);
  for (const c of world.cells) drawConnectivityFor(c, layout);
  for (const c of world.cells) drawRiversFor(c, layout);
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

/**
 * Draw the cell's river segments as solid blue lines. Each segment goes
 * from a → b in tile-local coordinates; we map those into the cell's
 * canvas rect.
 */
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
        case "north": return [x0 + along,           y0];
        case "south": return [x0 + along,           y0 + cellPx - 1];
        case "west":  return [x0,                   y0 + along];
        case "east":  return [x0 + cellPx - 1,      y0 + along];
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

/**
 * For each pair of gates internally connected (same nibble in this cell's
 * gate-summary), draw an arc inside the cell linking the two gate dots.
 * Skips the cell entirely if no summary is available (tile not generated).
 */
function drawConnectivityFor(c, layout) {
  const summary = summaries.get(`${c.cellX},${c.cellY}`);
  if (summary === undefined) return;

  const { cellPx, originX, originY } = layout;
  const x = originX + (c.cellX - worldBbox.minX) * cellPx;
  const y = originY + (c.cellY - worldBbox.minY) * cellPx;
  const tile = 512;

  // Resolve each present edge to a {gx, gy} canvas point.
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

// ---- tile view ------------------------------------------------------------

async function loadTile(cellX, cellY) {
  view = "tile";
  meta.textContent = `loading tile (${cellX},${cellY})…`;
  const res = await fetch(`/tile/${cellX}/${cellY}`);
  if (!res.ok) {
    meta.textContent = await res.text();
    return;
  }
  tile = await res.json();
  meta.textContent = `tile ${tile.tileId} · seed ${tile.seed} · ${tile.payload.rooms.length} rooms · ${tile.payload.portals.length} portals`;
  setCrumbs({ label: "World", href: "#world" }, { label: `Tile (${cellX},${cellY})` });
  renderTileAside(cellX, cellY);
  resize();
  drawTile();
}

function renderTileAside(cellX, cellY) {
  const p = tile.payload;
  const portalsHtml = p.portals.map((p) =>
    `<dt>portal ${p.edge}</dt><dd>room ${p.roomId} · pixel (${p.pixelX},${p.pixelY})</dd>`
  ).join("");
  aside.innerHTML = `
    <section>
      <button id="back">← world</button>
    </section>
    <section>
      <h2>Layer</h2>
      <div class="row" style="gap:6px;flex-wrap:wrap">
        <button id="layer-rooms"     style="flex:1 1 45%">rooms</button>
        <button id="layer-height"    style="flex:1 1 45%">height</button>
        <button id="layer-materials" style="flex:1 1 45%">materials</button>
        <button id="layer-kinds"     style="flex:1 1 45%">kinds</button>
      </div>
    </section>
    <section>
      <h2>Regenerate tile</h2>
      <button id="tregen">Regenerate (${cellX},${cellY})</button>
    </section>
    <section class="info">
      <h2>Tile</h2>
      <dl>
        <dt>cell</dt><dd>(${cellX}, ${cellY})</dd>
        <dt>tile size</dt><dd>${p.tileSize}u</dd>
        <dt>grid</dt><dd>${p.gridSize}² (${(p.tileSize/p.gridSize).toFixed(1)}u/px)</dd>
        <dt>rooms</dt><dd>${p.rooms.length}</dd>
        <dt>portals</dt><dd>${p.portals.length}</dd>
        ${portalsHtml}
      </dl>
    </section>
    ${renderSummarySection(p.gateSummary)}`;
  document.getElementById("back").addEventListener("click", () => { location.hash = "#world"; });
  document.getElementById("tregen").addEventListener("click", async () => {
    meta.textContent = "regenerating tile…";
    await fetch(`/tile/${cellX}/${cellY}/regen`, { method: "POST" });
    await loadTile(cellX, cellY);
  });
  for (const layer of ["rooms", "height", "materials", "kinds"]) {
    const btn = document.getElementById(`layer-${layer}`);
    btn.style.borderColor = tileLayer === layer ? "var(--accent)" : "var(--border)";
    btn.style.color       = tileLayer === layer ? "var(--accent)" : "var(--text)";
    btn.addEventListener("click", () => {
      tileLayer = layer;
      renderTileAside(cellX, cellY);
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
  // Reachability matrix: 4×4. "—" diagonal, "✓" connected, blank otherwise.
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
              const cls = ok ? "color:var(--accent)" : (naLeft || naRight) ? "color:var(--text-dim)" : "color:var(--text-dim)";
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
  const { px, originX, originY, g } = layout;

  if (tileLayer === "rooms") drawTileRooms(layout);
  else if (tileLayer === "height") drawTileHeight(layout);
  else if (tileLayer === "materials") drawTileMaterials(layout);
  else if (tileLayer === "kinds") drawTileKinds(layout);

  // portal dots on top, regardless of layer
  ctx.fillStyle = "#fff";
  ctx.strokeStyle = "#000";
  ctx.lineWidth = 1;
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
  const openMask = bytesFromB64(tile.payload.openMaskB64);
  const roomOf = u16FromB64(tile.payload.roomOfB64);
  const roomColor = (id) => roomColours[id % roomColours.length];
  for (let py = 0; py < g; py++) {
    for (let pxi = 0; pxi < g; pxi++) {
      const idx = py * g + pxi;
      if (openMask[idx] === 0) {
        ctx.fillStyle = "#1a1c21";
      } else {
        const rid = roomOf[idx];
        ctx.fillStyle = rid === 0xFFFF ? "#444" : roomColor(rid);
      }
      ctx.fillRect(originX + pxi * px, originY + py * px, px, px);
    }
  }
}

// Atlas's MATERIAL_* ids → display colours. Stable mapping; tile-server
// will translate atlas ids to its own content registry separately.
const MATERIAL_COLOURS = {
  0: "#222",      // NONE
  1: "#5a8b3f",   // GRASS
  2: "#7a5a3a",   // DIRT
  3: "#7a7a7a",   // STONE
  4: "#d8c878",   // SAND
  5: "#3070b8",   // WATER
};

function drawTileMaterials({ px, originX, originY, g }) {
  const materials = u16FromB64(tile.payload.materialsB64);
  const openMask  = bytesFromB64(tile.payload.openMaskB64);
  for (let py = 0; py < g; py++) {
    for (let pxi = 0; pxi < g; pxi++) {
      const idx = py * g + pxi;
      const matId = materials[idx];
      const base = MATERIAL_COLOURS[matId] ?? "#444";
      // Closed pixels rendered slightly darker so the boundary structure
      // still reads through the material colour.
      ctx.fillStyle = openMask[idx] === 0 ? darken(base, 0.55) : base;
      ctx.fillRect(originX + pxi * px, originY + py * px, px, px);
    }
  }
}

function darken(hex, amount) {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.round(((n >> 16) & 0xff) * amount);
  const g = Math.round(((n >> 8)  & 0xff) * amount);
  const b = Math.round(( n        & 0xff) * amount);
  return `rgb(${r},${g},${b})`;
}

// Atlas's BOUNDARY_KIND_* ids → display colours.
const KIND_COLOURS = {
  0: "#dadada",   // OPEN — light, so it stays "background"
  1: "#7a7a7a",   // CLIFF — slate
  2: "#3f7a3a",   // VEGETATION — leafy
  3: "#3070b8",   // WATER — same blue as the materials layer
};

function drawTileKinds({ px, originX, originY, g }) {
  const kindOf = u16FromB64(tile.payload.kindOfB64);
  for (let py = 0; py < g; py++) {
    for (let pxi = 0; pxi < g; pxi++) {
      const idx = py * g + pxi;
      ctx.fillStyle = KIND_COLOURS[kindOf[idx]] ?? "#444";
      ctx.fillRect(originX + pxi * px, originY + py * px, px, px);
    }
  }
}

function drawTileHeight({ px, originX, originY, g }) {
  const heightMap = f32FromB64(tile.payload.heightMapB64);
  // Find min/max for normalised colouring.
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < heightMap.length; i++) {
    const h = heightMap[i];
    if (h < min) min = h;
    if (h > max) max = h;
  }
  const range = Math.max(1e-6, max - min);
  for (let py = 0; py < g; py++) {
    for (let pxi = 0; pxi < g; pxi++) {
      const idx = py * g + pxi;
      const t = (heightMap[idx] - min) / range;       // 0..1
      // Cool→warm gradient: low = blue, high = orange-red.
      const r = Math.round(40  + t * 215);
      const gr = Math.round(60 + t * 100);
      const b = Math.round(150 - t * 110);
      ctx.fillStyle = `rgb(${r},${gr},${b})`;
      ctx.fillRect(originX + pxi * px, originY + py * px, px, px);
    }
  }
}

// 24-room palette — pleasant distinct hues
const roomColours = [
  "#f57676","#7edb8b","#7eb6f5","#f5d976","#c47ef5","#76e9f5",
  "#f59f76","#9af576","#769ff5","#f576c4","#76f5b6","#cdf576",
  "#f57676","#86f586","#86b6f5","#f5e186","#cb86f5","#86e9f5",
  "#f5a586","#a5f586","#86a5f5","#f586cb","#86f5b6","#d6f586",
];

// ---- shared ---------------------------------------------------------------

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
  if (view === "world") {
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
}

function bytesFromB64(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function u16FromB64(b64) {
  const bytes = bytesFromB64(b64);
  return new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
}

function f32FromB64(b64) {
  const bytes = bytesFromB64(b64);
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
}
