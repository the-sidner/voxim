/** Model metadata editor: id, version, skeletonId. Hitbox is derived — not authored here. */
import type { SkeletonDef } from "@voxim/content";
import { modelId, modelVersion, skeletonId } from "../state.ts";

interface Props { skeletons: SkeletonDef[]; }

function Field({ label, children }: { label: string; children: preact.ComponentChildren }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <span class="eyebrow">{label}</span>
      {children}
    </label>
  );
}

export function ModelPanel({ skeletons }: Props) {
  return (
    <div class="dt-section">
      <div class="dt-section-header">Model</div>

      <Field label="ID">
        <input value={modelId.value}
          onInput={(e) => { modelId.value = (e.target as HTMLInputElement).value; }} />
      </Field>

      <Field label="Version">
        <input type="number" style={{ width: 64 }} value={modelVersion.value}
          onInput={(e) => { modelVersion.value = parseInt((e.target as HTMLInputElement).value) || 1; }} />
      </Field>

      <Field label="Skeleton">
        <select
          value={skeletonId.value ?? ""}
          onChange={(e) => { skeletonId.value = (e.target as HTMLSelectElement).value || null; }}>
          <option value="">— none —</option>
          {skeletons.map((s) => <option key={s.id} value={s.id}>{s.id}</option>)}
        </select>
      </Field>
    </div>
  );
}
