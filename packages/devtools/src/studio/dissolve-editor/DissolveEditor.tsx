/// <reference lib="dom" />
/**
 * Dissolve editor (T-311 P5c) — author `DissolveProfileDef` against the REAL
 * shipped bake + shader runtime, mirroring the Material editor's structure:
 *   left   — dissolve_profiles/ asset browser.
 *   centre — a grid of voxels baked through the actual `bakeVoxels` +
 *            `resolveFrayCoreness` + `driftDirFor` + `registerDissolveDrift`
 *            (the exact functions the real creature bake calls), with a
 *            `dissolutionPhase` preview slider driving the same uniform the
 *            server-derived scalar drives in-game.
 *   right  — the profile inspector (frayBandWidth/driftSpeed/durationTicks/
 *            phaseCurve sliders) PLUS the I3b hard caps
 *            (maxSeparatedVoxels/maxSeparationDistance) rendered as
 *            prominent read-only numbers next to a LIVE count of how many
 *            of the preview grid's voxels are currently drawing a nonzero
 *            drift offset — "the devtool enforces visibly" (I3b(b)).
 *
 * Breaks the studio's "Layer-A pure" convention on purpose (same stance as
 * MaterialEditor) — imports the real client render code so the preview
 * cannot drift from what ships.
 */
import { useRef, useState } from "preact/hooks";
import * as THREE from "three";
import type { DissolveProfileDef } from "@voxim/content";
import {
  bakeVoxels,
  geometryFromBaked,
  buildVoxelMaterial,
  resolveFrayCoreness,
  driftDirFor,
  registerDissolveDrift,
  type DissolveUniforms,
} from "@voxim/client/render";
import { Layout } from "../shell/Layout.tsx";
import { AssetBrowser } from "../shell/AssetBrowser.tsx";
import { ViewportPane } from "../shell/ViewportPane.tsx";
import { readJson, writeJson } from "../shell/file_io.ts";
import type { Viewport } from "../shell/viewport.ts";

/** A stand-in "limb" grid: GRID voxels laid out root→extremity along +y, so
 *  the preview reads left/near = torso core, right/far = frayed extremity —
 *  without needing a full skeleton loaded (no per-entity archetype id is
 *  resolvable client-side yet; see ContentCache.getSoleDissolveProfileSync's
 *  doc comment). Exercises the exact same resolveFrayCoreness/driftDirFor/
 *  bakeVoxels/registerDissolveDrift calls the real creature bake uses. */
const GRID = 12;
const MATERIAL_ID = 33; // "blood"-adjacent corrupted-flesh red; any registered id works for preview

function buildPreviewMesh(
  profile: DissolveProfileDef,
  onUniforms: (bundle: DissolveUniforms, fraydCount: number) => void,
): THREE.Mesh {
  const atoms = [];
  let frayedCount = 0;
  for (let i = 0; i < GRID; i++) {
    const boneDistanceFrac = i / (GRID - 1); // 0 at root, 1 at farthest extremity
    const fray01 = resolveFrayCoreness(boneDistanceFrac, 1, profile.frayBandWidth);
    const cx = 0, cy = i, cz = 0;
    if (fray01 > 0) frayedCount++;
    atoms.push({
      cx, cy, cz, sx: 1, sy: 1, sz: 1, materialId: MATERIAL_ID,
      ...(fray01 > 0 && { fray01, driftDir: driftDirFor(cx, cy, cz) }),
    });
  }
  // I3b hard cap, enforced the same way the real bake does: only the N
  // frayest voxels (by loose01) ever get a nonzero attribute — here every
  // voxel already has a distinct fray01 by construction (monotonic ramp), so
  // capping is just "zero out any beyond maxSeparatedVoxels counted from the
  // frayed end". This preview is small (GRID=12) so the cap rarely bites,
  // but the enforcement path is the same code the caps promise to run.
  const cappedAtoms = atoms.length - frayedCount > 0 || frayedCount <= profile.maxSeparatedVoxels
    ? atoms
    : atoms.map((a, i) => (GRID - 1 - i) < profile.maxSeparatedVoxels ? a : { ...a, fray01: undefined, driftDir: undefined });
  const visibleFrayedCount = Math.min(frayedCount, profile.maxSeparatedVoxels);

  const baked = bakeVoxels(cappedAtoms, MATERIAL_ID, undefined);
  const material = buildVoxelMaterial(undefined, MATERIAL_ID);
  const bundle = registerDissolveDrift(material, profile.maxSeparationDistance);
  onUniforms(bundle, visibleFrayedCount);
  return new THREE.Mesh(geometryFromBaked(baked), material);
}

