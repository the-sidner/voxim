/** Tool mode + layer selector toolbar. */
import { activeTool, activeLayer, undo, voxelCount, type ToolMode } from "../state.ts";

const TOOLS: { mode: ToolMode; label: string; key: string }[] = [
  { mode: "select", label: "Select", key: "S" },
  { mode: "paint",  label: "Paint",  key: "P" },
  { mode: "erase",  label: "Erase",  key: "E" },
  { mode: "fill",   label: "Fill",   key: "F" },
];

export function Toolbar() {
  const tool  = activeTool.value;
  const layer = activeLayer.value;

  return (
    <div style={{
      display: "flex",
      alignItems: "center",
      gap: "var(--s-2)",
      padding: "var(--s-2) var(--s-3)",
    }}>
      {TOOLS.map((t) => (
        <button
          key={t.mode}
          class={`btn sm ${tool === t.mode ? "is-active" : ""}`}
          onClick={() => { activeTool.value = t.mode; }}
        >
          <span class="kbd">{t.key}</span>{t.label}
        </button>
      ))}

      <div class="dt-divider" />

      <span class="eyebrow">Y layer</span>
      <button class="btn xs" onClick={() => { activeLayer.value = layer - 1; }}>↓</button>
      <span class="num" style={{ minWidth: 28, textAlign: "center", color: "var(--bone)" }}>{layer}</span>
      <button class="btn xs" onClick={() => { activeLayer.value = layer + 1; }}>↑</button>

      <div class="dt-divider" />

      <button class="btn sm" onClick={() => undo()}>
        <span class="kbd">Z</span>Undo
      </button>

      <span class="eyebrow" style={{ marginLeft: "auto" }}>
        <span class="num" style={{ color: "var(--bone-dim)" }}>{voxelCount.value}</span> voxels
      </span>
    </div>
  );
}
