/**
 * Animation library panel — root of the Library tab.  Hosts four sub-workflows:
 *
 *   - Browse: list every clip in the library + each skeleton's inline clips
 *   - Import: load a GLB, pick an animation, choose a bone-map preset, save
 *   - Mix:    author a compound clip (additive / cross-fade / phase-shift)
 *   - Assign: edit a prefab's animationSlots → clipId mapping
 *
 * Sub-panels each live in their own file so this stays a thin router.
 */
import { librarySubTab, libraryStatus } from "../lib_state.ts";
import { BrowsePanel } from "./browse_panel.tsx";
import { ImportPanel } from "./import_panel.tsx";
import { MixPanel } from "./mix_panel.tsx";
import { AssignPanel } from "./assign_panel.tsx";
import type { BrowserContentStore } from "../../content_loader.ts";

interface Props { content: BrowserContentStore; }

const TAB: preact.JSX.CSSProperties = {
  padding: "5px 12px", border: "none", cursor: "pointer",
  fontFamily: "monospace", fontSize: 11, background: "transparent",
  borderBottom: "2px solid transparent", color: "#666",
};

export function LibraryPanel({ content }: Props) {
  const sub = librarySubTab.value;
  const status = libraryStatus.value;
  const tabStyle = (active: boolean): preact.JSX.CSSProperties => active
    ? { ...TAB, color: "#4a9c3f", borderBottomColor: "#4a9c3f" }
    : TAB;

  return (
    <div style={{
      width: "100%", height: "100%", display: "flex", flexDirection: "column",
      background: "#181818", color: "#ccc", fontFamily: "monospace", fontSize: 12,
    }}>
      {/* Sub-tab bar */}
      <div style={{ display: "flex", background: "#1e1e1e", borderBottom: "1px solid #333", flexShrink: 0 }}>
        <button style={tabStyle(sub === "browse")} onClick={() => librarySubTab.value = "browse"}>Browse</button>
        <button style={tabStyle(sub === "import")} onClick={() => librarySubTab.value = "import"}>Import GLB</button>
        <button style={tabStyle(sub === "mix")}    onClick={() => librarySubTab.value = "mix"}>Mix</button>
        <button style={tabStyle(sub === "assign")} onClick={() => librarySubTab.value = "assign"}>Assign to prefab</button>
      </div>

      {/* Status banner */}
      {status && (
        <div style={{
          padding: "4px 10px",
          background: status.kind === "err" ? "#3a1a1a" : status.kind === "ok" ? "#1a3a1a" : "#2a2a3a",
          color: status.kind === "err" ? "#f88" : status.kind === "ok" ? "#8f8" : "#88f",
          borderBottom: "1px solid #333",
        }}>{status.text}</div>
      )}

      {/* Sub-panel */}
      <div style={{ flex: 1, overflow: "auto", padding: 10 }}>
        {sub === "browse" && <BrowsePanel content={content} />}
        {sub === "import" && <ImportPanel content={content} />}
        {sub === "mix"    && <MixPanel    content={content} />}
        {sub === "assign" && <AssignPanel content={content} />}
      </div>
    </div>
  );
}
