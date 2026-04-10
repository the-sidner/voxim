/** Export panel — shows ModelDefinition JSON, copy + download. */
import { useState } from "preact/hooks";
import { toModelDefinition, modelId } from "../state.ts";

export function ExportPanel() {
  const [copied, setCopied] = useState(false);

  const json = JSON.stringify(toModelDefinition(), null, 2);

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
    a.download = `${modelId.value}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const BTN: preact.JSX.CSSProperties = {
    background: "#2a2a2a", border: "1px solid #555", color: "#aaa",
    cursor: "pointer", borderRadius: 2, fontSize: 11, padding: "3px 8px",
  };

  return (
    <div style={{ padding: 8, borderTop: "1px solid #333", display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontSize: 11, color: "#888", fontWeight: "bold" }}>EXPORT JSON</span>
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
          fontSize: 10, padding: 6, borderRadius: 3, resize: "vertical", height: 160,
          overflowY: "auto",
        }}
      />
    </div>
  );
}
