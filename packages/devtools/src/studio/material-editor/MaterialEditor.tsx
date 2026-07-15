/// <reference lib="dom" />
/**
 * Material editor (T-311 Phase 1b) — author `MaterialDef.render` against the REAL
 * shipped voxel runtime.
 *   left   — materials/ asset browser.
 *   centre — a lit voxel wall baked through the actual `bakeVoxels` +
 *            `buildVoxelMaterial` + `getVoxelTexture` (so the preview cannot
 *            drift from in-game — the Swing-Inspector discipline).
 *   right  — the render-block inspector (textureStyle dropdown sourced from the
 *            live TextureStyle registry + tintJitter sliders). Save writes the
 *            JSON back via file_io.
 *
 * This panel deliberately breaks the studio's "Layer-A pure" convention: it
 * imports the real client render code (`@voxim/client/render`), which is exactly
 * what the visual data-model arc requires — the tool runs the shipped pipeline.
 */
import { useRef, useState } from "preact/hooks";
import * as THREE from "three";
import type { MaterialDef, MaterialRenderDef } from "@voxim/content";
import { resolveMaterialVariant } from "@voxim/content";
import {
  applySurfaceTreatment,
  bakeVoxels,
  geometryFromBaked,
  buildVoxelMaterial,
  resolveMossResponse,
  textureStyleIds,
  registerBuiltinTextureStyles,
  disposeVoxelTextures,
} from "@voxim/client/render";
import { Layout } from "../shell/Layout.tsx";
import { AssetBrowser } from "../shell/AssetBrowser.tsx";
import { ViewportPane } from "../shell/ViewportPane.tsx";
import { readJson, writeJson } from "../shell/file_io.ts";
import type { Viewport } from "../shell/viewport.ts";

/** On-disk material shape — colour is a "#rrggbb" string (or a number). */
interface MaterialJson extends Omit<MaterialDef, "color"> {
  color: string | number;
}

