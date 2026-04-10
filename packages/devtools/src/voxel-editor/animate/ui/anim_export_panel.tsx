/**
 * Animation Export Panel — export the edited skeleton JSON (clips + bones + masks + IK chains).
 */
import { useState } from "preact/hooks";
import { editingSkeleton, exportSkeletonJson } from "../anim_state.ts";

const BTN: preact.JSX.CSSProperties = {
  background: "#2a2a2a", border: "1px solid #555", color: "#aaa",
  cursor: "pointer", borderRadius: 2, fontSize: 11, padding: "3px 8px",
};

export function AnimExportPanel() {
  const [copied, setCopied] = useState(false);
  const sk = editingSkeleton.value;

  if (!sk) return null;

  const json = exportSkeletonJson();

  function copy() {
    navigator.clipboard.writeText(json).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  function download() {
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${sk!.id}_skeleton.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div style={{ padding: 8, borderTop: "1px solid #333", display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontSize: 11, color: "#888", fontWeight: "bold" }}>EXPORT SKELETON</span>
        <div style={{ display: "flex", gap: 4 }}>
          <button style={BTN} onClick={copy}>{copied ? "Copied!" : "Copy"}</button>
          <button style={BTN} onClick={download}>Download</button>
        </div>
      </div>
      <textarea
        readOnly
        value={json}
        style={{
          background: "#1a1a1a", border: "1px solid #333", color: "#8bc", fontFamily: "monospace",
          fontSize: 10, padding: 6, borderRadius: 3, resize: "vertical", height: 120,
          overflowY: "auto",
        }}
      />
    </div>
  );
}
