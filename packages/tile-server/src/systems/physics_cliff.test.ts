/**
 * Collision-agreement verification for terraced cliffs (T-311 P6 / T-318).
 *
 * Not new collision code — a REGRESSION-TEST + verification commit. Since
 * v1 terracing is vertical coursing within one wall cell's column (CliffGrid
 * selects which course to stack; Heightmap stays byte-identical to the
 * pre-P6 single-wallStep output), `buildTerrainLookup`/`buildOpennessLookup`
 * never read CliffGrid — confirmed by reading terrain_lookup.ts, which
 * queries only Heightmap/OpenMask. Collision agrees with the terraced
 * render "by construction", not via a new mechanism. These tests pin that
 * property down so it can't silently regress if a future phase makes
 * CliffGrid consulted for anything physics-adjacent.
 */
import { assert, assertEquals } from "jsr:@std/assert";
import { World } from "@voxim/engine";
import { stepPhysics, DEFAULT_PHYSICS } from "@voxim/engine";
import { createChunk, setChunkHeights, setChunkOpenness, setChunkCliffGrid, CHUNK_SIZE } from "@voxim/world";
import { buildTerrainLookup, buildOpennessLookup } from "../physics/terrain_lookup.ts";

const WALL_STEP = 2.0; // matches GenParams.terrain.wallHeight default

