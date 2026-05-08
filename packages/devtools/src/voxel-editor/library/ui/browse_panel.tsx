/**
 * Browse panel — lists every clip currently in the animation library, plus
 * the inline clips on each skeleton.  Clip rows show id, kind (plain /
 * additive / crossfade / phase_shift), source skeleton, and a delete button.
 */
import type { LibraryClipFile, SkeletonDef } from "@voxim/content";
import type { BrowserContentStore } from "../../content_loader.ts";
import { libraryClips, selectedLibraryClipId, flashStatus } from "../lib_state.ts";
import { deleteLibraryClip } from "../lib_api.ts";

interface Props { content: BrowserContentStore; }

const ROW: preact.JSX.CSSProperties = {
  display: "flex", padding: "3px 6px", borderBottom: "1px solid #222",
  fontFamily: "monospace", fontSize: 11, alignItems: "center", gap: 8,
};
const PILL: preact.JSX.CSSProperties = {
  padding: "1px 6px", background: "#333", color: "#aaa", borderRadius: 8, fontSize: 10,
};
const BTN: preact.JSX.CSSProperties = {
  padding: "1px 6px", background: "#2a2a2a", border: "1px solid #555",
  color: "#aaa", cursor: "pointer", borderRadius: 3, fontSize: 10, fontFamily: "monospace",
};

export function BrowsePanel({ content }: Props) {
  const lib = libraryClips.value;
  const skeletons: SkeletonDef[] = (() => {
    const ids = new Set<string>();
    for (const id of content.allModelIds) {
      const m = content.models.get(id);
      if (m?.skeletonId) ids.add(m.skeletonId);
    }
    return [...ids].map((id) => content.skeletons.get(id)).filter(Boolean) as SkeletonDef[];
  })();

  return (
    <div>
      <h3 style={{ margin: "0 0 8px", fontSize: 12, color: "#aaa" }}>
        Library — {lib.length} clip{lib.length === 1 ? "" : "s"}
      </h3>

      {lib.length === 0 && (
        <div style={{ padding: 12, color: "#666", fontStyle: "italic" }}>
          Empty.  Use the Import GLB or Mix tabs to add clips.
        </div>
      )}

      {lib.map((c) => {
        const isCompound = "_kind" in c;
        const kind = isCompound ? c._kind : "plain";
        return (
          <div
            key={c.id}
            style={{
              ...ROW,
              background: selectedLibraryClipId.value === c.id ? "#2a2a2a" : "transparent",
              cursor: "pointer",
            }}
            onClick={() => selectedLibraryClipId.value = c.id}
          >
            <span style={{ flex: 1, color: "#ddd" }}>{c.id}</span>
            <span style={{ ...PILL, background: kindColor(kind) }}>{kind}</span>
            <span style={{ ...PILL }}>{c._skeleton}</span>
            {c._source && <span style={{ ...PILL, background: "#2a3a2a" }}>{c._source}</span>}
            <button
              style={BTN}
              onClick={async (e) => {
                e.stopPropagation();
                if (!confirm(`Delete ${c.id}?`)) return;
                try {
                  await deleteLibraryClip(c.id);
                  libraryClips.value = libraryClips.value.filter((x) => x.id !== c.id);
                  flashStatus("ok", `deleted ${c.id}`);
                } catch (err) {
                  flashStatus("err", `delete failed: ${(err as Error).message}`);
                }
              }}
            >del</button>
          </div>
        );
      })}

      <h3 style={{ margin: "20px 0 8px", fontSize: 12, color: "#aaa" }}>
        Inline clips per skeleton
      </h3>
      {skeletons.map((sk) => (
        <div key={sk.id} style={{ marginBottom: 8 }}>
          <div style={{ color: "#bbb", fontWeight: "bold", marginBottom: 2 }}>
            {sk.id}
            <span style={{ color: "#666", fontWeight: "normal", marginLeft: 8 }}>
              ({sk.clips?.length ?? 0} inline + library overrides applied at server load)
            </span>
          </div>
          {(sk.clips ?? []).map((c) => (
            <div key={c.id} style={{ ...ROW, paddingLeft: 16 }}>
              <span style={{ flex: 1 }}>{c.id}</span>
              <span style={{ ...PILL }}>{Object.keys(c.tracks).length} bones</span>
              <span style={{ ...PILL }}>
                {Object.values(c.tracks).reduce((s, t) => s + t.length, 0)} keys
              </span>
              {libraryHasMatching(lib, c.id, sk.id) && (
                <span style={{ ...PILL, background: "#3a2a1a", color: "#fc8" }}>
                  overridden by library
                </span>
              )}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function libraryHasMatching(lib: LibraryClipFile[], clipId: string, skId: string): boolean {
  return lib.some((c) => c.id === clipId && c._skeleton === skId);
}

function kindColor(kind: string): string {
  switch (kind) {
    case "plain":      return "#2a3a4a";
    case "additive":   return "#3a2a4a";
    case "crossfade":  return "#4a3a2a";
    case "phase_shift":return "#2a4a3a";
    default:           return "#333";
  }
}
