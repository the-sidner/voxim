/// <reference lib="dom" />
/**
 * Scene tree — left pane in the voxel editor. Surface the structure
 * of a ModelDefinition: voxel block (collapsed by count to keep the
 * tree compact), sub-objects (one row per).
 *
 * Selection identifies what the inspector edits. `null` = root model;
 * `{ kind: "voxels" }` = the voxel block as a group; `{ kind: "sub",
 * index }` = a specific sub-object.
 */
import type { ModelDefinition } from "./model_types.ts";

export type Selection =
  | null
  | { kind: "voxels" }
  | { kind: "sub"; index: number };

export function SceneTree({
  def,
  selection,
  onSelect,
}: {
  def: ModelDefinition | null;
  selection: Selection;
  onSelect: (s: Selection) => void;
}) {
  if (!def) {
    return (
      <div style={{ padding: 12, color: "#888", fontSize: 12 }}>
        Pick a model file from the asset browser to start editing.
      </div>
    );
  }

  return (
    <div style={{ fontSize: 12, padding: "8px 4px" }}>
      <Row
        label={def.id}
        hint={def.skeletonId ? `skel: ${def.skeletonId}` : undefined}
        depth={0}
        selected={selection === null}
        onClick={() => onSelect(null)}
        bold
      />
      <Row
        label={`Voxels (${def.nodes.length})`}
        hint={`${def.materials.length} material${def.materials.length === 1 ? "" : "s"}`}
        depth={1}
        selected={selection?.kind === "voxels"}
        onClick={() => onSelect({ kind: "voxels" })}
      />
      <Row
        label={`Sub-objects (${def.subObjects.length})`}
        depth={1}
        selected={false}
        onClick={() => {}}
        dim
      />
      {def.subObjects.map((sub, i) => {
        const subId = sub.modelId ?? sub.pool?.[0] ?? "(unset)";
        return (
          <Row
            key={i}
            label={subId}
            hint={sub.boneId ? `→ ${sub.boneId}` : undefined}
            depth={2}
            selected={selection?.kind === "sub" && selection.index === i}
            onClick={() => onSelect({ kind: "sub", index: i })}
          />
        );
      })}
    </div>
  );
}

function Row({
  label, hint, depth, selected, onClick, bold, dim,
}: {
  label: string;
  hint?: string;
  depth: number;
  selected: boolean;
  onClick: () => void;
  bold?: boolean;
  dim?: boolean;
}) {
  return (
    <div
      onClick={onClick}
      style={{
        cursor: "pointer",
        paddingLeft: `${depth * 14 + 6}px`,
        paddingTop: 2,
        paddingBottom: 2,
        background: selected ? "#2a3a55" : undefined,
        color: dim ? "#7a7a82" : (selected ? "#fff" : "#cfd0e0"),
        fontWeight: bold ? 600 : 400,
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
      }}
      onMouseOver={(e) => { if (!selected && !dim) (e.currentTarget as HTMLElement).style.background = "#26262c"; }}
      onMouseOut={(e)  => { if (!selected) (e.currentTarget as HTMLElement).style.background = ""; }}
    >
      <span style={{
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
      }}>{label}</span>
      {hint && (
        <span style={{ color: "#7a7a82", fontSize: 11, marginLeft: 8, flexShrink: 0 }}>{hint}</span>
      )}
    </div>
  );
}
