/// <reference lib="dom" />
/**
 * Right pane — edits the field set behind the current selection.
 *
 * Root: model id (read-only — that's the filename), skeleton binding,
 * voxel/sub-object counts.
 * Voxels: per-material breakdown + a remap control (replace all of
 * material X with material Y).
 * Sub-object: identity (modelId / pool / probability), transform,
 * optional boneId.
 *
 * Every edit calls `onChange(newDef)` with a fresh top-level
 * ModelDefinition; the parent owns "dirty" state and saves on demand.
 */
import type { ModelDefinition, MaterialDef } from "./model_types.ts";
import type { Selection } from "./SceneTree.tsx";

export function Inspector({
  def,
  selection,
  materials,
  onChange,
}: {
  def: ModelDefinition | null;
  selection: Selection;
  materials: Map<number, MaterialDef>;
  onChange: (next: ModelDefinition) => void;
}) {
  if (!def) return null;

  if (selection === null) {
    return <RootInspector def={def} onChange={onChange} />;
  }
  if (selection.kind === "voxels") {
    return <VoxelsInspector def={def} materials={materials} onChange={onChange} />;
  }
  if (selection.kind === "sub") {
    return <SubInspector def={def} index={selection.index} onChange={onChange} />;
  }
  return null;
}

// ---- root ------------------------------------------------------------------

function RootInspector({ def, onChange }: { def: ModelDefinition; onChange: (d: ModelDefinition) => void }) {
  return (
    <Box title="Model">
      <Field label="id">
        <div style={readOnlyStyle}>{def.id}</div>
      </Field>
      <Field label="version">
        <NumberInput value={def.version} onChange={(v) => onChange({ ...def, version: v })} />
      </Field>
      <Field label="skeletonId">
        <TextInput
          value={def.skeletonId ?? ""}
          placeholder="(none)"
          onChange={(v) => onChange({ ...def, skeletonId: v || undefined })}
        />
      </Field>
      <Field label="voxels"><div style={readOnlyStyle}>{def.nodes.length}</div></Field>
      <Field label="sub-objects"><div style={readOnlyStyle}>{def.subObjects.length}</div></Field>
      <Field label="materials used"><div style={readOnlyStyle}>{def.materials.join(", ") || "(none)"}</div></Field>
    </Box>
  );
}

// ---- voxels ----------------------------------------------------------------

function VoxelsInspector({
  def, materials, onChange,
}: {
  def: ModelDefinition;
  materials: Map<number, MaterialDef>;
  onChange: (d: ModelDefinition) => void;
}) {
  // Group voxels by material to surface counts + a remap option.
  const counts = new Map<number, number>();
  for (const n of def.nodes) counts.set(n.materialId, (counts.get(n.materialId) ?? 0) + 1);
  const rows = [...counts.entries()].sort(([, a], [, b]) => b - a);

  const remap = (from: number, to: number) => {
    if (from === to || isNaN(to)) return;
    onChange({
      ...def,
      nodes: def.nodes.map((n) => n.materialId === from ? { ...n, materialId: to } : n),
      materials: collectMaterials(def.nodes.map((n) => n.materialId === from ? to : n.materialId)),
    });
  };

  return (
    <Box title="Voxels">
      <div style={{ fontSize: 11, color: "var(--bone-dim)", marginBottom: 6 }}>
        {def.nodes.length} cells across {rows.length} material{rows.length === 1 ? "" : "s"}
      </div>
      <div style={{
        display: "grid",
        gridTemplateColumns: "16px 1fr auto auto",
        gap: "4px 6px",
        alignItems: "center",
      }}>
        {rows.map(([id, count]) => {
          const m = materials.get(id);
          return (
            <>
              <div style={{
                width: 14, height: 14,
                background: `#${(m?.color ?? 0x888888).toString(16).padStart(6, "0")}`,
                border: "1px solid var(--line-strong)",
                borderRadius: 0,
              }} />
              <div style={{ color: "var(--bone)", fontSize: 11 }}>
                {m?.name ?? "?"} <span style={{ color: "var(--bone-faint)" }}>(id {id})</span>
              </div>
              <div style={{ color: "var(--bone-dim)", fontSize: 11 }}>{count}</div>
              <RemapButton current={id} materials={materials} onRemap={(to) => remap(id, to)} />
            </>
          );
        })}
      </div>
      <div style={{ color: "var(--bone-faint)", marginTop: 10, fontSize: 11, fontStyle: "italic" }}>
        Interactive voxel painting + add/remove arrives in T-191b v2.
      </div>
    </Box>
  );
}

function RemapButton({ current, materials, onRemap }: {
  current: number;
  materials: Map<number, MaterialDef>;
  onRemap: (to: number) => void;
}) {
  return (
    <select
      value={current}
      onChange={(e) => onRemap(parseInt((e.target as HTMLSelectElement).value, 10))}
      style={selectStyle}
    >
      {[...materials.values()]
        .sort((a, b) => a.id - b.id)
        .map((m) => <option value={m.id}>{m.name}</option>)}
    </select>
  );
}

// ---- sub-object ------------------------------------------------------------

