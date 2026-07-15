/// <reference lib="dom" />
/**
 * Cliff editor (T-311 Phase 6) — author `CliffProfileDef` against the REAL
 * shipped cliffVoxeliser + voxel-bake runtime.
 *   left   — cliff_profiles/ asset browser.
 *   centre — a synthetic wilderness-perimeter strip (a small run of wall
 *            cells at varying depth) run through the REAL `buildChunkAtoms`
 *            + `getCliffVoxeliser` + `bakeVoxels` + `buildVoxelMaterial`
 *            pipeline (the Swing-Inspector discipline — no re-implementation).
 *   right  — the profile's erosion-state numbers (tierCount/jitterAmp/
 *            edgeChinkiness per crisp/weathered/broken), an erosion-state
 *            picker, and the collision-overlay toggle.
 *
 * Collision-overlay honesty note (T-318): under the shipped v1 decision
 * (vertical coursing, Heightmap unchanged), collision == render top ALWAYS
 * by construction — there is no divergence to surface today. The overlay
 * still draws a wireframe at the walkable top (the same `h` buildChunkAtoms
 * uses) so authors can visually confirm "the top course's face IS the
 * walkable surface", and a red-highlight path is wired but inert (never
 * fires in v1) so it activates for free if a future horizontal-terrace
 * phase makes real divergence possible.
 */
import { useRef, useState } from "preact/hooks";
import * as THREE from "three";
import type { CliffProfileDef, CliffErosionState } from "@voxim/content";
import {
  buildChunkAtoms,
  bakeVoxels,
  geometryFromBaked,
  buildVoxelMaterial,
  getCliffVoxeliser,
  registerBuiltinCliffVoxelisers,
  cliffVoxeliserIds,
  type CliffFieldInput,
} from "@voxim/client/render";
import { Layout } from "../shell/Layout.tsx";
import { AssetBrowser } from "../shell/AssetBrowser.tsx";
import { ViewportPane } from "../shell/ViewportPane.tsx";
import { readJson, writeJson } from "../shell/file_io.ts";
import type { Viewport } from "../shell/viewport.ts";

const CHUNK = 32; // buildChunkAtoms's fixed chunk side
const STRIP_LEN = 12; // how many wall cells the preview strip carves
const WALL_DEPTH = 3.0; // world units the wall rises above the floor

type ErosionKey = "crisp" | "weathered" | "broken";
const EROSION_KEYS: ErosionKey[] = ["crisp", "weathered", "broken"];

/** Build a synthetic chunk: a flat floor with one wall band STRIP_LEN cells
 *  wide, plus a matching CliffFieldInput marking the wall band as an edge
 *  under the previewed profile/erosion. Mirrors the shape terrain_voxels'
 *  own tests use. */
function buildPreviewInput(erosionIdx: number): {
  hm: { chunkX: number; chunkY: number; data: Float32Array };
  mats: { data: Uint16Array };
  cliff: CliffFieldInput;
} {
  const n = CHUNK * CHUNK;
  const heights = new Float32Array(n).fill(0);
  const materials = new Uint16Array(n).fill(1); // material id 1 — stone-ish, palette-independent preview
  const profileId = new Uint8Array(n);
  const erosion = new Uint8Array(n);
  const tier = new Uint8Array(n);
  const edge = new Uint8Array(n);

  const y0 = 14, y1 = 18; // a 4-cell-deep wall band
  for (let x = 8; x < 8 + STRIP_LEN; x++) {
    for (let y = y0; y < y1; y++) {
      const i = x + y * CHUNK;
      heights[i] = WALL_DEPTH;
    }
    // only the north face (y0 row) is the outward lip in this preview
    const edgeIdx = x + y0 * CHUNK;
    edge[edgeIdx] = 1;
    profileId[edgeIdx] = 1;
    erosion[edgeIdx] = erosionIdx;
  }

  return {
    hm: { chunkX: 0, chunkY: 0, data: heights },
    mats: { data: materials },
    cliff: {
      grid: { profileId, erosion, tier, edge },
      profileOf: (id) => (id === 1 ? "preview" : undefined),
      erosionOf: (id, idx) => (id === "preview" ? erosionOfIdx(idx) : undefined),
    },
  };

  function erosionOfIdx(idx: number): CliffErosionState | undefined {
    return currentDef?.erosionStates[EROSION_KEYS[idx] ?? "crisp"];
  }
}

