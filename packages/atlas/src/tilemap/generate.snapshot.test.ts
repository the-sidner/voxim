/**
 * Determinism gate for the tilemap pipeline (T-204).
 *
 * Hashes every output field of `generateTile()` for a fixed matrix of
 * (worldCell, tileSeed, preset) triples. Asserts the hashes match a
 * checked-in expected set. Any divergence after a refactor — even a
 * single bit — fails the test loudly.
 *
 * Capture mode: set `ATLAS_SNAPSHOT_CAPTURE=1` to print actual hashes
 * (and skip the assertion). Paste them into EXPECTED below and re-run
 * without the env var to confirm.
 */

import { generateWorldMap } from "../worldmap/generate.ts";
import type { WorldCellRecord } from "../worldmap/types.ts";
import { generateTile } from "./generate.ts";
import { PRESETS } from "../genparams.ts";

// ---------- SHA-256 helpers ----------

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const owned = new Uint8Array(bytes.byteLength);
  owned.set(bytes);
  const buf = await crypto.subtle.digest("SHA-256", owned);
  const arr = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < arr.length; i++) s += arr[i].toString(16).padStart(2, "0");
  return s.slice(0, 16);
}

async function hashTypedArray(
  arr: Uint8Array | Uint16Array | Float32Array,
): Promise<string> {
  const bytes = new Uint8Array(arr.buffer as ArrayBuffer, arr.byteOffset, arr.byteLength);
  return await sha256Hex(bytes);
}

async function hashJson(v: unknown): Promise<string> {
  return await sha256Hex(new TextEncoder().encode(JSON.stringify(v)));
}

// ---------- fixture cells from a deterministic worldmap ----------

const WORLD_SEED = 0;
const world = generateWorldMap(WORLD_SEED, 4, 4);

function cell(cellX: number, cellY: number): WorldCellRecord {
  const c = world.cells[cellY * 4 + cellX];
  if (!c) throw new Error(`no world cell at (${cellX}, ${cellY})`);
  return c;
}

// ---------- snapshot matrix ----------

interface MatrixEntry {
  label:    string;
  cellX:    number;
  cellY:    number;
  tileSeed: number;
  presetId: keyof typeof PRESETS;
}

const MATRIX: MatrixEntry[] = [
  { label: "fm_a", cellX: 1, cellY: 1, tileSeed: 1001, presetId: "forest_maze" },
  { label: "fm_b", cellX: 2, cellY: 3, tileSeed: 2002, presetId: "forest_maze" },
  { label: "op",   cellX: 0, cellY: 2, tileSeed: 3003, presetId: "open_plains" },
  { label: "cd",   cellX: 3, cellY: 0, tileSeed: 4004, presetId: "cliff_dungeon" },
];

interface Snapshot {
  openMask:    string;
  roomOf:      string;
  chamberOf:   string;
  heightMap:   string;
  materials:   string;
  kindOf:      string;
  rooms:       string;
  chambers:    string;
  corridors:   string;
  portals:     string;
  gateSummary: string;
}

async function snapshot(entry: MatrixEntry): Promise<Snapshot> {
  const t = generateTile(cell(entry.cellX, entry.cellY), entry.tileSeed, {
    params: PRESETS[entry.presetId].params,
  });
  return {
    openMask:    await hashTypedArray(t.openMask),
    roomOf:      await hashTypedArray(t.roomOf),
    chamberOf:   await hashTypedArray(t.chamberOf),
    heightMap:   await hashTypedArray(t.heightMap),
    materials:   await hashTypedArray(t.materials),
    kindOf:      await hashTypedArray(t.kindOf),
    rooms:       await hashJson(t.rooms),
    chambers:    await hashJson(t.chambers),
    corridors:   await hashJson(t.corridors),
    portals:     await hashJson(t.portals),
    gateSummary: await hashJson(t.gateSummary),
  };
}

