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

  return (
    <div class="dt-section">
      <div class="dt-section-header">
        <span>Export JSON</span>
        <div style={{ display: "flex", gap: "var(--s-1)" }}>
          <button class="btn xs" onClick={copy}>{copied ? "Copied!" : "Copy"}</button>
          <button class="btn xs" onClick={download}>Download</button>
        </div>
      </div>
      <textarea
        readOnly
        value={json}
        style={{
          color: "var(--aether)",
          fontSize: 10,
          resize: "vertical",
          height: 160,
          overflowY: "auto",
        }}
      />
    </div>
  );
}