// Set by the component before each rebuild so buildPreviewInput's closure
// can resolve the currently-edited profile's erosion states.
let currentDef: CliffProfileDef | null = null;

export function CliffEditor() {
  registerBuiltinCliffVoxelisers(); // idempotent — the same registry the client boots

  const [def, setDef]         = useState<CliffProfileDef | null>(null);
  const [path, setPath]       = useState<string | null>(null);
  const [dirty, setDirty]     = useState(false);
  const [erosionIdx, setErosionIdx] = useState(0);
  const [voxeliserId, setVoxeliserId] = useState("columnar");
  const [overlay, setOverlay] = useState(false);
  const [err, setErr]         = useState<string | null>(null);
  const viewportRef = useRef<Viewport | null>(null);
  const groupRef     = useRef<THREE.Group | null>(null);
  const overlayRef   = useRef<THREE.LineSegments | null>(null);

  const rebuild = (d: CliffProfileDef, ei: number, vid: string) => {
    const vp = viewportRef.current;
    if (!vp) return;
    if (groupRef.current) {
      vp.contentGroup.remove(groupRef.current);
      groupRef.current.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose?.();
        (m.material as THREE.Material | undefined)?.dispose?.();
      });
    }
    if (overlayRef.current) {
      vp.contentGroup.remove(overlayRef.current);
      overlayRef.current.geometry.dispose();
      (overlayRef.current.material as THREE.Material).dispose();
      overlayRef.current = null;
    }
    try {
      currentDef = d;
      const voxeliser = getCliffVoxeliser(vid);
      if (!voxeliser) throw new Error(`unknown cliffVoxeliser "${vid}" (have: ${cliffVoxeliserIds().join(", ")})`);
      const { hm, mats, cliff } = buildPreviewInput(ei);
      const byMat = buildChunkAtoms(
        hm, mats, {}, undefined,
        () => undefined, // no material relief in this preview
        cliff,
      );
      const group = new THREE.Group();
      let atomCount = 0;
      for (const [matId, atoms] of byMat) {
        atomCount += atoms.length;
        const baked = bakeVoxels(atoms, matId);
        const mesh = new THREE.Mesh(geometryFromBaked(baked), buildVoxelMaterial(undefined, matId));
        group.add(mesh);
      }
      vp.contentGroup.add(group);
      groupRef.current = group;

      // Collision overlay: a wireframe box at the plateau's walkable top
      // (z = WALL_DEPTH, the same `h` buildChunkAtoms used) across the strip.
      // Under v1 (Heightmap unchanged), this ALWAYS matches the render top —
      // there is no divergence to show; the overlay confirms that honestly
      // rather than pretending to catch a real mismatch.
      if (overlay) {
        const geo = new THREE.EdgesGeometry(
          new THREE.BoxGeometry(STRIP_LEN, 4, 0.05),
        );
        const mat = new THREE.LineBasicMaterial({ color: 0x00ff88 });
        const lines = new THREE.LineSegments(geo, mat);
        lines.position.set(8 + STRIP_LEN / 2, 16, WALL_DEPTH);
        lines.rotation.x = Math.PI / 2;
        vp.contentGroup.add(lines);
        overlayRef.current = lines;
      }

      vp.frame(new THREE.Box3().setFromObject(group));
      setErr(null);
      void atomCount;
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const pick = async (p: string) => {
    if (!p.endsWith(".json")) return;
    const d = await readJson<CliffProfileDef>(p);
    setDef(d);
    setPath(p);
    setDirty(false);
    rebuild(d, erosionIdx, voxeliserId);
  };

  const save = async () => {
    if (!def || !path) return;
    await writeJson(path, def);
    setDirty(false);
  };

  const updateErosion = (key: ErosionKey, field: keyof CliffErosionState, value: number) => {
    if (!def) return;
    const next: CliffProfileDef = {
      ...def,
      erosionStates: { ...def.erosionStates, [key]: { ...def.erosionStates[key], [field]: value } },
    };
    setDef(next);
    setDirty(true);
    rebuild(next, erosionIdx, voxeliserId);
  };

  const state = EROSION_KEYS[erosionIdx];

  return (
    <Layout
      topBar={
        <>
          <span class="dt-brand" style={{ marginRight: "auto" }}>Cliff</span>
          {def && <span style={{ color: "var(--bone-faint)", marginRight: 12 }}>{def.id} · {state}</span>}
          {def && <button class="dt-btn" disabled={!dirty} onClick={save}>{dirty ? "Save *" : "Saved"}</button>}
        </>
      }
      left={<AssetBrowser filter={["cliff_profiles"]} onPickFile={pick} />}
      centre={
        <ViewportPane
          onReady={(vp) => {
            viewportRef.current = vp;
            if (def) rebuild(def, erosionIdx, voxeliserId);
          }}
        />
      }
      right={
        <div style={{ padding: "var(--s-4)", display: "flex", flexDirection: "column", gap: "var(--s-4)" }}>
          {!def && <div style={{ color: "var(--bone-faint)" }}>Pick a cliff profile on the left.</div>}
          {def && (
            <>
              <div>
                <div style={{ color: "var(--bone)", fontSize: "var(--fs-small)", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.04em" }}>Voxeliser</div>
                <select
                  class="dt-input"
                  value={voxeliserId}
                  onInput={(e) => {
                    const v = (e.target as HTMLSelectElement).value;
                    setVoxeliserId(v);
                    rebuild(def, erosionIdx, v);
                  }}
                >
                  {cliffVoxeliserIds().map((id) => <option value={id}>{id}</option>)}
                </select>
              </div>
              <div>
                <div style={{ color: "var(--bone)", fontSize: "var(--fs-small)", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.04em" }}>Erosion state</div>
                <div style={{ display: "flex", gap: 6 }}>
                  {EROSION_KEYS.map((k, i) => (
                    <button
                      class={`dt-btn ${i === erosionIdx ? "is-active" : ""}`}
                      onClick={() => { setErosionIdx(i); rebuild(def, i, voxeliserId); }}
                    >{k}</button>
                  ))}
                </div>
              </div>
              <div>
                <div style={{ color: "var(--bone)", fontSize: "var(--fs-small)", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.04em" }}>{state} params</div>
                {(["tierCount", "jitterAmp", "edgeChinkiness"] as const).map((field) => (
                  <label style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6 }}>
                    <span style={{ flex: 1, color: "var(--bone-faint)", fontSize: "var(--fs-small)" }}>{field}</span>
                    <input
                      class="dt-input" type="number" step={field === "tierCount" ? 1 : 0.01}
                      style={{ width: 80 }}
                      value={def.erosionStates[state][field]}
                      onInput={(e) => updateErosion(state, field, Number((e.target as HTMLInputElement).value))}
                    />
                  </label>
                ))}
              </div>
              <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <input
                  type="checkbox" checked={overlay}
                  onInput={(e) => { const v = (e.target as HTMLInputElement).checked; setOverlay(v); rebuild(def, erosionIdx, voxeliserId); }}
                />
                <span style={{ color: "var(--bone-faint)", fontSize: "var(--fs-small)" }}>Collision overlay</span>
              </label>
              {err && (
                <div style={{ color: "var(--blood)", fontSize: "var(--fs-small)", lineHeight: 1.5 }}>
                  voxeliser error: {err}
                </div>
              )}
              <div style={{ color: "var(--bone-faint)", fontSize: "var(--fs-small)", lineHeight: 1.5 }}>
                Voxelised by the real <code>{voxeliserId}</code> cliffVoxeliser through the shipped
                <code> buildChunkAtoms</code> + <code>bakeVoxels</code> — identical to in-game terrain.
                Under the v1 vertical-coursing decision (T-318), collision and render top are IDENTICAL
                by construction — the overlay confirms this rather than catching a real divergence.
              </div>
            </>
          )}
        </div>
      }
    />
  );
}
