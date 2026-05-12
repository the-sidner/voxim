/**
 * SubObject list — add/delete/select.
 * Editing properties of the selected subobject is handled by SelectionPanel.
 */
import { subObjects, selectedSubObject, addSubObject, removeSubObject } from "../state.ts";

export function SubObjectPanel() {
  const subs = subObjects.value;
  const selIdx = selectedSubObject.value;

  return (
    <div class="dt-section">
      <div class="dt-section-header">
        <span>SubObjects</span>
        <button class="btn xs" onClick={addSubObject}>+ Add</button>
      </div>

      <div style={{ maxHeight: 120, overflowY: "auto", display: "flex", flexDirection: "column", gap: "1px" }}>
        {subs.length === 0 && <span class="flavour">None.</span>}
        {subs.map((s, i) => {
          const label = s.pool?.length ? `pool[${s.pool.length}]` : (s.modelId || "—");
          const isSel = i === selIdx;
          return (
            <div
              key={i}
              class={`dt-tree-row ${isSel ? "is-selected" : ""}`}
              onClick={() => { selectedSubObject.value = isSel ? null : i; }}
              style={{
                display: "flex", alignItems: "center", justifyContent: "space-between",
                padding: "3px var(--s-3)",
              }}
            >
              <span>#{i} {label}</span>
              <button
                class="btn xs danger"
                onClick={(e) => { e.stopPropagation(); removeSubObject(i); }}
              >✕</button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
