/**
 * Data tree — hierarchical browser of skeletons, models, prefabs, weapon
 * actions and the animation library.
 *
 * Tree nodes click → set `selectedTreeNode`.  The Inspect panel reads that
 * to decide what to show in the right-side details panel and also auto-
 * applies relevant selections to the preview scene (e.g. clicking a prefab
 * sets it as the previewed entity; clicking a clip plays it as locomotion
 * if the prefab's slot map points at it).
 */
import type { SkeletonDef, ModelDefinition, Prefab, WeaponActionDef, LibraryClipFile } from "@voxim/content";
import type { BrowserContentStore } from "../../content_loader.ts";
import { selectedTreeNode, expandedTreeNodes, previewPrefabId } from "../inspect_state.ts";
import { libraryClips } from "../lib_state.ts";

interface Props { content: BrowserContentStore; }

const ROW: preact.JSX.CSSProperties = {
  padding: "1px 4px", cursor: "pointer", whiteSpace: "nowrap",
  fontSize: 11, fontFamily: "monospace", lineHeight: "16px",
  userSelect: "none",
};

const PILL_BLUE: preact.JSX.CSSProperties = {
  marginLeft: 6, padding: "0 5px", background: "#234", color: "#9bd",
  borderRadius: 7, fontSize: 9,
};
const PILL_GREEN: preact.JSX.CSSProperties = {
  ...PILL_BLUE, background: "#243", color: "#9d9",
};
const PILL_AMBER: preact.JSX.CSSProperties = {
  ...PILL_BLUE, background: "#432", color: "#dc8",
};

