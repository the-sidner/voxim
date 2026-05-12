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
import { InspectPanel } from "./inspect_panel.tsx";
import { ImportPanel } from "./import_panel.tsx";
import { MixPanel } from "./mix_panel.tsx";
import { AssignPanel } from "./assign_panel.tsx";
import type { BrowserContentStore } from "../../content_loader.ts";

interface Props { content: BrowserContentStore; }

export function LibraryPanel({ content }: Props) {
  const sub = librarySubTab.value;
  const status = libraryStatus.value;

  return (
    <div style={{
      width: "100%", height: "100%",
      display: "flex", flexDirection: "column",
      background: "var(--bog)",
    }}>
      {/* Sub-tab bar */}
      <div style={{
        display: "flex",
        background: "linear-gradient(180deg, var(--moss-hi), var(--moss))",
        borderBottom: "1px solid var(--line-strong)",
        flexShrink: 0,
      }}>
        <button class={`dt-tab ${sub === "inspect" ? "is-active" : ""}`} onClick={() => librarySubTab.value = "inspect"}>Inspect</button>
        <button class={`dt-tab ${sub === "import" ? "is-active" : ""}`}  onClick={() => librarySubTab.value = "import"}>Import GLB</button>
        <button class={`dt-tab ${sub === "mix" ? "is-active" : ""}`}     onClick={() => librarySubTab.value = "mix"}>Mix</button>
        <button class={`dt-tab ${sub === "assign" ? "is-active" : ""}`}  onClick={() => librarySubTab.value = "assign"}>Assign to prefab</button>
      </div>

      {status && (
        <div style={{
          padding: "var(--s-2) var(--s-4)",
          background: status.kind === "err" ? "var(--rot-deep)" : status.kind === "ok" ? "var(--bile-dim)" : "var(--aether-deep)",
          color:      status.kind === "err" ? "var(--rot)"      : status.kind === "ok" ? "var(--lichen-hi)" : "var(--aether-hi)",
          borderBottom: "1px solid var(--line)",
          fontFamily: "var(--font-mono)",
          fontSize: "var(--fs-eyebrow)",
          letterSpacing: "var(--ls-mono)",
        }}>{status.text}</div>
      )}

      {sub === "inspect" ? (
        <div style={{ flex: 1, overflow: "hidden", display: "flex" }}>
          <InspectPanel content={content} />
        </div>
      ) : (
        <div style={{ flex: 1, overflow: "auto", padding: "var(--s-4)" }}>
          {sub === "import" && <ImportPanel content={content} />}
          {sub === "mix"    && <MixPanel    content={content} />}
          {sub === "assign" && <AssignPanel content={content} />}
        </div>
      )}
    </div>
  );
}