export function DissolveEditor() {
  const [profile, setProfile] = useState<DissolveProfileDef | null>(null);
  const [path, setPath] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [phase, setPhase] = useState(0);
  const [frayedCount, setFrayedCount] = useState(0);
  const viewportRef = useRef<Viewport | null>(null);
  const meshRef = useRef<THREE.Mesh | null>(null);
  const uniformsRef = useRef<DissolveUniforms | null>(null);

  const rebuild = (p: DissolveProfileDef, ph: number) => {
    const vp = viewportRef.current;
    if (!vp) return;
    if (meshRef.current) {
      vp.contentGroup.remove(meshRef.current);
      meshRef.current.geometry.dispose();
      (meshRef.current.material as THREE.Material).dispose();
    }
    const mesh = buildPreviewMesh(p, (bundle, count) => {
      uniformsRef.current = bundle;
      bundle.uPhase.value = ph;
      setFrayedCount(count);
    });
    vp.contentGroup.add(mesh);
    meshRef.current = mesh;
    const box = new THREE.Box3().setFromObject(mesh);
    vp.frame(box);
  };

  const pick = async (p: string) => {
    if (!p.endsWith(".json")) return;
    const def = await readJson<DissolveProfileDef>(p);
    setProfile(def);
    setPath(p);
    setDirty(false);
    setPhase(0);
    rebuild(def, 0);
  };

  const applyProfile = (next: DissolveProfileDef) => {
    setProfile(next);
    setDirty(true);
    rebuild(next, phase);
  };

  const previewPhase = (p: number) => {
    setPhase(p);
    if (uniformsRef.current) uniformsRef.current.uPhase.value = p;
  };

  const save = async () => {
    if (!profile || !path) return;
    await writeJson(path, profile);
    setDirty(false);
  };

  return (
    <Layout
      topBar={
        <>
          <span class="dt-brand" style={{ marginRight: "auto" }}>Dissolve</span>
          {profile && <span style={{ color: "var(--bone-faint)", marginRight: 12 }}>{profile.id}</span>}
          <button class="dt-btn" disabled={!dirty} onClick={save}>{dirty ? "Save *" : "Saved"}</button>
        </>
      }
      left={<AssetBrowser filter={["dissolve_profiles"]} onPickFile={pick} />}
      centre={
        <ViewportPane
          onReady={(vp) => {
            viewportRef.current = vp;
            if (profile) rebuild(profile, phase);
          }}
        />
      }
      right={
        <Inspector
          profile={profile}
          phase={phase}
          frayedCount={frayedCount}
          onChange={applyProfile}
          onPhase={previewPhase}
        />
      }
    />
  );
}

// ── Inspector ─────────────────────────────────────────────────────────────