export function DataTree({ content }: Props) {
  const expanded = expandedTreeNodes.value;
  const selected = selectedTreeNode.value;

  const skeletons: SkeletonDef[] = collectSkeletons(content);
  const models: ModelDefinition[] = (content.allModelIds ?? [])
    .map((id) => content.models.get(id))
    .filter(Boolean) as ModelDefinition[];
  const prefabs: Prefab[] = content.prefabs.values();
  const weaponActions: WeaponActionDef[] = collectWeaponActions(content);

  // Group prefabs by which skeleton they end up using (via modelId → skeletonId)
  // so the Browser shows e.g. all prefabs that play on the human skeleton in
  // one cluster — the most useful filter when picking what to preview.
  const prefabsBySkeleton = new Map<string, Prefab[]>();
  const prefabsNoSkeleton: Prefab[] = [];
  for (const p of prefabs) {
    const skId = p.modelId ? content.models.get(p.modelId)?.skeletonId : undefined;
    if (skId) {
      if (!prefabsBySkeleton.has(skId)) prefabsBySkeleton.set(skId, []);
      prefabsBySkeleton.get(skId)!.push(p);
    } else {
      prefabsNoSkeleton.push(p);
    }
  }
  for (const arr of prefabsBySkeleton.values()) arr.sort((a, b) => a.id.localeCompare(b.id));
  prefabsNoSkeleton.sort((a, b) => a.id.localeCompare(b.id));

  // Same grouping for models — most "model_arrow" / "model_sword_basic" have
  // no skeleton and end up in the misc bucket.
  const modelsBySkeleton = new Map<string, ModelDefinition[]>();
  const modelsNoSkeleton: ModelDefinition[] = [];
  for (const m of models) {
    if (m.skeletonId) {
      if (!modelsBySkeleton.has(m.skeletonId)) modelsBySkeleton.set(m.skeletonId, []);
      modelsBySkeleton.get(m.skeletonId)!.push(m);
    } else {
      modelsNoSkeleton.push(m);
    }
  }
  for (const arr of modelsBySkeleton.values()) arr.sort((a, b) => a.id.localeCompare(b.id));
  modelsNoSkeleton.sort((a, b) => a.id.localeCompare(b.id));

  function toggle(id: string) {
    const next = new Set(expanded);
    next.has(id) ? next.delete(id) : next.add(id);
    expandedTreeNodes.value = next;
  }
  function select(id: string) { selectedTreeNode.value = id; }

  const isOpen = (id: string) => expanded.has(id);
  const isSel  = (id: string) => selected === id;

  function row(id: string, label: string, opts: {
    indent?: number; onClick?: () => void; expandable?: boolean; pill?: preact.JSX.Element;
  } = {}) {
    const indent = opts.indent ?? 0;
    return (
      <div
        style={{
          ...ROW,
          paddingLeft: 4 + indent * 14,
          background: isSel(id) ? "#2c4a6c" : "transparent",
          color: isSel(id) ? "#cde" : "#bbb",
        }}
        onClick={() => { opts.onClick?.(); select(id); }}
      >
        {opts.expandable !== undefined && (
          <span
            onClick={(e) => { e.stopPropagation(); toggle(id); }}
            style={{ display: "inline-block", width: 12, color: "#666" }}
          >{isOpen(id) ? "▾" : "▸"}</span>
        )}
        <span>{label}</span>
        {opts.pill}
      </div>
    );
  }

  return (
    <div style={{
      width: 240, flexShrink: 0, height: "100%", overflowY: "auto",
      background: "#181818", borderRight: "1px solid #2a2a2a",
    }}>
      {/* ── Skeletons ── */}
      {row("section:skeletons", `Skeletons (${skeletons.length})`, {
        expandable: true,
        pill: <span style={PILL_BLUE}>{skeletons.length}</span>,
      })}
      {isOpen("section:skeletons") && skeletons.map((sk) => (
        <SkeletonNode
          key={sk.id} skeleton={sk}
          isOpen={isOpen} isSel={isSel} toggle={toggle} select={select} row={row}
          libClips={libraryClips.value.filter((c) => c._skeleton === sk.id)}
        />
      ))}

      {/* ── Prefabs ── */}
      {row("section:prefabs", `Prefabs (${prefabs.length})`, {
        expandable: true,
        pill: <span style={PILL_GREEN}>{prefabs.length}</span>,
      })}
      {isOpen("section:prefabs") && (
        <>
          {[...prefabsBySkeleton].map(([skId, list]) => {
            const groupId = `section:prefabs:sk:${skId}`;
            return (
              <>
                {row(groupId, `${skId} (${list.length})`, { expandable: true, indent: 1 })}
                {isOpen(groupId) && list.map((p) => row(`prefab:${p.id}`, p.id, {
                  indent: 2,
                  onClick: () => previewPrefabId.value = p.id,
                  pill: p.animationSlots && Object.keys(p.animationSlots).length > 0
                    ? <span style={PILL_GREEN}>slots</span>
                    : undefined,
                }))}
              </>
            );
          })}
          {prefabsNoSkeleton.length > 0 && row("section:prefabs:no-sk",
            `(no skeleton) (${prefabsNoSkeleton.length})`,
            { expandable: true, indent: 1 })}
          {isOpen("section:prefabs:no-sk") && prefabsNoSkeleton.map((p) =>
            row(`prefab:${p.id}`, p.id, { indent: 2 }),
          )}
        </>
      )}

      {/* ── Models ── */}
      {row("section:models", `Models (${models.length})`, {
        expandable: true,
        pill: <span style={PILL_BLUE}>{models.length}</span>,
      })}
      {isOpen("section:models") && (
        <>
          {[...modelsBySkeleton].map(([skId, list]) => {
            const groupId = `section:models:sk:${skId}`;
            return (
              <>
                {row(groupId, `${skId} (${list.length})`, { expandable: true, indent: 1 })}
                {isOpen(groupId) && list.map((m) => row(`model:${m.id}`, m.id, { indent: 2 }))}
              </>
            );
          })}
          {modelsNoSkeleton.length > 0 && row("section:models:no-sk",
            `(no skeleton) (${modelsNoSkeleton.length})`,
            { expandable: true, indent: 1 })}
          {isOpen("section:models:no-sk") && modelsNoSkeleton.map((m) =>
            row(`model:${m.id}`, m.id, { indent: 2 }),
          )}
        </>
      )}

      {/* ── Weapon actions ── */}
      {row("section:weaponActions", `Weapon actions (${weaponActions.length})`, {
        expandable: true,
        pill: <span style={PILL_AMBER}>{weaponActions.length}</span>,
      })}
      {isOpen("section:weaponActions") && weaponActions.map((wa) =>
        row(`weapon-action:${wa.id}`, wa.id, { indent: 1 }),
      )}

      {/* ── Library (cross-cutting) ── */}
      {row("section:library", `Library (${libraryClips.value.length})`, {
        expandable: true,
        pill: <span style={PILL_AMBER}>{libraryClips.value.length}</span>,
      })}
      {isOpen("section:library") && libraryClips.value.map((c: LibraryClipFile) =>
        row(`library-clip:${c.id}`, c.id, { indent: 1,
          pill: "_kind" in c
            ? <span style={PILL_AMBER}>{c._kind}</span>
            : <span style={PILL_BLUE}>{c._skeleton}</span>,
        }),
      )}
    </div>
  );
}