function SubInspector({ def, index, onChange }: {
  def: ModelDefinition;
  index: number;
  onChange: (d: ModelDefinition) => void;
}) {
  const sub = def.subObjects[index];
  if (!sub) return null;

  const update = (patch: Partial<typeof sub>) => {
    const next = { ...def, subObjects: def.subObjects.map((s, i) => i === index ? { ...s, ...patch } : s) };
    onChange(next);
  };

  const updateTransform = (patch: Partial<typeof sub.transform>) => {
    update({ transform: { ...sub.transform, ...patch } });
  };

  const remove = () => {
    onChange({ ...def, subObjects: def.subObjects.filter((_, i) => i !== index) });
  };

  return (
    <Box title={`Sub-object [${index}]`}>
      <Field label="modelId">
        <TextInput
          value={sub.modelId ?? ""}
          placeholder="(unset — uses pool)"
          onChange={(v) => update({ modelId: v || undefined })}
        />
      </Field>
      <Field label="pool">
        <TextInput
          value={(sub.pool ?? []).join(", ")}
          placeholder="(empty)"
          onChange={(v) => update({ pool: v ? v.split(",").map((s) => s.trim()).filter(Boolean) : undefined })}
        />
      </Field>
      <Field label="probability">
        <NumberInput value={sub.probability ?? 1} step={0.05} onChange={(v) => update({ probability: v === 1 ? undefined : v })} />
      </Field>
      <Field label="boneId">
        <TextInput
          value={sub.boneId ?? ""}
          placeholder="(none)"
          onChange={(v) => update({ boneId: v || undefined })}
        />
      </Field>
      <Field label="materialSlot">
        <TextInput
          value={sub.materialSlot ?? ""}
          placeholder="(none)"
          onChange={(v) => update({ materialSlot: v || undefined })}
        />
      </Field>

      <div style={{ marginTop: 10, color: "var(--bone-dim)", fontSize: 11, fontWeight: 600 }}>Transform</div>
      <Vec3Field label="position" v={[sub.transform.x, sub.transform.y, sub.transform.z]}
        onChange={([x, y, z]) => updateTransform({ x, y, z })} />
      <Vec3Field label="rotation (rad)" v={[sub.transform.rotX, sub.transform.rotY, sub.transform.rotZ]}
        onChange={([rotX, rotY, rotZ]) => updateTransform({ rotX, rotY, rotZ })} step={0.05} />
      <Vec3Field label="scale" v={[sub.transform.scaleX, sub.transform.scaleY, sub.transform.scaleZ]}
        onChange={([scaleX, scaleY, scaleZ]) => updateTransform({ scaleX, scaleY, scaleZ })} step={0.05} />

      <button onClick={remove} style={{
        marginTop: 14, padding: "5px 10px", background: "var(--rot-deep)", color: "var(--bone-hi)",
        border: "1px solid var(--rot)", borderRadius: 0, cursor: "pointer", fontSize: 11,
      }}>Remove sub-object</button>
    </Box>
  );
}

// ---- field primitives ------------------------------------------------------

function Box({ title, children }: { title: string; children: preact.ComponentChildren }) {
  return (
    <div style={{ padding: 12 }}>
      <div style={{ color: "var(--aether-hi)", fontSize: 12, fontWeight: 600, marginBottom: 8 }}>{title}</div>
      {children}
    </div>
  );
}

function Field({ label, children }: { label: string; children: preact.ComponentChildren }) {
  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: "90px 1fr",
      gap: 6,
      alignItems: "center",
      marginBottom: 4,
    }}>
      <div style={{ color: "var(--bone-dim)", fontSize: 11 }}>{label}</div>
      {children}
    </div>
  );
}

function Vec3Field({ label, v, onChange, step }: {
  label: string;
  v: [number, number, number];
  onChange: (next: [number, number, number]) => void;
  step?: number;
}) {
  return (
    <div style={{ marginTop: 6 }}>
      <div style={{ color: "var(--bone-dim)", fontSize: 11, marginBottom: 3 }}>{label}</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 4 }}>
        <NumberInput value={v[0]} step={step} onChange={(x) => onChange([x, v[1], v[2]])} />
        <NumberInput value={v[1]} step={step} onChange={(y) => onChange([v[0], y, v[2]])} />
        <NumberInput value={v[2]} step={step} onChange={(z) => onChange([v[0], v[1], z])} />
      </div>
    </div>
  );
}

const inputStyle = {
  background: "var(--bog)",
  border: "1px solid var(--line-strong)",
  color: "var(--bone)",
  borderRadius: 0,
  padding: "3px 6px",
  fontSize: 11,
  fontFamily: "inherit",
  width: "100%",
  outline: "none",
} as const;

const readOnlyStyle = {
  color: "var(--bone-dim)",
  fontSize: 11,
  padding: "3px 0",
} as const;

const selectStyle = {
  ...inputStyle,
  maxWidth: 110,
} as const;

function TextInput({ value, placeholder, onChange }: {
  value: string; placeholder?: string; onChange: (v: string) => void;
}) {
  return (
    <input
      type="text"
      value={value}
      placeholder={placeholder}
      onInput={(e) => onChange((e.target as HTMLInputElement).value)}
      style={inputStyle}
    />
  );
}

function NumberInput({ value, step, onChange }: {
  value: number; step?: number; onChange: (v: number) => void;
}) {
  return (
    <input
      type="number"
      value={value}
      step={step ?? 1}
      onInput={(e) => {
        const v = parseFloat((e.target as HTMLInputElement).value);
        if (!isNaN(v)) onChange(v);
      }}
      style={inputStyle}
    />
  );
}

function collectMaterials(ids: number[]): number[] {
  return [...new Set(ids)].sort((a, b) => a - b);
}
