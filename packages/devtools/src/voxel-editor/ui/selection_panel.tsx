/**
 * Selection panel — shows properties of whatever is currently selected.
 *
 * Selected voxel  → material picker (change via activeMaterial + repaint)
 * Selected subobj → transform/scale/rotation editor + model picker
 */
import type { MaterialDef, SkeletonDef } from "@voxim/content";
import {
  selectedVoxelKey, selectedSubObject,
  voxels, subObjects,
  updateSubObjectTransform, updateSubObject,
  parseKey, pushUndo,
  type VoxelPatch,
} from "../state.ts";

interface Props {
  materials: MaterialDef[];
  modelIds: readonly string[];
  skeletons: SkeletonDef[];
}

function hexColor(n: number): string {
  return `#${n.toString(16).padStart(6, "0")}`;
}

function Field({ label, children }: { label: string; children: preact.ComponentChildren }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 1 }}>
      <span class="eyebrow">{label}</span>
      {children}
    </label>
  );
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
    <div class="dt-section">
      <div class="dt-section-header">
        Voxel <span class="num text-dim">({x},{y},{z})</span>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 3 }}>
        {materials.map((m) => (
          <div
            key={m.id}
            title={m.name}
            onClick={() => repaint(m.id)}
            style={{
              width: 20, height: 20, cursor: "pointer",
              background: hexColor(m.color),
              border: currentMatId === m.id ? "2px solid var(--ember)" : "2px solid var(--line)",
              boxShadow: currentMatId === m.id ? "0 0 6px var(--ember-glow)" : "none",
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
    <div class="dt-section">
      <div class="dt-section-header">
        <span>SubObject #{idx}</span>
        <span class="text-dim">{isPool ? `pool[${sub.pool!.length}]` : (sub.modelId || "—")}</span>
      </div>

      <Field label="Model">
        <select
          value={sub.modelId ?? ""}
          onChange={(e) => updateSubObject(idx, { modelId: (e.target as HTMLSelectElement).value, pool: undefined })}>
          <option value="">— none —</option>
          {modelIds.map((id) => <option key={id} value={id}>{id}</option>)}
        </select>
      </Field>

      <span class="eyebrow">Position</span>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 3 }}>
        {(["x", "y", "z"] as const).map((k) => (
          <Field key={k} label={k}>
            <input type="number" step={1}
              value={sub.transform[k]}
              onInput={(e) => updateSubObjectTransform(idx, k, parseFloat((e.target as HTMLInputElement).value) || 0)}
            />
          </Field>
        ))}
      </div>

      <span class="eyebrow">Rotation (deg)</span>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 3 }}>
        {(["rotX", "rotY", "rotZ"] as const).map((k) => (
          <Field key={k} label={k.slice(3)}>
            <input type="number" step={5}
              value={sub.transform[k]}
              onInput={(e) => updateSubObjectTransform(idx, k, parseFloat((e.target as HTMLInputElement).value) || 0)}
            />
          </Field>
        ))}
      </div>

      <span class="eyebrow">Scale</span>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 3 }}>
        {(["scaleX", "scaleY", "scaleZ"] as const).map((k) => (
          <Field key={k} label={k.slice(5)}>
            <input type="number" step={0.1} min={0.01}
              value={sub.transform[k]}
              onInput={(e) => updateSubObjectTransform(idx, k, parseFloat((e.target as HTMLInputElement).value) || 1)}
            />
          </Field>
        ))}
      </div>

      <Field label="Bone">
        <select
          value={sub.boneId ?? ""}
          onChange={(e) => updateSubObject(idx, { boneId: (e.target as HTMLSelectElement).value || undefined })}>
          <option value="">— none —</option>
          {boneIds.map((b) => <option key={b} value={b}>{b}</option>)}
        </select>
      </Field>

      <label style={{ display: "flex", gap: "var(--s-2)", alignItems: "center", color: "var(--bone-dim)", fontSize: "var(--fs-small)" }}>
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

  if (voxSel !== null) return <VoxelSelection materials={materials} />;
  if (subSel !== null) return <SubObjectSelection modelIds={modelIds} skeletons={skeletons} />;
  return null;
}
