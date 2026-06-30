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
  bakeVoxels,
  geometryFromBaked,
  buildVoxelMaterial,
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
 *  `variantIndex` (-1 = base) resolved by the real resolveMaterialVariant. */
function buildWallMesh(mat: MaterialJson, variantIndex: number): THREE.Mesh {
  const atoms = [];
  for (let y = 0; y < WALL_H; y++) {
    for (let x = 0; x < WALL_W; x++) {
      atoms.push({ cx: x, cy: y, cz: 0, sx: 1, sy: 1, sz: 1, materialId: mat.id });
    }
  }
  const baked = bakeVoxels(atoms, mat.id, undefined, mat.render?.tintJitter);
  let def = { ...mat, color: parseColor(mat.color) } as unknown as MaterialDef;
  if (variantIndex >= 0) def = resolveMaterialVariant(def, variantIndex);
  return new THREE.Mesh(geometryFromBaked(baked), buildVoxelMaterial(def, mat.id));
}

export function MaterialEditor() {
  // The TextureStyle registry is the same one the client boots; idempotent.
  registerBuiltinTextureStyles();

  const [mat, setMat]     = useState<MaterialJson | null>(null);
  const [path, setPath]   = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [variantIndex, setVariantIndex] = useState(-1);
  const viewportRef = useRef<Viewport | null>(null);
  const meshRef     = useRef<THREE.Mesh | null>(null);

  const rebuild = (m: MaterialJson, vi: number) => {
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
    const mesh = buildWallMesh(m, vi);
    vp.contentGroup.add(mesh);
    meshRef.current = mesh;
    const box = new THREE.Box3().setFromObject(mesh);
    vp.frame(box);
  };

  const pick = async (p: string) => {
    if (!p.endsWith(".json")) return;
    const m = await readJson<MaterialJson>(p);
    m.render = m.render ?? {};
    setMat(m);
    setPath(p);
    setDirty(false);
    setVariantIndex(-1);
    rebuild(m, -1);
  };

  const applyRender = (render: MaterialRenderDef) => {
    if (!mat) return;
    const m = { ...mat, render };
    setMat(m);
    setDirty(true);
    rebuild(m, variantIndex);
  };

  const pickVariant = (vi: number) => {
    setVariantIndex(vi);
    if (mat) rebuild(mat, vi);
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
      right={<Inspector mat={mat} variantIndex={variantIndex} onChange={applyRender} onVariant={pickVariant} />}
    />
  );
}

// ── Inspector ─────────────────────────────────────────────────────────────

function Inspector({
  mat,
  variantIndex,
  onChange,
  onVariant,
}: {
  mat: MaterialJson | null;
  variantIndex: number;
  onChange: (render: MaterialRenderDef) => void;
  onVariant: (index: number) => void;
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
        what you see is what spawns in-game. Other render fields (relief, wetness, mossBlend, glowFamily,
        variants) are reserved for later phases.
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
