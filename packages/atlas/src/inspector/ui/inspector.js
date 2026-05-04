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
let worldBbox = null;
let tile = null; // { tileId, cellX, cellY, seed, payload: TileInitWire }

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
  const res = await fetch("/world");
  world = await res.json();
  if (world.cells.length === 0) {
    meta.textContent = "no worldmap";
    return;
  }
  worldBbox = world.cells.reduce((acc, c) => ({
    minX: Math.min(acc.minX, c.cellX), minY: Math.min(acc.minY, c.cellY),
    maxX: Math.max(acc.maxX, c.cellX), maxY: Math.max(acc.maxY, c.cellY),
  }), { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
  meta.textContent = `seed ${world.seed} · ${world.cells.length} cells`;
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
  for (const c of world.cells) drawWorldCell(c, layout);
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
    </section>`;
  document.getElementById("back").addEventListener("click", () => { location.hash = "#world"; });
  document.getElementById("tregen").addEventListener("click", async () => {
    meta.textContent = "regenerating tile…";
    await fetch(`/tile/${cellX}/${cellY}/regen`, { method: "POST" });
    await loadTile(cellX, cellY);
  });
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
  const openMask = bytesFromB64(tile.payload.openMaskB64);
  const roomOf = u16FromB64(tile.payload.roomOfB64);
  const roomColor = (id) => roomColours[id % roomColours.length];

  // pixel grid
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

  // portal dots on top
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
