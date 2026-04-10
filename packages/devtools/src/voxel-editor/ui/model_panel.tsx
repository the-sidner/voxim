/** Model metadata editor: id, version, skeletonId, hitbox, auto-fit. */
import type { SkeletonDef } from "@voxim/content";
import { modelId, modelVersion, skeletonId, hitbox, autoFitHitbox } from "../state.ts";

interface Props {
  skeletons: SkeletonDef[];
}

const LABEL: preact.JSX.CSSProperties = { color: "#888", fontSize: 11, marginBottom: 2 };
const INPUT: preact.JSX.CSSProperties = {
  background: "#2a2a2a", border: "1px solid #444", color: "#ddd",
  fontFamily: "monospace", fontSize: 12, padding: "2px 5px", borderRadius: 3, width: "100%",
};
const NUM: preact.JSX.CSSProperties = { ...INPUT, width: 52 };
const ROW: preact.JSX.CSSProperties = { display: "flex", gap: 4, alignItems: "center" };

export function ModelPanel({ skeletons }: Props) {
  const hb = hitbox.value;

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
      <select style={{ ...INPUT, marginBottom: 6 }}
        value={skeletonId.value ?? ""}
        onChange={(e) => { skeletonId.value = (e.target as HTMLSelectElement).value || null; }}>
        <option value="">— none —</option>
        {skeletons.map((s) => <option key={s.id} value={s.id}>{s.id}</option>)}
      </select>

      <div style={{ ...ROW, marginBottom: 4, justifyContent: "space-between" }}>
        <div style={LABEL}>Hitbox</div>
        <button
          style={{ fontSize: 10, padding: "1px 6px", background: "#2a2a2a", border: "1px solid #444", color: "#aaa", cursor: "pointer", borderRadius: 2 }}
          onClick={autoFitHitbox}
        >Auto-fit</button>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4, fontSize: 10 }}>
        {(["minX","minY","minZ","maxX","maxY","maxZ"] as const).map((k) => (
          <label key={k} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <span style={{ color: "#666" }}>{k}</span>
            <input
              type="number" step="0.5"
              style={{ ...NUM, width: "100%" }}
              value={hb[k]}
              onInput={(e) => {
                hitbox.value = { ...hb, [k]: parseFloat((e.target as HTMLInputElement).value) || 0 };
              }}
            />
          </label>
        ))}
      </div>
    </div>
  );
}
