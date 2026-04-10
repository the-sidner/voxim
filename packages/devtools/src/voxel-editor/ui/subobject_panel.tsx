/** SubObject list editor. */
import type { SkeletonDef } from "@voxim/content";
import type { SubObjectRef } from "@voxim/content";
import { subObjects, selectedSubObject, skeletonId as skelIdSignal } from "../state.ts";

interface Props {
  modelIds: readonly string[];
  skeletons: SkeletonDef[];
}

const INPUT: preact.JSX.CSSProperties = {
  background: "#2a2a2a", border: "1px solid #444", color: "#ddd",
  fontFamily: "monospace", fontSize: 11, padding: "2px 4px", borderRadius: 2, width: "100%",
};
const NUM: preact.JSX.CSSProperties = { ...INPUT, width: 52 };
const BTN: preact.JSX.CSSProperties = {
  background: "#2a2a2a", border: "1px solid #555", color: "#aaa",
  cursor: "pointer", borderRadius: 2, fontSize: 11, padding: "2px 6px",
};

function defaultSubObject(): SubObjectRef {
  return {
    modelId: "",
    transform: { x: 0, y: 0, z: 0, rotX: 0, rotY: 0, rotZ: 0, scaleX: 1, scaleY: 1, scaleZ: 1 },
  };
}

function update(index: number, patch: Partial<SubObjectRef>): void {
  const next = subObjects.value.map((s, i) => i === index ? { ...s, ...patch } : s);
  subObjects.value = next;
}

function updateTransform(index: number, key: string, value: number): void {
  const next = subObjects.value.map((s, i) => {
    if (i !== index) return s;
    return { ...s, transform: { ...s.transform, [key]: value } };
  });
  subObjects.value = next;
}

interface SubRowProps {
  sub: SubObjectRef;
  index: number;
  modelIds: readonly string[];
  boneIds: string[];
}

function SubRow({ sub, index, modelIds, boneIds }: SubRowProps) {
  const isPool = !!(sub.pool && sub.pool.length > 0);
  const sel = selectedSubObject.value === index;

  return (
    <div
      style={{
        padding: 6, marginBottom: 4,
        background: sel ? "#2a3528" : "#252525",
        border: sel ? "1px solid #4a7c3f" : "1px solid #333",
        borderRadius: 3,
      }}
      onClick={() => { selectedSubObject.value = sel ? null : index; }}
    >
      {/* Header row */}
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: sel ? 6 : 0 }}>
        <span style={{ fontSize: 11, color: "#aaa" }}>
          {isPool ? `pool[${sub.pool!.length}]` : (sub.modelId || "—")}
        </span>
        <button style={{ ...BTN, color: "#c66" }}
          onClick={(e) => { e.stopPropagation(); subObjects.value = subObjects.value.filter((_, i) => i !== index); }}>✕</button>
      </div>

      {sel && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11 }} onClick={(e) => e.stopPropagation()}>
          {/* Mode toggle */}
          <div style={{ display: "flex", gap: 4 }}>
            <button style={{ ...BTN, background: !isPool ? "#333" : "#2a2a2a" }}
              onClick={() => update(index, { pool: undefined, modelId: "" })}>Fixed</button>
            <button style={{ ...BTN, background: isPool ? "#333" : "#2a2a2a" }}
              onClick={() => update(index, { pool: [""], modelId: undefined })}>Pool</button>
          </div>

          {isPool ? (
            <div>
              <div style={{ color: "#666", marginBottom: 2 }}>Pool (comma-separated model IDs)</div>
              <input style={INPUT}
                value={sub.pool!.join(",")}
                onInput={(e) => update(index, { pool: (e.target as HTMLInputElement).value.split(",").map(s => s.trim()).filter(Boolean) })}
              />
              <div style={{ color: "#666", marginTop: 4, marginBottom: 2 }}>Probability (0–1)</div>
              <input type="number" min={0} max={1} step={0.05} style={NUM}
                value={sub.probability ?? 1}
                onInput={(e) => update(index, { probability: parseFloat((e.target as HTMLInputElement).value) })}
              />
            </div>
          ) : (
            <div>
              <div style={{ color: "#666", marginBottom: 2 }}>Model ID</div>
              <select style={INPUT} value={sub.modelId ?? ""}
                onChange={(e) => update(index, { modelId: (e.target as HTMLSelectElement).value })}>
                <option value="">— none —</option>
                {modelIds.map((id) => <option key={id} value={id}>{id}</option>)}
              </select>
            </div>
          )}

          {/* Transform */}
          <div style={{ color: "#666" }}>Transform</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 3 }}>
            {(["x","y","z","rotX","rotY","rotZ","scaleX","scaleY","scaleZ"] as const).map((k) => (
              <label key={k} style={{ display: "flex", flexDirection: "column", gap: 1 }}>
                <span style={{ color: "#555", fontSize: 10 }}>{k}</span>
                <input type="number" step={k.startsWith("scale") ? 0.1 : 0.5} style={{ ...NUM, width: "100%" }}
                  value={sub.transform[k]}
                  onInput={(e) => updateTransform(index, k, parseFloat((e.target as HTMLInputElement).value) || 0)}
                />
              </label>
            ))}
          </div>

          {/* Bone + slot */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4 }}>
            <div>
              <div style={{ color: "#666", marginBottom: 2 }}>Bone</div>
              <select style={INPUT} value={sub.boneId ?? ""}
                onChange={(e) => update(index, { boneId: (e.target as HTMLSelectElement).value || undefined })}>
                <option value="">— none —</option>
                {boneIds.map((b) => <option key={b} value={b}>{b}</option>)}
              </select>
            </div>
            <div>
              <div style={{ color: "#666", marginBottom: 2 }}>Material slot</div>
              <input style={INPUT} value={sub.materialSlot ?? ""}
                onInput={(e) => update(index, { materialSlot: (e.target as HTMLInputElement).value || undefined })}
              />
            </div>
          </div>

          <label style={{ display: "flex", gap: 6, alignItems: "center", color: "#aaa" }}>
            <input type="checkbox" checked={sub.hitbox !== false}
              onChange={(e) => update(index, { hitbox: (e.target as HTMLInputElement).checked ? undefined : false as const })}
            />
            Include in hitbox
          </label>
        </div>
      )}
    </div>
  );
}

export function SubObjectPanel({ modelIds, skeletons }: Props) {
  const subs = subObjects.value;
  const skelId = skelIdSignal.value;
  const skeleton = skelId ? skeletons.find((s) => s.id === skelId) : null;
  const boneIds = skeleton ? skeleton.bones.map((b) => b.id) : [];

  return (
    <div style={{ padding: 8, borderTop: "1px solid #333" }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
        <span style={{ fontSize: 11, color: "#888", fontWeight: "bold" }}>SUBOBJECTS</span>
        <button style={BTN}
          onClick={() => { subObjects.value = [...subs, defaultSubObject()]; selectedSubObject.value = subs.length; }}>
          + Add
        </button>
      </div>
      <div style={{ maxHeight: 260, overflowY: "auto" }}>
        {subs.length === 0 && <div style={{ color: "#555", fontSize: 11 }}>No subobjects.</div>}
        {subs.map((s, i) => (
          <SubRow key={i} sub={s} index={i} modelIds={modelIds} boneIds={boneIds} />
        ))}
      </div>
    </div>
  );
}
