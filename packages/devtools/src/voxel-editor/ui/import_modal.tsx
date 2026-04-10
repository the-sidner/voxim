/** Import modal — paste JSON or pick model ID from content store. */
import { useState } from "preact/hooks";
import type { ModelDefinition } from "@voxim/content";
import { fromModelDefinition, modelId } from "../state.ts";

interface Props {
  modelIds: readonly string[];
  onClose: () => void;
}

export function ImportModal({ modelIds, onClose }: Props) {
  const [tab, setTab] = useState<"paste" | "pick">("pick");
  const [pasteText, setPasteText] = useState("");
  const [pasteError, setPasteError] = useState("");
  const [pickId, setPickId] = useState(modelIds[0] ?? "");

  const BTN: preact.JSX.CSSProperties = {
    background: "#2a2a2a", border: "1px solid #555", color: "#aaa",
    cursor: "pointer", borderRadius: 2, fontSize: 12, padding: "4px 10px",
  };
  const TAB: preact.JSX.CSSProperties = {
    ...BTN, borderBottom: "none", borderRadius: "3px 3px 0 0",
  };
  const TAB_ACTIVE: preact.JSX.CSSProperties = { ...TAB, background: "#333", color: "#fff" };
  const INPUT: preact.JSX.CSSProperties = {
    background: "#2a2a2a", border: "1px solid #444", color: "#ddd",
    fontFamily: "monospace", fontSize: 12, padding: "4px 6px", borderRadius: 3, width: "100%",
  };

  function importPaste() {
    try {
      const def = JSON.parse(pasteText) as ModelDefinition;
      if (!def.nodes || !def.id) throw new Error("Missing nodes or id");
      fromModelDefinition(def);
      onClose();
    } catch (err) {
      setPasteError(String(err));
    }
  }

  async function importPick() {
    const res = await fetch(`/content/../../../packages/content/data/models.json`).catch(() => null);
    // We already have all models in the store; load from it
    // The editor's state holds all model definitions — just trigger via import of the definition
    // We passed modelIds but not the definitions; use fetch as a fallback
    try {
      const modelsRes = await fetch("/content/models.json");
      const models = await modelsRes.json() as ModelDefinition[];
      const def = models.find((m) => m.id === pickId);
      if (!def) throw new Error(`Model "${pickId}" not found`);
      fromModelDefinition(def);
      onClose();
    } catch (err) {
      setPasteError(String(err));
    }
  }

  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)",
      display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100,
    }} onClick={onClose}>
      <div style={{
        background: "#222", border: "1px solid #444", borderRadius: 6, padding: 16,
        width: 420, maxHeight: "80vh", overflow: "auto",
      }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 12 }}>
          <span style={{ fontSize: 13, color: "#ccc", fontWeight: "bold" }}>Import Model</span>
          <button style={{ ...BTN, color: "#c66" }} onClick={onClose}>✕</button>
        </div>

        {/* Tabs */}
        <div style={{ display: "flex", borderBottom: "1px solid #444", marginBottom: 12 }}>
          <button style={tab === "pick" ? TAB_ACTIVE : TAB} onClick={() => setTab("pick")}>Pick from content</button>
          <button style={tab === "paste" ? TAB_ACTIVE : TAB} onClick={() => setTab("paste")}>Paste JSON</button>
        </div>

        {tab === "pick" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <select style={INPUT} value={pickId} onChange={(e) => setPickId((e.target as HTMLSelectElement).value)}>
              {modelIds.map((id) => <option key={id} value={id}>{id}</option>)}
            </select>
            <button style={{ ...BTN, alignSelf: "flex-end" }} onClick={importPick}>Load</button>
          </div>
        )}

        {tab === "paste" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <textarea
              placeholder='Paste ModelDefinition JSON here...'
              value={pasteText}
              onInput={(e) => { setPasteText((e.target as HTMLTextAreaElement).value); setPasteError(""); }}
              style={{ ...INPUT, height: 200, resize: "vertical" }}
            />
            {pasteError && <div style={{ color: "#c66", fontSize: 11 }}>{pasteError}</div>}
            <button style={{ ...BTN, alignSelf: "flex-end" }} onClick={importPaste}>Import</button>
          </div>
        )}
      </div>
    </div>
  );
}
