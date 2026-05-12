/// <reference lib="dom" />
/**
 * Import GLB panel — load a GLB file from disk, pick which animation, choose
 * a bone-map preset, set rest deltas if needed, save into the library.
 *
 * Bone maps are fetched from `/content/anim_maps/*.json` (the same files the
 * CLI converter uses).  The user can also drop unwanted bones from the map
 * for the duration of one import (no JSON editing needed).
 */
import { useEffect, useState } from "preact/hooks";
import type { SkeletonDef } from "@voxim/content";
import type { BrowserContentStore } from "../../content_loader.ts";
import { libraryClips, flashStatus } from "../lib_state.ts";
import { saveLibraryClip } from "../lib_api.ts";
import { parseGLB, convertGLBClip, type GLBSummary, type BoneMapPreset } from "../glb_import.ts";

interface Props { content: BrowserContentStore; }

const PRESETS = ["quaternius", "mixamo", "cmu", "cesiumman"] as const;
type Preset = typeof PRESETS[number];

// Form inputs inherit Dreamborn styling from devtools.css; no per-field overrides.

export function ImportPanel({ content }: Props) {
  const [summary, setSummary] = useState<GLBSummary | null>(null);
  const [fileName, setFileName] = useState<string>("");
  const [preset, setPreset] = useState<Preset>("quaternius");
  const [presetData, setPresetData] = useState<BoneMapPreset | null>(null);
  const [animIdx, setAnimIdx] = useState<number>(0);
  const [skeleton, setSkeleton] = useState<string>("biped");
  const [clipId, setClipId] = useState<string>("");
  const [loop, setLoop] = useState<boolean>(true);
  const [fps, setFps] = useState<number>(30);

  const skeletons: SkeletonDef[] = (() => {
    const ids = new Set<string>();
    for (const id of content.allModelIds) {
      const m = content.models.get(id);
      if (m?.skeletonId) ids.add(m.skeletonId);
    }
    return [...ids].map((id) => content.skeletons.get(id)).filter(Boolean) as SkeletonDef[];
  })();

  // Load the selected preset's JSON whenever the dropdown changes.
  useEffect(() => {
    fetch(`/content/anim_maps/${preset}.json`)
      .then((r) => r.ok ? r.json() : null)
      .then((d) => setPresetData(d as BoneMapPreset | null))
      .catch(() => setPresetData(null));
  }, [preset]);

  async function onFile(e: Event) {
    const input = e.target as HTMLInputElement;
    const f = input.files?.[0];
    if (!f) return;
    setFileName(f.name);
    try {
      const buf = await f.arrayBuffer();
      const sum = await parseGLB(buf);
      setSummary(sum);
      setAnimIdx(0);
      // Suggest a clip id from the source filename (no .glb, lowercased).
      if (!clipId) setClipId(f.name.replace(/\.glb$/i, "").toLowerCase());
    } catch (err) {
      flashStatus("err", `parse failed: ${(err as Error).message}`);
    }
  }

  async function doImport() {
    if (!summary || !presetData) return;
    if (!clipId.trim()) {
      flashStatus("err", "clip id is required");
      return;
    }
    try {
      const animName = summary.animations[animIdx]?.name ?? "";
      const lib = convertGLBClip(summary, {
        id: clipId.trim(),
        animationName: animName,
        skeleton,
        map: presetData,
        fps,
        loop,
        source: `${preset}:${animName}`,
      });
      await saveLibraryClip(lib);
      libraryClips.value = [...libraryClips.value.filter((c) => c.id !== lib.id), lib];
      flashStatus("ok", `imported ${lib.id} (${Object.keys(lib.tracks).length} bones)`);
    } catch (err) {
      flashStatus("err", `import failed: ${(err as Error).message}`);
    }
  }

  // Bone match preview — show how many source bones will land on a target.
  const matchedBones: { src: string; tgt: string }[] = (() => {
    if (!summary || !presetData) return [];
    return summary.boneNames
      .map((src) => ({ src, tgt: presetData.bones[src] ?? "" }))
      .filter((m) => m.tgt);
  })();
  const unmappedBones: string[] = summary
    ? summary.boneNames.filter((b) => !presetData?.bones[b])
    : [];

  return (
    <div>
      <h3 class="eyebrow" style={{ margin: "0 0 var(--s-3)" }}>Import a GLB animation</h3>

      <Row label="GLB file">
        <input type="file" accept=".glb,.gltf" onChange={onFile} />
        {fileName && <span class="text-dim" style={{ marginLeft: 6 }}>{fileName}</span>}
      </Row>

      {summary && (
        <>
          <Row label="Animation">
            <select value={animIdx} onChange={(e) => setAnimIdx(parseInt((e.target as HTMLSelectElement).value))}>
              {summary.animations.map((a, i) => (
                <option key={i} value={i}>
                  {a.name} — {a.durationSec.toFixed(2)}s, {a.trackedBones.length} bones
                </option>
              ))}
            </select>
          </Row>

          <Row label="Source library">
            <select value={preset} onChange={(e) => setPreset((e.target as HTMLSelectElement).value as Preset)}>
              {PRESETS.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </Row>

          <Row label="Target skeleton">
            <select value={skeleton} onChange={(e) => setSkeleton((e.target as HTMLSelectElement).value)}>
              {skeletons.map((s) => <option key={s.id} value={s.id}>{s.id}</option>)}
            </select>
          </Row>

          <Row label="Clip id">
            <input
              value={clipId}
              onInput={(e) => setClipId((e.target as HTMLInputElement).value)}
              placeholder="walk"
              style={{ width: 260 }}
            />
            <span class="flavour" style={{ marginLeft: 6 }}>
              (use slot name like "walk" / "idle" to override the skeleton's inline clip)
            </span>
          </Row>

          <Row label="Sample fps">
            <input
              type="number" value={fps} min={10} max={60}
              onInput={(e) => setFps(parseInt((e.target as HTMLInputElement).value))}
              style={{ width: 72 }}
            />
          </Row>

          <Row label="Loop">
            <input type="checkbox" checked={loop} onChange={(e) => setLoop((e.target as HTMLInputElement).checked)} />
          </Row>

          <details style={{ marginTop: 12, color: "var(--bone-dim)" }}>
            <summary style={{ cursor: "pointer", padding: 4 }}>
              Bone map: <span class="num">{matchedBones.length}</span> matched, <span class="num">{unmappedBones.length}</span> unmapped (will be dropped)
            </summary>
            <div style={{ display: "flex", gap: 12, marginTop: 6 }}>
              <div style={{ flex: 1 }}>
                <div class="eyebrow text-ok" style={{ marginBottom: 4 }}>matched ({matchedBones.length})</div>
                {matchedBones.map((m) => (
                  <div key={m.src} style={{ fontSize: 10, fontFamily: "var(--font-mono)" }}>
                    <span class="text-dim">{m.src}</span> → <span style={{ color: "var(--lichen-hi)" }}>{m.tgt}</span>
                  </div>
                ))}
              </div>
              <div style={{ flex: 1 }}>
                <div class="eyebrow" style={{ marginBottom: 4 }}>dropped ({unmappedBones.length})</div>
                {unmappedBones.map((b) => (
                  <div key={b} style={{ fontSize: 10, color: "var(--bone-faint)", fontFamily: "var(--font-mono)" }}>{b}</div>
                ))}
              </div>
            </div>
          </details>

          <div style={{ marginTop: 14 }}>
            <button class="btn primary" onClick={doImport} disabled={!clipId.trim()}>
              Save to library
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function Row({ label, children }: { label: string; children: preact.ComponentChildren }) {
  return (
    <div style={{ display: "flex", alignItems: "center", marginBottom: 8, gap: 8 }}>
      <label class="eyebrow" style={{ width: 130 }}>{label}</label>
      {children}
    </div>
  );
}