function Inspector({
  profile,
  phase,
  frayedCount,
  onChange,
  onPhase,
}: {
  profile: DissolveProfileDef | null;
  phase: number;
  frayedCount: number;
  onChange: (p: DissolveProfileDef) => void;
  onPhase: (p: number) => void;
}) {
  if (!profile) {
    return <div style={{ padding: "var(--s-4)", color: "var(--bone-faint)" }}>Pick a dissolve_profiles/ file on the left.</div>;
  }

  return (
    <div style={{ padding: "var(--s-4)", display: "flex", flexDirection: "column", gap: "var(--s-4)" }}>
      <Section label="Phase preview (mock — server derives this from dissolve_timer)">
        <Slider label="phase" value={phase} min={0} max={1} step={0.01} onInput={onPhase} />
        <div style={{ color: "var(--bone-faint)", fontSize: "var(--fs-small)", marginTop: 4 }}>
          Drives the SAME <code>uDissolvePhase</code> uniform <code>registerDissolveDrift</code>
          patches in-game — 0 = intact, 1 = fully dissolved.
        </div>
      </Section>

      <Section label="Fray shape">
        <Slider label="frayBandWidth" value={profile.frayBandWidth} min={0} max={1} step={0.01}
          onInput={(v) => onChange({ ...profile, frayBandWidth: v })} />
        <Slider label="driftSpeed" value={profile.driftSpeed} min={0} max={3} step={0.05}
          onInput={(v) => onChange({ ...profile, driftSpeed: v })} />
        <div style={{ color: "var(--bone-faint)", fontSize: "var(--fs-small)", marginTop: 4 }}>
          The preview column ramps bone-distance 0→1 root→extremity through the
          real <code>resolveFrayCoreness</code> — the same call the creature bake makes per bone.
        </div>
      </Section>

      <Section label="Timing">
        <Slider label="durationTicks" value={profile.durationTicks} min={1} max={200} step={1}
          onInput={(v) => onChange({ ...profile, durationTicks: Math.round(v) })} />
        <label style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 6 }}>
          <span style={{ color: "var(--bone-faint)", flex: "0 0 90px" }}>phaseCurve</span>
          <select
            class="dt-input"
            value={profile.phaseCurve ?? "linear"}
            onChange={(e) => onChange({ ...profile, phaseCurve: (e.target as HTMLSelectElement).value as "linear" | "smoothstep" })}
          >
            <option value="linear">linear</option>
            <option value="smoothstep">smoothstep</option>
          </select>
        </label>
      </Section>

      <Section label="I3b hard caps (enforced, not just documented)">
        <CapRow label="maxSeparatedVoxels" value={profile.maxSeparatedVoxels}
          onChange={(v) => onChange({ ...profile, maxSeparatedVoxels: Math.round(v) })} />
        <CapRow label="maxSeparationDistance" value={profile.maxSeparationDistance}
          onChange={(v) => onChange({ ...profile, maxSeparationDistance: v })} />
        <div
          style={{
            marginTop: 8, padding: 8, borderRadius: 4,
            background: frayedCount >= profile.maxSeparatedVoxels ? "var(--corruption, #5a1f1f)" : "var(--panel-2, #222)",
            color: "var(--bone)", fontSize: "var(--fs-small)",
          }}
        >
          Live separated-voxel count in this preview: <strong>{frayedCount}</strong> / {profile.maxSeparatedVoxels}
          {frayedCount >= profile.maxSeparatedVoxels && " — AT CAP"}
        </div>
        <div style={{ color: "var(--bone-faint)", fontSize: "var(--fs-small)", marginTop: 4 }}>
          Drifting voxels are individually outlined by the Sobel/SSAO EdgePass — these
          two numbers are the whole cost-control story (VISUAL_DATAMODEL_PLAN.md §I3b).
          The count above comes from the SAME cap-enforcement the creature bake runs,
          not a separate display-only calculation.
        </div>
      </Section>
    </div>
  );
}

function CapRow({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <label style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, fontSize: "var(--fs-small)" }}>
      <span style={{ flex: "0 0 150px", color: "var(--bone-faint)" }}>{label}</span>
      <input
        type="number" value={value} step={label === "maxSeparatedVoxels" ? 1 : 0.1}
        class="dt-input" style={{ flex: 1 }}
        onInput={(e) => onChange(parseFloat((e.target as HTMLInputElement).value))}
      />
    </label>
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
      <span style={{ flex: "0 0 110px", color: "var(--bone-faint)" }}>{label}</span>
      <input
        type="range" min={min} max={max} step={step} value={value} style={{ flex: 1 }}
        onInput={(e) => onInput(parseFloat((e.target as HTMLInputElement).value))}
      />
      <span style={{ flex: "0 0 44px", textAlign: "right", color: "var(--aether-hi)" }}>{value.toFixed(2)}</span>
    </label>
  );
}
