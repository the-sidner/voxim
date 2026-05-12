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

const PILL: preact.JSX.CSSProperties = {
  padding: "1px 6px",
  background: "var(--moss-hi)",
  border: "1px solid var(--line)",
  color: "var(--bone-dim)",
  fontSize: 10,
  fontFamily: "var(--font-mono)",
};

function kindPill(kind: string): preact.JSX.CSSProperties {
  switch (kind) {
    case "plain":      return { ...PILL, color: "var(--aether-hi)", borderColor: "var(--aether-deep)" };
    case "additive":   return { ...PILL, color: "var(--rot)",       borderColor: "var(--rot-deep)" };
    case "crossfade":  return { ...PILL, color: "var(--ember-hi)",  borderColor: "var(--ember-deep)" };
    case "phase_shift":return { ...PILL, color: "var(--lichen-hi)", borderColor: "var(--bile-dim)" };
    default:           return PILL;
  }
}

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
      <h3 class="eyebrow" style={{ margin: "0 0 var(--s-3)" }}>
        Library — <span class="num">{lib.length}</span> clip{lib.length === 1 ? "" : "s"}
      </h3>

      {lib.length === 0 && (
        <div class="flavour" style={{ padding: 12 }}>
          Empty.  Use the Import GLB or Mix tabs to add clips.
        </div>
      )}

      {lib.map((c) => {
        const isCompound = "_kind" in c;
        const kind = isCompound ? c._kind : "plain";
        const isSel = selectedLibraryClipId.value === c.id;
        return (
          <div
            key={c.id}
            class={`dt-tree-row ${isSel ? "is-selected" : ""}`}
            style={{ gap: "var(--s-3)" }}
            onClick={() => selectedLibraryClipId.value = c.id}
          >
            <span style={{ flex: 1, color: "var(--bone)" }}>{c.id}</span>
            <span style={kindPill(kind)}>{kind}</span>
            <span style={PILL}>{c._skeleton}</span>
            {c._source && <span style={{ ...PILL, color: "var(--lichen-hi)" }}>{c._source}</span>}
            <button
              class="btn xs ghost danger"
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

      <h3 class="eyebrow" style={{ margin: "var(--s-7) 0 var(--s-3)" }}>
        Inline clips per skeleton
      </h3>
      {skeletons.map((sk) => (
        <div key={sk.id} style={{ marginBottom: "var(--s-3)" }}>
          <div style={{ color: "var(--bone-hi)", fontFamily: "var(--font-mono)", fontWeight: 600, marginBottom: 2 }}>
            {sk.id}
            <span class="text-dim" style={{ marginLeft: 8, fontWeight: "normal" }}>
              ({sk.clips?.length ?? 0} inline + library overrides applied at server load)
            </span>
          </div>
          {(sk.clips ?? []).map((c) => (
            <div key={c.id} class="dt-tree-row" style={{ paddingLeft: 16, gap: "var(--s-3)" }}>
              <span style={{ flex: 1 }}>{c.id}</span>
              <span style={PILL}><span class="num">{Object.keys(c.tracks).length}</span> bones</span>
              <span style={PILL}>
                <span class="num">{Object.values(c.tracks).reduce((s, t) => s + t.length, 0)}</span> keys
              </span>
              {libraryHasMatching(lib, c.id, sk.id) && (
                <span style={{ ...PILL, color: "var(--ember-hi)", borderColor: "var(--ember-deep)" }}>
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
