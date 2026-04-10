/**
 * Selection panel — shows properties of whatever is currently selected.
 *
 * Selected voxel  → material picker (change via activeMaterial + repaint)
 * Selected subobj → transform/scale/rotation editor + model picker
 */
import type { MaterialDef, SkeletonDef } from "@voxim/content";
import {
  selectedVoxelKey, selectedSubObject,
  voxels, activeMaterial, subObjects,
  updateSubObjectTransform, updateSubObject,
  voxelKey, parseKey, pushUndo,
  type VoxelPatch,
} from "../state.ts";

const INPUT: preact.JSX.CSSProperties = {
  background: "#2a2a2a", border: "1px solid #444", color: "#ddd",
  fontFamily: "monospace", fontSize: 11, padding: "2px 4px", borderRadius: 2, width: "100%",
};
const NUM: preact.JSX.CSSProperties = { ...INPUT, width: "100%" };
const LABEL: preact.JSX.CSSProperties = { color: "#555", fontSize: 10, marginBottom: 1 };

interface Props {
  materials: MaterialDef[];
  modelIds: readonly string[];
  skeletons: SkeletonDef[];
}

function hexColor(n: number): string {
  return `#${n.toString(16).padStart(6, "0")}`;
}

function VoxelSelection({ materials }: { materials: MaterialDef[] }) {
  const key = selectedVoxelKey.value!;
  const currentMatId = voxels.value.get(key);

  function repaint(newMatId: number) {
    const current = voxels.value;
    const before = current.get(key) ?? null;
    if (before === newMatId) return;
    const patch: VoxelPatch = new Map([[key, before]]);
    const next = new Map(current);
    next.set(key, newMatId);
    voxels.value = next;
    pushUndo(patch);
  }

  const [x, y, z] = parseKey(key);

  return (
    <div style={{ padding: 8 }}>
      <div style={{ fontSize: 11, color: "#888", fontWeight: "bold", marginBottom: 6 }}>VOXEL ({x},{y},{z})</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 3 }}>
        {materials.map((m) => (
          <div
            key={m.id}
            title={m.name}
            onClick={() => repaint(m.id)}
            style={{
              width: 20, height: 20, borderRadius: 2, cursor: "pointer",
              background: hexColor(m.color),
              border: currentMatId === m.id ? "2px solid #fff" : "2px solid transparent",
              flexShrink: 0,
            }}
          />
        ))}
      </div>
    </div>
  );
}

function SubObjectSelection({ modelIds, skeletons }: { modelIds: readonly string[]; skeletons: SkeletonDef[] }) {
  const idx = selectedSubObject.value!;
  const sub = subObjects.value[idx];
  if (!sub) return null;

  const boneIds = sub.boneId !== undefined
    ? (skeletons.flatMap((s) => s.bones.map((b) => b.id)))
    : [];

  const isPool = !!(sub.pool && sub.pool.length > 0);

  return (
    <div style={{ padding: 8 }}>
      <div style={{ fontSize: 11, color: "#888", fontWeight: "bold", marginBottom: 6 }}>
        SUBOBJECT #{idx} — {isPool ? `pool[${sub.pool!.length}]` : (sub.modelId || "—")}
      </div>

      {/* Model picker */}
      <div style={LABEL}>Model</div>
      <select style={{ ...INPUT, marginBottom: 6 }}
        value={sub.modelId ?? ""}
        onChange={(e) => updateSubObject(idx, { modelId: (e.target as HTMLSelectElement).value, pool: undefined })}>
        <option value="">— none —</option>
        {modelIds.map((id) => <option key={id} value={id}>{id}</option>)}
      </select>

      {/* Position */}
      <div style={{ fontSize: 10, color: "#666", marginBottom: 4 }}>Position</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 3, marginBottom: 6 }}>
        {(["x", "y", "z"] as const).map((k) => (
          <label key={k} style={{ display: "flex", flexDirection: "column", gap: 1 }}>
            <span style={LABEL}>{k}</span>
            <input type="number" step={1} style={NUM}
              value={sub.transform[k]}
              onInput={(e) => updateSubObjectTransform(idx, k, parseFloat((e.target as HTMLInputElement).value) || 0)}
            />
          </label>
        ))}
      </div>

      {/* Rotation */}
      <div style={{ fontSize: 10, color: "#666", marginBottom: 4 }}>Rotation (deg)</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 3, marginBottom: 6 }}>
        {(["rotX", "rotY", "rotZ"] as const).map((k) => (
          <label key={k} style={{ display: "flex", flexDirection: "column", gap: 1 }}>
            <span style={LABEL}>{k.slice(3)}</span>
            <input type="number" step={5} style={NUM}
              value={sub.transform[k]}
              onInput={(e) => updateSubObjectTransform(idx, k, parseFloat((e.target as HTMLInputElement).value) || 0)}
            />
          </label>
        ))}
      </div>

      {/* Scale */}
      <div style={{ fontSize: 10, color: "#666", marginBottom: 4 }}>Scale</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 3, marginBottom: 6 }}>
        {(["scaleX", "scaleY", "scaleZ"] as const).map((k) => (
          <label key={k} style={{ display: "flex", flexDirection: "column", gap: 1 }}>
            <span style={LABEL}>{k.slice(5)}</span>
            <input type="number" step={0.1} min={0.01} style={NUM}
              value={sub.transform[k]}
              onInput={(e) => updateSubObjectTransform(idx, k, parseFloat((e.target as HTMLInputElement).value) || 1)}
            />
          </label>
        ))}
      </div>

      {/* Bone attachment */}
      <div style={LABEL}>Bone</div>
      <select style={{ ...INPUT, marginBottom: 4 }}
        value={sub.boneId ?? ""}
        onChange={(e) => updateSubObject(idx, { boneId: (e.target as HTMLSelectElement).value || undefined })}>
        <option value="">— none —</option>
        {boneIds.map((b) => <option key={b} value={b}>{b}</option>)}
      </select>

      {/* hitbox flag */}
      <label style={{ display: "flex", gap: 6, alignItems: "center", color: "#aaa", fontSize: 11 }}>
        <input type="checkbox" checked={sub.hitbox !== false}
          onChange={(e) => updateSubObject(idx, { hitbox: (e.target as HTMLInputElement).checked ? undefined : false as const })}
        />
        Include in hitbox
      </label>
    </div>
  );
}

export function SelectionPanel({ materials, modelIds, skeletons }: Props) {
  const voxSel = selectedVoxelKey.value;
  const subSel = selectedSubObject.value;

  if (voxSel !== null) {
    return (
      <div style={{ borderTop: "1px solid #333", background: "#1a2a1a" }}>
        <VoxelSelection materials={materials} />
      </div>
    );
  }

  if (subSel !== null) {
    return (
      <div style={{ borderTop: "1px solid #333", background: "#1a1a2a" }}>
        <SubObjectSelection modelIds={modelIds} skeletons={skeletons} />
      </div>
    );
  }

  return null;
}
