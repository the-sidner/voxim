/**
 * Animation Export Panel — export the edited skeleton JSON (clips + bones + masks + IK chains).
 */
import { useState } from "preact/hooks";
import { editingSkeleton, exportSkeletonJson } from "../anim_state.ts";

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
    <div class="dt-section">
      <div class="dt-section-header">
        <span>Export Skeleton</span>
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
          height: 120,
          overflowY: "auto",
        }}
      />
    </div>
  );
}
