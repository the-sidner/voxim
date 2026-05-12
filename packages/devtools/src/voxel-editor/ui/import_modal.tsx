/** Import modal — paste JSON or pick model ID from content store. */
import { useState } from "preact/hooks";
import type { ModelDefinition } from "@voxim/content";
import { fromModelDefinition } from "../state.ts";

interface Props {
  modelIds: readonly string[];
  onClose: () => void;
}

export function ImportModal({ modelIds, onClose }: Props) {
  const [tab, setTab] = useState<"paste" | "pick">("pick");
  const [pasteText, setPasteText] = useState("");
  const [pasteError, setPasteError] = useState("");
  const [pickId, setPickId] = useState(modelIds[0] ?? "");

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
    <div
      style={{
        position: "fixed", inset: 0, background: "rgba(7, 6, 3, 0.78)",
        display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100,
      }}
      onClick={onClose}
    >
      <div
        class="dt-pane"
        style={{ width: 460, maxHeight: "80vh", overflow: "auto" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div class="dt-pane-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span>Import Model</span>
          <button class="btn xs ghost danger" onClick={onClose}>✕</button>
        </div>

        <div style={{ display: "flex", borderBottom: "1px solid var(--line)" }}>
          <button class={`dt-tab ${tab === "pick" ? "is-active" : ""}`} onClick={() => setTab("pick")}>
            Pick from content
          </button>
          <button class={`dt-tab ${tab === "paste" ? "is-active" : ""}`} onClick={() => setTab("paste")}>
            Paste JSON
          </button>
        </div>

        <div style={{ padding: "var(--s-4)", display: "flex", flexDirection: "column", gap: "var(--s-3)" }}>
          {tab === "pick" && (
            <>
              <select value={pickId} onChange={(e) => setPickId((e.target as HTMLSelectElement).value)}>
                {modelIds.map((id) => <option key={id} value={id}>{id}</option>)}
              </select>
              <button class="btn primary" style={{ alignSelf: "flex-end" }} onClick={importPick}>Load</button>
            </>
          )}

          {tab === "paste" && (
            <>
              <textarea
                placeholder="Paste ModelDefinition JSON here..."
                value={pasteText}
                onInput={(e) => { setPasteText((e.target as HTMLTextAreaElement).value); setPasteError(""); }}
                style={{ height: 200, resize: "vertical" }}
              />
              {pasteError && <div class="text-danger" style={{ fontSize: "var(--fs-eyebrow)" }}>{pasteError}</div>}
              <button class="btn primary" style={{ alignSelf: "flex-end" }} onClick={importPaste}>Import</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
