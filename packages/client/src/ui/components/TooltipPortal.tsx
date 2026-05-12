/// <reference lib="dom" />
/**
 * Item tooltip — renders the per-instance stats and provenance of whatever
 * item the cursor is over. Procedural display name is built from
 * provenance: the first role's variant becomes a prefix, the base prefab id
 * becomes the noun. "Yew Wooden Bow" rather than "wooden_bow".
 *
 * Visual recipe (see data/design/README.md): opaque, hairline-bordered
 * pressed-metal surface; Spectral display for the name, IBM Plex Mono for
 * stats; flavour text is italic Spectral if present.
 */
import { computed } from "@preact/signals";
import { uiState } from "../ui_store.ts";

const tooltip = computed(() => uiState.value.tooltip);

function humanize(id: string): string {
  if (!id) return "";
  return id.split("_").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

function variantAdjective(prefabId: string): string {
  const lower = prefabId.toLowerCase();
  for (const suffix of ["_wood", "_yarn", "_cord", "_ingot", "_cloth", "_leather", "_hide", "_stone"]) {
    if (lower.endsWith(suffix)) return humanize(lower.slice(0, -suffix.length));
  }
  return humanize(lower);
}

function proceduralName(itemType: string, provenance: ReadonlyArray<{ role: string; prefabId: string }> | undefined): string {
  if (!provenance || provenance.length === 0) return humanize(itemType);
  const adj = variantAdjective(provenance[0].prefabId);
  const base = humanize(itemType);
  return adj ? `${adj} ${base}` : base;
}

export function TooltipPortal() {
  const t = tooltip.value;
  if (!t) return null;

  const name  = proceduralName(t.item.itemType, t.provenance);
  const stats = t.stats ? Object.entries(t.stats) : [];

  return (
    <div
      class="tooltip"
      style={{
        left: `${t.screenX + 14}px`,
        top:  `${t.screenY}px`,
      }}
    >
      <div class="name">{name}</div>
      <div class="kind">
        {t.item.itemType}{t.item.quantity > 1 ? ` · ×${t.item.quantity}` : ""}
      </div>

      {stats.length > 0 && (
        <div class="stats">
          {stats.flatMap(([k, v]) => [
            <div class="key" key={`k-${k}`}>{humanize(k)}</div>,
            <div class="val" key={`v-${k}`}>{Number.isFinite(v) ? v.toFixed(2) : "—"}</div>,
          ])}
        </div>
      )}

      {t.provenance && t.provenance.length > 0 && (
        <div style={{
          marginTop: "var(--s-3)",
          paddingTop: "var(--s-2)",
          borderTop: "1px solid var(--line)",
          fontFamily: "var(--font-mono)",
          fontSize: "var(--fs-eyebrow)",
          color: "var(--bone-faint)",
        }}>
          {t.provenance.map((p) => (
            <div key={p.role}>
              {humanize(p.role)}: <span style={{ color: "var(--bone-dim)" }}>{humanize(p.prefabId)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
