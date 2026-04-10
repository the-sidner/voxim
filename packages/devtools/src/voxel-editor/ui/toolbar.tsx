/** Tool mode + layer selector toolbar. */
import { activeTool, activeLayer, undo, voxelCount, type ToolMode } from "../state.ts";

const TOOLS: { mode: ToolMode; label: string }[] = [
  { mode: "select", label: "Select [S]" },
  { mode: "paint",  label: "Paint [P]"  },
  { mode: "erase",  label: "Erase [E]"  },
  { mode: "fill",   label: "Fill [F]"   },
];

const BTN: preact.JSX.CSSProperties = {
  padding: "4px 10px", border: "1px solid #555", borderRadius: 3,
  cursor: "pointer", background: "#2a2a2a", color: "#ccc", fontFamily: "monospace", fontSize: 12,
};
const BTN_ACTIVE: preact.JSX.CSSProperties = {
  ...BTN, background: "#4a7c3f", color: "#fff", borderColor: "#6aac5f",
};

export function Toolbar() {
  const tool  = activeTool.value;
  const layer = activeLayer.value;

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 8px", background: "#1e1e1e", borderBottom: "1px solid #333", flexShrink: 0 }}>
      {TOOLS.map((t) => (
        <button key={t.mode} style={tool === t.mode ? BTN_ACTIVE : BTN}
          onClick={() => { activeTool.value = t.mode; }}>
          {t.label}
        </button>
      ))}
      <span style={{ color: "#666", margin: "0 4px" }}>|</span>
      <span style={{ color: "#888", fontSize: 11 }}>Y Layer:</span>
      <button style={BTN} onClick={() => { activeLayer.value = layer - 1; }}>[ ↓ ]</button>
      <span style={{ color: "#ccc", minWidth: 24, textAlign: "center" }}>{layer}</span>
      <button style={BTN} onClick={() => { activeLayer.value = layer + 1; }}>[ ↑ ]</button>
      <span style={{ color: "#666", margin: "0 4px" }}>|</span>
      <button style={BTN} onClick={() => undo()}>Undo [Z]</button>
      <span style={{ color: "#555", fontSize: 11, marginLeft: "auto" }}>{voxelCount.value} voxels</span>
    </div>
  );
}
