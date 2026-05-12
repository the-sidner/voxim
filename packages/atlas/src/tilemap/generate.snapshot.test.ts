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

// ---------- expected hashes (captured pre-T-204 from atlas main) ----------

const EXPECTED: Record<string, Snapshot> = {
  fm_a: {
    openMask:    "28d811282306b06d",
    roomOf:      "d024f17fdf337cd3",
    chamberOf:   "4df09500b24825a2",
    heightMap:   "3a90d1468f8f1e71",
    materials:   "f336e325acc2037a",
    kindOf:      "1916384dc8777846",
    rooms:       "f0b8ff4204afbadf",
    chambers:    "c058002def677297",
    corridors:   "15031e7ca57b0f8a",
    portals:     "a8dedc98f2d5fc2b",
    gateSummary: "5feceb66ffc86f38",
  },
  fm_b: {
    openMask:    "c3e8d37a12973bd1",
    roomOf:      "f951e072405d3af8",
    chamberOf:   "7ffac354ac541acf",
    heightMap:   "ce15571f4820eac5",
    materials:   "234146852ef0d47a",
    kindOf:      "02a9f18edee14b5a",
    rooms:       "c322685287857385",
    chambers:    "2f7f02852ee8552b",
    corridors:   "f53f56901e279307",
    portals:     "781d156d70521333",
    gateSummary: "13105809c5b30ef1",
  },
  op: {
    openMask:    "6225ff9ce2615bdf",
    roomOf:      "ffa4d4529ad440f8",
    chamberOf:   "07b8f5147d4872cd",
    heightMap:   "df320524e3d6638a",
    materials:   "6bcbc5985ec98561",
    kindOf:      "c92f5c4618b8f4d0",
    rooms:       "18ebb664a3db6101",
    chambers:    "ee667c505520984b",
    corridors:   "e8fc5db25a39dc8b",
    portals:     "df4c4668b16d724e",
    gateSummary: "e33a45dab9360a01",
  },
  cd: {
    openMask:    "6db7a94e7b1c4e36",
    roomOf:      "c29707c06940b3bb",
    chamberOf:   "628a6220c7c4e931",
    heightMap:   "8d2d019dc4f94bfd",
    materials:   "5de3f146299a4bcf",
    kindOf:      "0c404551450cdb8a",
    rooms:       "c4784eb89527098d",
    chambers:    "7db8685326205f18",
    corridors:   "53cde3a7301eb595",
    portals:     "4999ae14bde19ee0",
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
