/** Model metadata editor: id, version, skeletonId. Hitbox is derived — not authored here. */
import type { SkeletonDef } from "@voxim/content";
import { modelId, modelVersion, skeletonId } from "../state.ts";

interface Props { skeletons: SkeletonDef[]; }

const LABEL: preact.JSX.CSSProperties = { color: "#888", fontSize: 11, marginBottom: 2 };
const INPUT: preact.JSX.CSSProperties = {
  background: "#2a2a2a", border: "1px solid #444", color: "#ddd",
  fontFamily: "monospace", fontSize: 12, padding: "2px 5px", borderRadius: 3, width: "100%",
};
const NUM: preact.JSX.CSSProperties = { ...INPUT, width: 52 };

export function ModelPanel({ skeletons }: Props) {
  return (
    <div style={{ padding: 8, borderTop: "1px solid #333" }}>
      <div style={{ fontSize: 11, color: "#888", marginBottom: 6, fontWeight: "bold" }}>MODEL</div>

      <div style={LABEL}>ID</div>
      <input style={{ ...INPUT, marginBottom: 6 }} value={modelId.value}
        onInput={(e) => { modelId.value = (e.target as HTMLInputElement).value; }} />

      <div style={LABEL}>Version</div>
      <input style={{ ...NUM, marginBottom: 6 }} type="number" value={modelVersion.value}
        onInput={(e) => { modelVersion.value = parseInt((e.target as HTMLInputElement).value) || 1; }} />

      <div style={LABEL}>Skeleton</div>
      <select style={INPUT}
        value={skeletonId.value ?? ""}
        onChange={(e) => { skeletonId.value = (e.target as HTMLSelectElement).value || null; }}>
        <option value="">— none —</option>
        {skeletons.map((s) => <option key={s.id} value={s.id}>{s.id}</option>)}
      </select>
    </div>
  );
}
