/**
 * T-208 determinism gate for the zone-graph stage. Captures the
 * `zoneOf` typed array hash + the sorted-zones JSON hash for the same
 * 4 (cell, seed, preset) tuples the generateTile snapshot uses. Any
 * change to segmentation, adjacency, metrics, or role classification
 * is a fixture diff.
 *
 * Capture mode: ATLAS_ZONE_SNAPSHOT_CAPTURE=1 prints the actual hashes
 * (paste into EXPECTED below and re-run without the env var).
 */

import { generateWorldMap } from "../worldmap/generate.ts";
import type { WorldCellRecord } from "../worldmap/types.ts";
import { runInstrumented } from "./instrumented_runner.ts";
import type { AnnotatedZoneState } from "./pipeline/state.ts";
import { PRESETS } from "../genparams.ts";

async function sha256Prefix(bytes: Uint8Array): Promise<string> {
  const owned = new Uint8Array(bytes.byteLength);
  owned.set(bytes);
  const buf = await crypto.subtle.digest("SHA-256", owned);
  const arr = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < arr.length; i++) s += arr[i].toString(16).padStart(2, "0");
  return s.slice(0, 16);
}

async function hashTypedArray(arr: Uint8Array | Uint16Array | Float32Array): Promise<string> {
  return sha256Prefix(new Uint8Array(arr.buffer as ArrayBuffer, arr.byteOffset, arr.byteLength));
}

async function hashJson(v: unknown): Promise<string> {
  return sha256Prefix(new TextEncoder().encode(JSON.stringify(v)));
}

const WORLD_SEED = 0;
const world = generateWorldMap(WORLD_SEED, 4, 4);

function cell(cellX: number, cellY: number): WorldCellRecord {
  const c = world.cells[cellY * 4 + cellX];
  if (!c) throw new Error(`no world cell at (${cellX}, ${cellY})`);
  return c;
}

interface MatrixEntry {
  label: string; cellX: number; cellY: number; tileSeed: number; presetId: keyof typeof PRESETS;
}

const MATRIX: MatrixEntry[] = [
  { label: "fm_a", cellX: 1, cellY: 1, tileSeed: 1001, presetId: "forest_maze" },
  { label: "fm_b", cellX: 2, cellY: 3, tileSeed: 2002, presetId: "forest_maze" },
  { label: "op",   cellX: 0, cellY: 2, tileSeed: 3003, presetId: "open_plains" },
  { label: "cd",   cellX: 3, cellY: 0, tileSeed: 4004, presetId: "cliff_dungeon" },
];

interface ZoneSnapshot {
  zoneOf: string;
  zonesJson: string;
  /** sanity counters that humans can eyeball in capture output */
  zoneCount: number;
  roleHistogram: Record<string, number>;
}

async function captureZone(e: MatrixEntry): Promise<ZoneSnapshot> {
  const r = runInstrumented({
    worldCell: cell(e.cellX, e.cellY),
    tileSeed:  e.tileSeed,
    params:    PRESETS[e.presetId].params,
  });
  const final = r.final as AnnotatedZoneState;
  const roleHistogram: Record<string, number> = {};
  for (const z of final.zones) roleHistogram[z.topologyRole] = (roleHistogram[z.topologyRole] ?? 0) + 1;
  return {
    zoneOf:    await hashTypedArray(final.zoneOf),
    zonesJson: await hashJson(final.zones),
    zoneCount: final.zones.length,
    roleHistogram,
  };
}

// Captured pre-merge from the canonical role-classifier rules; any
// future tweak to segmentation, role rules, or default thresholds is
// an intentional fixture diff (re-run capture mode + paste).
// Sector refactor: corridor flood is now split by junction disks
// (degree ≥ 3 carved as their own crossroads sectors). Role histograms
// shift dramatically — corridors become first-class sectors with their
// own ids instead of getting absorbed into chamber-derived "deadend"
// roles. fm_a went from 8 crossroads + 0 corridor to 9 crossroads +
// 4 corridor; cliff_dungeon's massive deadend count (25) collapsed
// to 3 as 47 actual corridor sectors emerged.
//
// zoneOf changed for fm_a + cd (the disk-paint phase creates new ids
// in former corridor pixels); fm_b + op are unchanged because their
// junction layouts happen to produce identical disk-painted regions.
const EXPECTED: Record<string, { zoneOf: string; zonesJson: string }> = {
  fm_a: { zoneOf: "69c92c658b2320be", zonesJson: "9d4df299e46537b8" },
  fm_b: { zoneOf: "4963cc566aafcd59", zonesJson: "24e664bf19948a1b" },
  op:   { zoneOf: "7ea21a5aa497044b", zonesJson: "ecc8db14ef4c7e28" },
  cd:   { zoneOf: "c248fe82101daf20", zonesJson: "a615b57e7d0ed653" },
};

