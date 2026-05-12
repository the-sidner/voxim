/**
 * Clip Panel — list of animation clips with add/delete/rename/loop/duration controls.
 */
import { useState } from "preact/hooks";
import {
  editingSkeleton, editingClipId,
  addClip, deleteClip, renameClip, setClipLoop, setClipDuration,
} from "../anim_state.ts";

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
    <div class="dt-section">
      <div class="dt-section-header">
        <span>Clips</span>
        <button class="btn xs" onClick={addClip}>+ Add</button>
      </div>

      <div style={{ maxHeight: 120, overflowY: "auto", display: "flex", flexDirection: "column", gap: "1px" }}>
        {clips.length === 0 && <span class="flavour">None.</span>}
        {clips.map((c) => {
          const isSel = c.id === selClipId;
          return (
            <div
              key={c.id}
              class={`dt-tree-row ${isSel ? "is-selected" : ""}`}
              onClick={() => { editingClipId.value = c.id; }}
              style={{ justifyContent: "space-between" }}
            >
              {renaming === c.id
                ? (
                  <input
                    style={{ flex: 1, marginRight: 4 }}
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
                class="btn xs ghost danger"
                onClick={(e) => { e.stopPropagation(); deleteClip(c.id); }}
              >✕</button>
            </div>
          );
        })}
      </div>

      {selClip && (
        <div style={{ display: "flex", alignItems: "center", gap: "var(--s-3)" }}>
          <label style={{ display: "flex", flexDirection: "column", gap: 1, flex: 1 }}>
            <span class="eyebrow">Duration (s)</span>
            <input
              type="number"
              step="0.1"
              min="0.05"
              style={{ width: 80 }}
              value={(selClip.durationSeconds ?? 1.0).toFixed(2)}
              onBlur={(e) => setClipDuration(selClip.id, parseFloat((e.target as HTMLInputElement).value) || 1)}
              onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
            />
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 4, color: "var(--bone-dim)", fontSize: "var(--fs-small)", cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={selClip.loop}
              onChange={(e) => setClipLoop(selClip.id, (e.target as HTMLInputElement).checked)}
            />
            Loop
          </label>
        </div>
      )}
    </div>
  );
}