// ---------- expected hashes ----------
// Re-captured after `ensureUniformCoverage` post-pass added to the
// junctions stage. Bridson Poisson sometimes clustered junctions in
// one quadrant; the new 4×4 grid-coverage pass forces at least one
// junction per cell, producing path networks that span the full tile.

const EXPECTED: Record<string, Snapshot> = {
  fm_a: {
    openMask:    "d5621154aef7476a",
    roomOf:      "bf59211f474f5f75",
    chamberOf:   "d8ff9eeec54a5dff",
    heightMap:   "011a92967574f99c",
    materials:   "3f2f3535c3344667",
    kindOf:      "bb41a4a9b6de2d38",
    rooms:       "9390624dccb8b839",
    chambers:    "5c35da5fca68bf1b",
    corridors:   "0a73de8fdcf3b0c0",
    portals:     "a8dedc98f2d5fc2b",
    gateSummary: "5feceb66ffc86f38",
  },
  fm_b: {
    openMask:    "8e0afe3fe91a0281",
    roomOf:      "560dcb0132e57e3b",
    chamberOf:   "3eddaf3161a9b78b",
    heightMap:   "1ee9ff66404ad885",
    materials:   "b53c69ad553549de",
    kindOf:      "56cada30a3cc4de7",
    rooms:       "b4e9dce9f0ec0188",
    chambers:    "4de3b8c842596c42",
    corridors:   "20f7aa84b4c1a948",
    portals:     "781d156d70521333",
    gateSummary: "13105809c5b30ef1",
  },
  op: {
    openMask:    "06628066be5a6689",
    roomOf:      "be8ee2c91b9fa962",
    chamberOf:   "8684165dec7146be",
    heightMap:   "73786ff19708f59c",
    materials:   "48074956179dbce2",
    kindOf:      "66255bc352a41305",
    rooms:       "361fe4a73288d3dc",
    chambers:    "60fd4fa29b619a31",
    corridors:   "7216e46f4c06d0a4",
    portals:     "df4c4668b16d724e",
    gateSummary: "e33a45dab9360a01",
  },
  cd: {
    openMask:    "65955936df3f5c09",
    roomOf:      "d9aa5f17f4b78481",
    chamberOf:   "f096dd993173dcce",
    heightMap:   "4dfcb8cfaaa3d6d5",
    materials:   "41af755e607325b6",
    kindOf:      "2281506c356fa288",
    rooms:       "5f5b523e9fb5e27a",
    chambers:    "2b79506f3e0cc4cd",
    corridors:   "348b894aee2889be",
    portals:     "391d449bdfe63f8c",
    gateSummary: "7bd3edcdad6b99d3",
  },
};

// ---------- test ----------

Deno.test("tilemap generateTile: byte-identical output across pipeline matrix", async () => {
  const capture = Deno.env.get("ATLAS_SNAPSHOT_CAPTURE") === "1";
  const lines: string[] = [];
  let failed = false;

  for (const entry of MATRIX) {
    const actual = await snapshot(entry);
    const expected = EXPECTED[entry.label];
    if (capture) {
      lines.push(`  ${entry.label}: {`);
      for (const [k, v] of Object.entries(actual)) {
        lines.push(`    ${k}: ${" ".repeat(11 - k.length)}"${v}",`);
      }
      lines.push(`  },`);
      continue;
    }
    for (const [field, hash] of Object.entries(actual)) {
      const exp = expected[field as keyof Snapshot];
      if (hash !== exp) {
        failed = true;
        console.error(
          `[${entry.label}] field "${field}": expected ${exp}, got ${hash}`,
        );
      }
    }
  }

  if (capture) {
    console.log("\n--- snapshot capture output — paste into EXPECTED ---\n");
    console.log(lines.join("\n"));
    console.log("");
    return;
  }
  if (failed) {
    throw new Error("Tilemap snapshot mismatch — refactor changed output.");
  }
});