function SkeletonNode({ skeleton, isOpen, isSel, toggle, select, row, libClips }: {
  skeleton: SkeletonDef;
  isOpen: (id: string) => boolean;
  isSel: (id: string) => boolean;
  toggle: (id: string) => void;
  select: (id: string) => void;
  row: (id: string, label: string, opts?: {
    indent?: number; onClick?: () => void; expandable?: boolean; pill?: preact.JSX.Element;
  }) => preact.JSX.Element;
  libClips: LibraryClipFile[];
}) {
  const id = `skeleton:${skeleton.id}`;
  const clipsId = `${id}:clips`;
  const bonesId = `${id}:bones`;
  const libIdsSet = new Set(libClips.filter((c) => !("_kind" in c)).map((c) => c.id));
  return (
    <>
      {row(id, skeleton.id, {
        indent: 1, expandable: true,
        pill: <span style={PILL_BLUE}>{skeleton.bones.length} bones</span>,
      })}
      {isOpen(id) && (
        <>
          {row(clipsId, `Clips (${(skeleton.clips ?? []).length})`, {
            indent: 2, expandable: true,
          })}
          {isOpen(clipsId) && (skeleton.clips ?? []).map((c) =>
            row(`skel-clip:${skeleton.id}:${c.id}`, c.id, {
              indent: 3,
              pill: libIdsSet.has(c.id)
                ? <span style={PILL_AMBER}>library</span>
                : undefined,
            }),
          )}
          {row(bonesId, `Bones (${skeleton.bones.length})`, {
            indent: 2, expandable: true,
          })}
          {isOpen(bonesId) && skeleton.bones.map((b) =>
            row(`skel-bone:${skeleton.id}:${b.id}`, b.id, { indent: 3 }),
          )}
        </>
      )}
    </>
  );
}

function collectSkeletons(content: BrowserContentStore): SkeletonDef[] {
  const ids = new Set<string>();
  for (const id of content.allModelIds ?? []) {
    const m = content.models.get(id);
    if (m?.skeletonId) ids.add(m.skeletonId);
  }
  return [...ids].sort()
    .map((id) => content.skeletons.get(id))
    .filter(Boolean) as SkeletonDef[];
}

function collectWeaponActions(content: BrowserContentStore): WeaponActionDef[] {
  // ContentService exposes per-id getters but not a list — derive by walking
  // the prefabs and union-ing every action id referenced in `swingable.chain`
  // (both light and heavy variants).
  const ids = new Set<string>();
  for (const p of content.prefabs.values()) {
    const sw = (p.components as Record<string, unknown>)?.swingable as
      { chain?: { light: string; heavy: string }[] } | undefined;
    for (const c of sw?.chain ?? []) {
      ids.add(c.light);
      ids.add(c.heavy);
    }
  }
  return [...ids].sort()
    .map((id) => content.weaponActions.get(id))
    .filter(Boolean) as WeaponActionDef[];
}
