/**
 * SubObject list — add/delete/select.
 * Editing properties of the selected subobject is handled by SelectionPanel.
 */
import { subObjects, selectedSubObject, addSubObject, removeSubObject } from "../state.ts";

const BTN: preact.JSX.CSSProperties = {
  background: "#2a2a2a", border: "1px solid #555", color: "#aaa",
  cursor: "pointer", borderRadius: 2, fontSize: 11, padding: "2px 6px",
};

export function SubObjectPanel() {
  const subs = subObjects.value;
  const selIdx = selectedSubObject.value;

  return (
    <div style={{ padding: 8, borderTop: "1px solid #333" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
        <span style={{ fontSize: 11, color: "#888", fontWeight: "bold" }}>SUBOBJECTS</span>
        <button style={BTN} onClick={addSubObject}>+ Add</button>
      </div>

      <div style={{ maxHeight: 120, overflowY: "auto", display: "flex", flexDirection: "column", gap: 2 }}>
        {subs.length === 0 && <div style={{ color: "#555", fontSize: 11 }}>None.</div>}
        {subs.map((s, i) => {
          const label = s.pool?.length ? `pool[${s.pool.length}]` : (s.modelId || "—");
          const isSel = i === selIdx;
          return (
            <div key={i}
              onClick={() => { selectedSubObject.value = isSel ? null : i; }}
              style={{
                display: "flex", alignItems: "center", justifyContent: "space-between",
                padding: "3px 6px", borderRadius: 3, cursor: "pointer",
                background: isSel ? "#2a3528" : "#252525",
                border: isSel ? "1px solid #4a7c3f" : "1px solid #333",
                fontSize: 11, color: isSel ? "#cec" : "#aaa",
              }}
            >
              <span>#{i} {label}</span>
              <button
                style={{ ...BTN, color: "#c66", padding: "0 4px" }}
                onClick={(e) => { e.stopPropagation(); removeSubObject(i); }}
              >✕</button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