function parseColor(c: string | number): number {
  return typeof c === "string" ? parseInt(c.replace(/^#/, ""), 16) : c;
}

const WALL_W = 6;
const WALL_H = 4;

/** Bake a flat 6×4 wall of one material through the real runtime, under variant
 *  `variantIndex` (-1 = base) resolved by the real resolveMaterialVariant.
 *  `mossPreview` / `wetPreview` (mock SurfaceStateGrid sliders, T-311 P4) ramp
 *  each column's `moss01` / `wet01` 0→value left→right through the REAL moss
 *  bake + wet_specular treatment paths. */
function buildWallMesh(
  mat: MaterialJson,
  variantIndex: number,
  mossPreview?: { overgrowth: number; targetColor: number },
  wetPreview?: number,
): THREE.Mesh {
  const mb = mat.render?.mossBlend;
  const wetDef = mat.render?.wetness;
  const atoms = [];
  for (let y = 0; y < WALL_H; y++) {
    for (let x = 0; x < WALL_W; x++) {
      const ramp = x / (WALL_W - 1);
      const moss01 = mb && mossPreview ? ramp * mossPreview.overgrowth * mb.floorBias : 0;
      const wet01 = wetDef && wetPreview !== undefined ? ramp * wetPreview : undefined;
      atoms.push({
        cx: x, cy: y, cz: 0, sx: 1, sy: 1, sz: 1, materialId: mat.id,
        ...(moss01 > 0 && { moss01 }),
        ...(wet01 !== undefined && { wet01 }),
      });
    }
  }
  const moss = mb && mossPreview
    ? resolveMossResponse(parseColor(mat.color), mossPreview.targetColor, mb.tintShift)
    : undefined;
  const baked = bakeVoxels(atoms, mat.id, undefined, mat.render?.tintJitter, moss);
  let def = { ...mat, color: parseColor(mat.color) } as unknown as MaterialDef;
  if (variantIndex >= 0) def = resolveMaterialVariant(def, variantIndex);
  const material = buildVoxelMaterial(def, mat.id);
  if (wetDef && baked.wetness) {
    applySurfaceTreatment("wet_specular", material, { gloss: wetDef.gloss, darken: wetDef.darken });
  }
  return new THREE.Mesh(geometryFromBaked(baked), material);
}

export function MaterialEditor() {
  // The TextureStyle registry is the same one the client boots; idempotent.
  registerBuiltinTextureStyles();

  const [mat, setMat]     = useState<MaterialJson | null>(null);
  const [path, setPath]   = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [variantIndex, setVariantIndex] = useState(-1);
  /** Mock SurfaceStateGrid.overgrowth for the moss preview (never persisted). */
  const [mossOg, setMossOg] = useState(0.6);
  /** Mock SurfaceStateGrid.wetness for the wet_specular preview (never persisted). */
  const [wetMock, setWetMock] = useState(0.8);
  const viewportRef = useRef<Viewport | null>(null);
  const meshRef     = useRef<THREE.Mesh | null>(null);
  /** Resolved palette colour of the mossBlend target material (lazy-loaded). */
  const mossTargetRef = useRef<number | null>(null);
  const wetMockRef = useRef(wetMock);
  wetMockRef.current = wetMock;

  const rebuild = (m: MaterialJson, vi: number, og = mossOg) => {
    const vp = viewportRef.current;
    if (!vp) return;
    if (meshRef.current) {
      vp.contentGroup.remove(meshRef.current);
      meshRef.current.geometry.dispose();
      (meshRef.current.material as THREE.Material).dispose();
    }
    // The texture cache is keyed per material-id; clear it so an edited
    // textureStyle / colour regenerates instead of returning the stale texture.
    disposeVoxelTextures();
    const target = mossTargetRef.current;
    const mesh = buildWallMesh(
      m, vi,
      target !== null ? { overgrowth: og, targetColor: target } : undefined,
      wetMockRef.current,
    );
    vp.contentGroup.add(mesh);
    meshRef.current = mesh;
    const box = new THREE.Box3().setFromObject(mesh);
    vp.frame(box);
  };

  /** Load the mossBlend target material's colour, then re-render the wall. */
  const loadMossTarget = async (m: MaterialJson, vi: number, og?: number) => {
    const name = m.render?.mossBlend?.material;
    if (!name) { mossTargetRef.current = null; return; }
    try {
      const t = await readJson<MaterialJson>(`materials/${name}.json`);
      mossTargetRef.current = parseColor(t.color);
    } catch {
      mossTargetRef.current = null;
    }
    rebuild(m, vi, og);
  };

  const pick = async (p: string) => {
    if (!p.endsWith(".json")) return;
    const m = await readJson<MaterialJson>(p);
    m.render = m.render ?? {};
    setMat(m);
    setPath(p);
    setDirty(false);
    setVariantIndex(-1);
    mossTargetRef.current = null;
    rebuild(m, -1);
    if (m.render?.mossBlend) void loadMossTarget(m, -1);
  };

  const applyRender = (render: MaterialRenderDef) => {
    if (!mat) return;
    const m = { ...mat, render };
    setMat(m);
    setDirty(true);
    rebuild(m, variantIndex);
    if (render.mossBlend && mossTargetRef.current === null) void loadMossTarget(m, variantIndex);
  };

  const pickVariant = (vi: number) => {
    setVariantIndex(vi);
    if (mat) rebuild(mat, vi);
  };

  const previewMossOg = (og: number) => {
    setMossOg(og);
    if (mat) rebuild(mat, variantIndex, og);
  };

  const previewWet = (w: number) => {
    setWetMock(w);
    wetMockRef.current = w;
    if (mat) rebuild(mat, variantIndex);
  };

  const save = async () => {
    if (!mat || !path) return;
    const out: MaterialJson = { ...mat };
    // Don't persist an empty render block as `{}` noise.
    if (out.render && Object.keys(out.render).length === 0) delete out.render;
    await writeJson(path, out);
    setDirty(false);
  };

  return (
    <Layout
      topBar={
        <>
          <span class="dt-brand" style={{ marginRight: "auto" }}>Material</span>
          {mat && <span style={{ color: "var(--bone-faint)", marginRight: 12 }}>{mat.name} · #{mat.id}</span>}
          <button class="dt-btn" disabled={!dirty} onClick={save}>{dirty ? "Save *" : "Saved"}</button>
        </>
      }
      left={<AssetBrowser filter={["materials"]} onPickFile={pick} />}
      centre={
        <ViewportPane
          onReady={(vp) => {
            viewportRef.current = vp;
            if (mat) rebuild(mat, variantIndex);
          }}
        />
      }
      right={<Inspector mat={mat} variantIndex={variantIndex} mossOg={mossOg} wetMock={wetMock} onChange={applyRender} onVariant={pickVariant} onMossOg={previewMossOg} onWetMock={previewWet} />}
    />
  );
}

// ── Inspector ─────────────────────────────────────────────────────────────

function Inspector({
  mat,
  variantIndex,
  mossOg,
  wetMock,
  onChange,
  onVariant,
  onMossOg,
  onWetMock,
}: {
  mat: MaterialJson | null;
  variantIndex: number;
  mossOg: number;
  wetMock: number;
  onChange: (render: MaterialRenderDef) => void;
  onVariant: (index: number) => void;
  onMossOg: (og: number) => void;
  onWetMock: (w: number) => void;
}) {
  if (!mat) {
    return <div style={{ padding: "var(--s-4)", color: "var(--bone-faint)" }}>Pick a material on the left.</div>;
  }
  const render = mat.render ?? {};
  const tint = render.tintJitter;
  const styles = textureStyleIds();
  const variants = mat.variants ?? [];

  const setStyle = (v: string) => {
    const next = { ...render };
    if (v) next.textureStyle = v; else delete next.textureStyle;
    onChange(next);
  };
  const setTint = (patch: Partial<NonNullable<MaterialRenderDef["tintJitter"]>>) => {
    const base = tint ?? { brightness: [0.8, 1.2] as [number, number], warmCool: 0.14 };
    onChange({ ...render, tintJitter: { ...base, ...patch } });
  };
  const toggleTint = (on: boolean) => {
    const next = { ...render };
    if (on) next.tintJitter = tint ?? { brightness: [0.8, 1.2], warmCool: 0.14 };
    else delete next.tintJitter;
    onChange(next);
  };

  return (
    <div style={{ padding: "var(--s-4)", display: "flex", flexDirection: "column", gap: "var(--s-4)" }}>
      <Section label="Texture style">
        <select
          class="dt-input"
          value={render.textureStyle ?? ""}
          onChange={(e) => setStyle((e.target as HTMLSelectElement).value)}
        >
          <option value="">(flat colour)</option>
          {styles.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </Section>

      <Section label="Tint jitter (per-voxel mottle)">
        <label style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 6 }}>
          <input type="checkbox" checked={!!tint} onChange={(e) => toggleTint((e.target as HTMLInputElement).checked)} />
          <span style={{ color: "var(--bone-faint)" }}>{tint ? "authored" : "engine default"}</span>
        </label>
        {tint && (
          <>
            <Slider label="bright min" value={tint.brightness[0]} min={0.4} max={1.0} step={0.01}
              onInput={(v) => setTint({ brightness: [v, tint.brightness[1]] })} />
            <Slider label="bright max" value={tint.brightness[1]} min={1.0} max={1.6} step={0.01}
              onInput={(v) => setTint({ brightness: [tint.brightness[0], v] })} />
            <Slider label="warm↔cool" value={tint.warmCool} min={0} max={0.4} step={0.01}
              onInput={(v) => setTint({ warmCool: v })} />
          </>
        )}
      </Section>

      <Section label="Moss creep (overgrowth response)">
        <label style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 6 }}>
          <input
            type="checkbox"
            checked={!!render.mossBlend}
            onChange={(e) => {
              const next = { ...render };
              if ((e.target as HTMLInputElement).checked) {
                next.mossBlend = render.mossBlend
                  ?? { material: "moss", floorBias: 0.85, wallBias: 0.55, jointBoost: 0.6, tintShift: [-0.04, 0.06, -0.05] };
              } else delete next.mossBlend;
              onChange(next);
            }}
          />
          <span style={{ color: "var(--bone-faint)" }}>{render.mossBlend ? `→ ${render.mossBlend.material}` : "off"}</span>
        </label>
        {render.mossBlend && (
          <>
            <Slider label="floor bias" value={render.mossBlend.floorBias} min={0} max={1} step={0.05}
              onInput={(v) => onChange({ ...render, mossBlend: { ...render.mossBlend!, floorBias: v } })} />
            <Slider label="wall bias" value={render.mossBlend.wallBias} min={0} max={1} step={0.05}
              onInput={(v) => onChange({ ...render, mossBlend: { ...render.mossBlend!, wallBias: v } })} />
            <Slider label="joint boost" value={render.mossBlend.jointBoost} min={0} max={2} step={0.1}
              onInput={(v) => onChange({ ...render, mossBlend: { ...render.mossBlend!, jointBoost: v } })} />
            <Slider label="overgrowth" value={mossOg} min={0} max={1} step={0.05} onInput={onMossOg} />
            <div style={{ color: "var(--bone-faint)", fontSize: "var(--fs-small)", marginTop: 4 }}>
              The wall ramps moss 0→overgrowth×floorBias left→right through the real
              bake. <em>overgrowth</em> is a MOCK of the per-cell server field
              (SurfaceStateGrid) — preview only, never saved.
            </div>
          </>
        )}
      </Section>

      <Section label="Wetness (wet_specular treatment)">
        <label style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 6 }}>
          <input
            type="checkbox"
            checked={!!render.wetness}
            onChange={(e) => {
              const next = { ...render };
              if ((e.target as HTMLInputElement).checked) {
                next.wetness = render.wetness ?? { gloss: 6, darken: 0.25, reflectGain: 0 };
              } else delete next.wetness;
              onChange(next);
            }}
          />
          <span style={{ color: "var(--bone-faint)" }}>{render.wetness ? "authored" : "off"}</span>
        </label>
        {render.wetness && (
          <>
            <Slider label="gloss" value={render.wetness.gloss} min={0} max={16} step={0.5}
              onInput={(v) => onChange({ ...render, wetness: { ...render.wetness!, gloss: v } })} />
            <Slider label="darken" value={render.wetness.darken} min={0} max={0.6} step={0.02}
              onInput={(v) => onChange({ ...render, wetness: { ...render.wetness!, darken: v } })} />
            <Slider label="wetness" value={wetMock} min={0} max={1} step={0.05} onInput={onWetMock} />
            <div style={{ color: "var(--bone-faint)", fontSize: "var(--fs-small)", marginTop: 4 }}>
              The wall ramps wetness 0→value left→right through the real
              <code> wet_specular</code> treatment (G4). <em>wetness</em> is a MOCK of the
              per-cell server field — preview only, never saved. <code>reflectGain</code> is
              reserved for the P5 reflection streak.
            </div>
          </>
        )}
      </Section>

      {variants.length > 0 && (
        <Section label={`State ladder (${variants.length})`}>
          <select
            class="dt-input"
            value={String(variantIndex)}
            onChange={(e) => onVariant(parseInt((e.target as HTMLSelectElement).value, 10))}
          >
            <option value="-1">base</option>
            {variants.map((v, i) => <option key={v.id} value={String(i)}>{v.id}</option>)}
          </select>
          <div style={{ color: "var(--bone-faint)", fontSize: "var(--fs-small)", marginTop: 4 }}>
            Resolved through the real <code>resolveMaterialVariant</code>; in-game the per-cell index
            comes from the server SurfaceStateGrid (Phase 3).
          </div>
        </Section>
      )}

      <div style={{ color: "var(--bone-faint)", fontSize: "var(--fs-small)", lineHeight: 1.5 }}>
        Preview bakes through the real <code>bakeVoxels</code> + <code>buildVoxelMaterial</code> —
        what you see is what spawns in-game. Other render fields (relief, wetness, glowFamily)
        are reserved for later phases.
      </div>
    </div>
  );
}

function Section({ label, children }: { label: string; children: preact.ComponentChildren }) {
  return (
    <div>
      <div style={{ color: "var(--bone)", fontSize: "var(--fs-small)", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.04em" }}>{label}</div>
      {children}
    </div>
  );
}

function Slider({
  label, value, min, max, step, onInput,
}: {
  label: string; value: number; min: number; max: number; step: number; onInput: (v: number) => void;
}) {
  return (
    <label style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4, fontSize: "var(--fs-small)" }}>
      <span style={{ flex: "0 0 70px", color: "var(--bone-faint)" }}>{label}</span>
      <input
        type="range" min={min} max={max} step={step} value={value} style={{ flex: 1 }}
        onInput={(e) => onInput(parseFloat((e.target as HTMLInputElement).value))}
      />
      <span style={{ flex: "0 0 36px", textAlign: "right", color: "var(--aether-hi)" }}>{value.toFixed(2)}</span>
    </label>
  );
}
