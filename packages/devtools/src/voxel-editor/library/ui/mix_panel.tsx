/**
 * Mix panel — author a compound clip recipe (additive overlay / cross-fade /
 * phase-shift) and save it to the library.  Compound clips are baked into
 * plain clips at server content-load time, so the runtime never sees them.
 *
 * Source clips can be either inline skeleton clips or library plain clips —
 * the bake step indexes both.
 */
import { useState } from "preact/hooks";
import type { SkeletonDef, LibraryClipFile, AnimationClip } from "@voxim/content";
import type { BrowserContentStore } from "../../content_loader.ts";
import { libraryClips, flashStatus } from "../lib_state.ts";
import { saveLibraryClip } from "../lib_api.ts";

interface Props { content: BrowserContentStore; }

type Kind = "additive" | "crossfade" | "phase_shift";

const INPUT: preact.JSX.CSSProperties = {
  background: "#2a2a2a", border: "1px solid #444", color: "#ddd",
  fontFamily: "monospace", fontSize: 11, padding: "3px 6px", borderRadius: 3,
};
const BTN: preact.JSX.CSSProperties = { ...INPUT, cursor: "pointer", padding: "4px 12px" };

export function MixPanel({ content }: Props) {
  const [skeletonId, setSkeletonId] = useState<string>("biped");
  const [kind, setKind] = useState<Kind>("additive");
  const [id, setId] = useState<string>("");
  const [base, setBase] = useState<string>("");
  const [overlay, setOverlay] = useState<string>("");
  const [from, setFrom] = useState<string>("");
  const [to, setTo] = useState<string>("");
  const [source, setSource] = useState<string>("");
  const [mask, setMask] = useState<string>("");
  const [weight, setWeight] = useState<number>(0.5);
  const [offset, setOffset] = useState<number>(0.5);
  const [loop, setLoop] = useState<boolean>(true);

  const skeletons: SkeletonDef[] = (() => {
    const ids = new Set<string>();
    for (const id of content.allModelIds) {
      const m = content.models.get(id);
      if (m?.skeletonId) ids.add(m.skeletonId);
    }
    return [...ids].map((id) => content.skeletons.get(id)).filter(Boolean) as SkeletonDef[];
  })();
  const skel = skeletons.find((s) => s.id === skeletonId);

  // Available source clips for this skeleton: inline + library plain clips.
  const availableClips: AnimationClip[] = (() => {
    const inline = skel?.clips ?? [];
    const lib = libraryClips.value
      .filter((c): c is LibraryClipFile & { _skeleton: string } => c._skeleton === skeletonId)
      .filter((c) => !("_kind" in c)) as unknown as AnimationClip[];
    const seen = new Set<string>();
    const all: AnimationClip[] = [];
    for (const c of [...lib, ...inline]) { // library first so its names show up
      if (!seen.has(c.id)) { seen.add(c.id); all.push(c); }
    }
    return all;
  })();
  const masks = skel?.boneMasks ?? [];

  async function doSave() {
    if (!id.trim()) { flashStatus("err", "id is required"); return; }
    let clip: LibraryClipFile;
    if (kind === "additive") {
      if (!base || !overlay) { flashStatus("err", "base and overlay required"); return; }
      clip = {
        id: id.trim(), loop, _skeleton: skeletonId, _kind: "additive",
        base, overlay, ...(mask ? { mask } : {}), weight,
      };
    } else if (kind === "crossfade") {
      if (!from || !to) { flashStatus("err", "from and to required"); return; }
      clip = { id: id.trim(), loop, _skeleton: skeletonId, _kind: "crossfade", from, to, weight };
    } else {
      if (!source) { flashStatus("err", "source required"); return; }
      clip = { id: id.trim(), loop, _skeleton: skeletonId, _kind: "phase_shift", source, offset };
    }
    try {
      await saveLibraryClip(clip);
      libraryClips.value = [...libraryClips.value.filter((c) => c.id !== clip.id), clip];
      flashStatus("ok", `saved compound ${clip.id} (${kind})`);
    } catch (err) {
      flashStatus("err", `save failed: ${(err as Error).message}`);
    }
  }

  return (
    <div>
      <h3 style={{ margin: "0 0 8px", fontSize: 12, color: "#aaa" }}>Mix into a compound clip</h3>
      <p style={{ color: "#777", fontSize: 11, margin: "0 0 12px" }}>
        Compound clips are recipes; they get baked into plain clips at server content-load.
        Restart the tile server to see the result in-engine.
      </p>

      <Row label="Target skeleton">
        <select value={skeletonId} onChange={(e) => setSkeletonId((e.target as HTMLSelectElement).value)} style={INPUT}>
          {skeletons.map((s) => <option key={s.id} value={s.id}>{s.id}</option>)}
        </select>
      </Row>

      <Row label="New clip id">
        <input value={id} onInput={(e) => setId((e.target as HTMLInputElement).value)}
          placeholder="walk_proud" style={{ ...INPUT, width: 260 }} />
        <span style={{ color: "#666", marginLeft: 6 }}>
          (use slot name like "walk" to override the skeleton)
        </span>
      </Row>

      <Row label="Mix kind">
        <select value={kind} onChange={(e) => setKind((e.target as HTMLSelectElement).value as Kind)} style={INPUT}>
          <option value="additive">additive (base + overlay)</option>
          <option value="crossfade">crossfade (lerp from → to)</option>
          <option value="phase_shift">phase shift (offset source)</option>
        </select>
      </Row>

      {kind === "additive" && (
        <>
          <Row label="Base clip">
            <ClipPicker clips={availableClips} value={base} onChange={setBase} />
          </Row>
          <Row label="Overlay clip">
            <ClipPicker clips={availableClips} value={overlay} onChange={setOverlay} />
          </Row>
          <Row label="Mask (optional)">
            <select value={mask} onChange={(e) => setMask((e.target as HTMLSelectElement).value)} style={INPUT}>
              <option value="">— full body —</option>
              {masks.map((m) => <option key={m.id} value={m.id}>{m.id}</option>)}
            </select>
          </Row>
          <Row label="Overlay weight">
            <input type="range" min={0} max={1} step={0.05} value={weight}
              onInput={(e) => setWeight(parseFloat((e.target as HTMLInputElement).value))}
              style={{ width: 200 }} />
            <span style={{ color: "#aaa", marginLeft: 6 }}>{weight.toFixed(2)}</span>
          </Row>
        </>
      )}

      {kind === "crossfade" && (
        <>
          <Row label="From clip">
            <ClipPicker clips={availableClips} value={from} onChange={setFrom} />
          </Row>
          <Row label="To clip">
            <ClipPicker clips={availableClips} value={to} onChange={setTo} />
          </Row>
          <Row label="Weight (0=from, 1=to)">
            <input type="range" min={0} max={1} step={0.05} value={weight}
              onInput={(e) => setWeight(parseFloat((e.target as HTMLInputElement).value))}
              style={{ width: 200 }} />
            <span style={{ color: "#aaa", marginLeft: 6 }}>{weight.toFixed(2)}</span>
          </Row>
        </>
      )}

      {kind === "phase_shift" && (
        <>
          <Row label="Source clip">
            <ClipPicker clips={availableClips} value={source} onChange={setSource} />
          </Row>
          <Row label="Phase offset (0..1)">
            <input type="range" min={0} max={1} step={0.05} value={offset}
              onInput={(e) => setOffset(parseFloat((e.target as HTMLInputElement).value))}
              style={{ width: 200 }} />
            <span style={{ color: "#aaa", marginLeft: 6 }}>{offset.toFixed(2)}</span>
          </Row>
        </>
      )}

      <Row label="Loop">
        <input type="checkbox" checked={loop} onChange={(e) => setLoop((e.target as HTMLInputElement).checked)} />
      </Row>

      <div style={{ marginTop: 14 }}>
        <button style={BTN} onClick={doSave}>Save compound clip</button>
      </div>
    </div>
  );
}

function ClipPicker({ clips, value, onChange }: {
  clips: AnimationClip[]; value: string; onChange: (v: string) => void;
}) {
  return (
    <select value={value} onChange={(e) => onChange((e.target as HTMLSelectElement).value)} style={INPUT}>
      <option value="">— pick —</option>
      {clips.map((c) => <option key={c.id} value={c.id}>{c.id}</option>)}
    </select>
  );
}

function Row({ label, children }: { label: string; children: preact.ComponentChildren }) {
  return (
    <div style={{ display: "flex", alignItems: "center", marginBottom: 8, gap: 8 }}>
      <label style={{ width: 160, color: "#888", fontSize: 11 }}>{label}</label>
      {children}
    </div>
  );
}
