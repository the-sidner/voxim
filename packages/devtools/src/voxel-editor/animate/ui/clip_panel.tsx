/**
 * Clip Panel — list of animation clips with add/delete/rename/loop/duration controls.
 */
import { useState } from "preact/hooks";
import {
  editingSkeleton, editingClipId,
  addClip, deleteClip, renameClip, setClipLoop, setClipDuration,
} from "../anim_state.ts";

const BTN: preact.JSX.CSSProperties = {
  background: "#2a2a2a", border: "1px solid #555", color: "#aaa",
  cursor: "pointer", borderRadius: 2, fontSize: 11, padding: "2px 6px",
};
const INPUT: preact.JSX.CSSProperties = {
  background: "#1e1e1e", border: "1px solid #444", color: "#ddd",
  fontFamily: "monospace", fontSize: 11, padding: "2px 4px", borderRadius: 2,
};

export function ClipPanel() {
  const sk = editingSkeleton.value;
  const selClipId = editingClipId.value;
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameVal, setRenameVal] = useState("");

  if (!sk) return null;

  const clips = sk.clips ?? [];

  function startRename(id: string) {
    setRenaming(id);
    setRenameVal(id);
  }

  function commitRename() {
    if (renaming) {
      renameClip(renaming, renameVal.trim());
      setRenaming(null);
    }
  }

  const selClip = clips.find((c) => c.id === selClipId);

  return (
    <div style={{ padding: 8, borderTop: "1px solid #333" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
        <span style={{ fontSize: 11, color: "#888", fontWeight: "bold" }}>CLIPS</span>
        <button style={BTN} onClick={addClip}>+ Add</button>
      </div>

      {/* Clip list */}
      <div style={{ maxHeight: 100, overflowY: "auto", display: "flex", flexDirection: "column", gap: 2, marginBottom: 6 }}>
        {clips.length === 0 && <div style={{ color: "#555", fontSize: 11 }}>None.</div>}
        {clips.map((c) => {
          const isSel = c.id === selClipId;
          return (
            <div key={c.id}
              onClick={() => { editingClipId.value = c.id; }}
              style={{
                display: "flex", alignItems: "center", justifyContent: "space-between",
                padding: "3px 6px", borderRadius: 3, cursor: "pointer",
                background: isSel ? "#2a3528" : "#252525",
                border: isSel ? "1px solid #4a7c3f" : "1px solid #333",
                fontSize: 11, color: isSel ? "#cec" : "#aaa",
              }}
            >
              {renaming === c.id
                ? (
                  <input
                    style={{ ...INPUT, flex: 1, marginRight: 4 }}
                    value={renameVal}
                    autoFocus
                    onInput={(e) => setRenameVal((e.target as HTMLInputElement).value)}
                    onBlur={commitRename}
                    onKeyDown={(e) => { if (e.key === "Enter") commitRename(); if (e.key === "Escape") setRenaming(null); }}
                    onClick={(e) => e.stopPropagation()}
                  />
                )
                : <span onDblClick={(e) => { e.stopPropagation(); startRename(c.id); }}>{c.id}</span>
              }
              <button
                style={{ ...BTN, color: "#c66", padding: "0 4px", marginLeft: 4 }}
                onClick={(e) => { e.stopPropagation(); deleteClip(c.id); }}
              >✕</button>
            </div>
          );
        })}
      </div>

      {/* Selected clip properties */}
      {selClip && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <label style={{ fontSize: 11, color: "#888", flexShrink: 0 }}>Duration (s)</label>
            <input
              type="number"
              step="0.1"
              min="0.05"
              style={{ ...INPUT, width: 60 }}
              value={(selClip.durationSeconds ?? 1.0).toFixed(2)}
              onBlur={(e) => setClipDuration(selClip.id, parseFloat((e.target as HTMLInputElement).value) || 1)}
              onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
            />
            <label style={{ fontSize: 11, color: "#888", display: "flex", alignItems: "center", gap: 4, cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={selClip.loop}
                onChange={(e) => setClipLoop(selClip.id, (e.target as HTMLInputElement).checked)}
              />
              Loop
            </label>
          </div>
        </div>
      )}
    </div>
  );
}