Deno.test("zoneGraph: byte-identical output across pipeline matrix", async () => {
  const capture = Deno.env.get("ATLAS_ZONE_SNAPSHOT_CAPTURE") === "1";
  const lines: string[] = [];
  let failed = false;

  for (const e of MATRIX) {
    const snap = await captureZone(e);
    if (capture) {
      lines.push(`  ${e.label}: { zoneOf: "${snap.zoneOf}", zonesJson: "${snap.zonesJson}" },  // zones=${snap.zoneCount} ${JSON.stringify(snap.roleHistogram)}`);
      continue;
    }
    const exp = EXPECTED[e.label];
    if (exp.zoneOf === "__PENDING__") {
      throw new Error("Snapshot in PENDING — run with ATLAS_ZONE_SNAPSHOT_CAPTURE=1 and paste hashes.");
    }
    if (snap.zoneOf !== exp.zoneOf) {
      failed = true;
      console.error(`[${e.label}] zoneOf: expected ${exp.zoneOf}, got ${snap.zoneOf}`);
    }
    if (snap.zonesJson !== exp.zonesJson) {
      failed = true;
      console.error(`[${e.label}] zonesJson: expected ${exp.zonesJson}, got ${snap.zonesJson}`);
    }
  }
  if (capture) {
    console.log("\n--- paste into EXPECTED ---\n");
    console.log(lines.join("\n"));
    return;
  }
  if (failed) throw new Error("zoneGraph snapshot mismatch — segmentation or classification changed.");
});

// Sanity tests on the role-assignment rules — small synthetic state.
Deno.test("zoneGraph: classifies a single big open region as 'arena'", () => {
  const r = runInstrumented({
    worldCell: cell(1, 1),
    tileSeed: 1001,
    params: PRESETS.open_plains.params,
  });
  // Wilderness zones are usually the largest by area on plains tiles
  // (one big forest/stone blob surrounds the playable space). The
  // classifier rules for `arena` apply only to PATH zones, so filter
  // before asserting.
  const pathZones = (r.final as AnnotatedZoneState).zones
    .filter(z => z.traversal === "path");
  const largest = pathZones.reduce((a, b) => a.area >= b.area ? a : b);
  if (largest.area > PRESETS.open_plains.params.zoneGraph!.arenaAreaMin) {
    if (largest.topologyRole !== "arena") {
      throw new Error(`largest path zone area=${largest.area} should classify as arena, got ${largest.topologyRole}`);
    }
  }
});

Deno.test("zoneGraph: wilderness segmentation produces traversal=wilderness blobs", () => {
  // Every preset should produce at least one wilderness zone. forest_maze
  // tiles have many small thickets; cliff_dungeon tiles have many crags;
  // open_plains tiles have a few large groves. Asserts the segmentation
  // actually fires.
  for (const e of MATRIX) {
    const r = runInstrumented({
      worldCell: cell(e.cellX, e.cellY),
      tileSeed: e.tileSeed,
      params: PRESETS[e.presetId].params,
    });
    const zones = (r.final as AnnotatedZoneState).zones;
    const wilderness = zones.filter(z => z.traversal === "wilderness");
    if (wilderness.length === 0) {
      throw new Error(`[${e.label}] no wilderness zones produced`);
    }
    // All wilderness zones must have a wilderness-class role.
    for (const w of wilderness) {
      const wildernessRoles = new Set(["crag", "grove", "thicket", "hollow", "outcrop", "morass"]);
      if (!wildernessRoles.has(w.topologyRole)) {
        throw new Error(`[${e.label}] zone ${w.id} has traversal=wilderness but role=${w.topologyRole}`);
      }
    }
  }
});

Deno.test("zoneGraph: every entry zone is touched by at least one portal", () => {
  for (const e of MATRIX) {
    const r = runInstrumented({
      worldCell: cell(e.cellX, e.cellY),
      tileSeed: e.tileSeed,
      params: PRESETS[e.presetId].params,
    });
    const final = r.final as AnnotatedZoneState;
    const entryZoneIds = new Set(final.zones.filter(z => z.isEntry).map(z => z.id));
    const portalZoneIds = new Set(
      final.portals.map(p => final.zoneOf[p.pixelY * final.gridSize + p.pixelX]),
    );
    portalZoneIds.delete(0xFFFF);
    for (const id of entryZoneIds) {
      if (!portalZoneIds.has(id)) {
        throw new Error(`[${e.label}] zone ${id} marked entry but no portal lives in it`);
      }
    }
  }
});