Deno.test("physics: a stone wall cell blocks step-up regardless of CliffGrid tier/erosion content", () => {
  const w = new World();
  const chunkId = createChunk(w, 0, 0);

  // Flat floor at 0, a wall cell at local (5, 5) raised by WALL_STEP.
  const heights = new Float32Array(CHUNK_SIZE * CHUNK_SIZE).fill(0);
  heights[5 + 5 * CHUNK_SIZE] = WALL_STEP;
  setChunkHeights(w, chunkId, heights);

  const open = new Uint8Array(CHUNK_SIZE * CHUNK_SIZE).fill(1);
  open[5 + 5 * CHUNK_SIZE] = 0;
  setChunkOpenness(w, chunkId, open);

  // CliffGrid marks this wall cell with a full erosion/tier/profile fill —
  // physics must not be affected by any of these values.
  const n = CHUNK_SIZE * CHUNK_SIZE;
  setChunkCliffGrid(w, chunkId, {
    profileId: new Uint8Array(n).fill(0).map((_, i) => (i === 5 + 5 * CHUNK_SIZE ? 3 : 0)),
    erosion: new Uint8Array(n).fill(0).map((_, i) => (i === 5 + 5 * CHUNK_SIZE ? 2 : 0)),
    tier: new Uint8Array(n).fill(0).map((_, i) => (i === 5 + 5 * CHUNK_SIZE ? 4 : 0)),
    edge: new Uint8Array(n).fill(0).map((_, i) => (i === 5 + 5 * CHUNK_SIZE ? 1 : 0)),
  });
  w.applyChangeset();

  const getHeight = buildTerrainLookup(w);
  const isOpen = buildOpennessLookup(w);

  // Player standing just south of the wall cell, walking north (-y) into it.
  let body = { position: { x: 5.5, y: 6.5, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, onGround: true };
  for (let t = 0; t < 40; t++) {
    body = stepPhysics(body, { movement: { x: 0, y: -1 }, jump: false }, getHeight, 1 / 20, DEFAULT_PHYSICS, isOpen);
  }

  // Blocked by openMask (the cell is closed) well before the wall's height
  // step would even come into play — position never crosses into the cell.
  assert(body.position.y > 5.9, `player must not walk through the wall cell, got y=${body.position.y}`);
  assertEquals(body.velocity.y, 0, "horizontal velocity zeroed on block");
});

Deno.test("physics: a raw wallStep is not step-up-walkable (stepHeight < wallStep)", () => {
  const w = new World();
  const chunkId = createChunk(w, 0, 0);

  const heights = new Float32Array(CHUNK_SIZE * CHUNK_SIZE).fill(0);
  // A wall band with NO openMask closure (isolates the height-step gate
  // alone, independent of the openMask block tested above).
  for (let lx = 4; lx < 8; lx++) heights[lx + 5 * CHUNK_SIZE] = WALL_STEP;
  setChunkHeights(w, chunkId, heights);
  w.applyChangeset();

  const getHeight = buildTerrainLookup(w);

  // Player approaches the wall band (cells at ly=5, i.e. y in [5,6)) from
  // the south, starting OUTSIDE it and walking north; no isOpen supplied —
  // isolates the pure stepHeight-vs-wallStep gate.
  let body = { position: { x: 5.5, y: 6.5, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, onGround: true };
  for (let t = 0; t < 20; t++) {
    body = stepPhysics(body, { movement: { x: 0, y: -1 }, jump: false }, getHeight, 1 / 20, DEFAULT_PHYSICS);
  }

  assert(DEFAULT_PHYSICS.stepHeight < WALL_STEP, "sanity: the config actually gates this wall (0.75 < 2.0)");
  // The wall step (2.0) exceeds stepHeight (0.75) — stepPhysics's wall
  // branch reverts horizontal movement rather than auto-stepping up.
  assert(body.position.y >= 6.0 - 1e-9, `player must not cross into the wall band, got y=${body.position.y}`);
  assert(body.position.z < WALL_STEP, "player is not lifted onto the wall top");
});

Deno.test("physics: a stair's smooth ramp is walkable while the adjacent CliffGrid-tagged wall still blocks", () => {
  const w = new World();
  const chunkId = createChunk(w, 0, 0);

  // A ramp lerping sub-stepHeight per cell from floor (y=10) up to the
  // plateau (y<=5, height=WALL_STEP) — mirrors applyStairUnlock's lerp.
  // Each cell rises 0.4u (< stepHeight 0.75), 5 cells deep, then the
  // plateau itself continues at WALL_STEP for ly<5 (a real plateau top,
  // not a cliff back down on the far side of the ramp).
  const heights = new Float32Array(CHUNK_SIZE * CHUNK_SIZE).fill(0);
  const rampRise = 0.4;
  for (let i = 0; i < 5; i++) {
    const ly = 9 - i; // y=9..5, rising toward the plateau
    heights[6 + ly * CHUNK_SIZE] = Math.min(WALL_STEP, (i + 1) * rampRise);
  }
  for (let ly = 0; ly < 5; ly++) heights[6 + ly * CHUNK_SIZE] = WALL_STEP; // the plateau top
  // Adjacent wall cells (one column over) stay raw wallStep, CliffGrid-tagged.
  for (let ly = 0; ly < CHUNK_SIZE; ly++) heights[4 + ly * CHUNK_SIZE] = WALL_STEP;
  setChunkHeights(w, chunkId, heights);

  const open = new Uint8Array(CHUNK_SIZE * CHUNK_SIZE).fill(1);
  for (let ly = 0; ly < CHUNK_SIZE; ly++) open[4 + ly * CHUNK_SIZE] = 0; // wall column closed
  setChunkOpenness(w, chunkId, open);

  const n = CHUNK_SIZE * CHUNK_SIZE;
  const profileId = new Uint8Array(n);
  const erosion = new Uint8Array(n);
  const tier = new Uint8Array(n);
  const edge = new Uint8Array(n);
  // Ramp column: stone_stair-equivalent (edge=0 — no stacking, matches a
  // smooth ramp). Wall column: edge=1, a real cliff profile.
  for (let ly = 0; ly < CHUNK_SIZE; ly++) {
    const wallIdx = 4 + ly * CHUNK_SIZE;
    edge[wallIdx] = 1;
    profileId[wallIdx] = 1;
  }
  setChunkCliffGrid(w, chunkId, { profileId, erosion, tier, edge });
  w.applyChangeset();

  const getHeight = buildTerrainLookup(w);
  const isOpen = buildOpennessLookup(w);

  // Walk up the ramp column (x=6.5) from y=9.9 toward the plateau (y<=5).
  // 20 ticks × (maxGroundSpeed=6 × dt=1/20 = 0.3u/tick) = 6u of travel —
  // enough to clear the 5-cell ramp and land just onto the plateau, not far
  // enough to walk off its far (north) edge into the void.
  let body = { position: { x: 6.5, y: 9.9, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, onGround: true };
  for (let t = 0; t < 20; t++) {
    body = stepPhysics(body, { movement: { x: 0, y: -1 }, jump: false }, getHeight, 1 / 20, DEFAULT_PHYSICS, isOpen);
  }
  assert(body.position.y < 5, `player must walk up the ramp onto the plateau, got y=${body.position.y}`);
  assert(Math.abs(body.position.z - WALL_STEP) < 1e-6, `player ends on the plateau surface, got z=${body.position.z}`);

  // Meanwhile the raw wall column (x=4.5, CliffGrid.edge=1) still blocks —
  // approach from OUTSIDE the wall (x=5.9, an open cell) walking west into it.
  let blocked = { position: { x: 5.9, y: 9.5, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, onGround: true };
  for (let t = 0; t < 40; t++) {
    blocked = stepPhysics(blocked, { movement: { x: -1, y: 0 }, jump: false }, getHeight, 1 / 20, DEFAULT_PHYSICS, isOpen);
  }
  assert(blocked.position.x >= 5.0 - 1e-9, `raw wall cell (CliffGrid edge) must still block, got x=${blocked.position.x}`);
});
