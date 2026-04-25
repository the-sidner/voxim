/// <reference lib="dom" />
/**
 * Item tooltip — renders the per-instance stats and provenance of whatever
 * item the cursor is over. Procedural display name is built from
 * provenance: the first role's variant becomes a prefix, the base prefab id
 * becomes the noun. "Yew Wooden Bow" rather than "wooden_bow".
 */
import { computed } from "@preact/signals";
import { uiState } from "../ui_store.ts";

const tooltip = computed(() => uiState.value.tooltip);

function humanize(id: string): string {
  if (!id) return "";
  return id.split("_").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

/** "yew_wood" → "Yew" — strip a known suffix-noun off variants when used as adjectives. */
function variantAdjective(prefabId: string): string {
  const lower = prefabId.toLowerCase();
  for (const suffix of ["_wood", "_yarn", "_cord", "_ingot", "_cloth", "_leather", "_hide", "_stone"]) {
    if (lower.endsWith(suffix)) return humanize(lower.slice(0, -suffix.length));
  }
  return humanize(lower);
}

function proceduralName(itemType: string, provenance: ReadonlyArray<{ role: string; prefabId: string }> | undefined): string {
  if (!provenance || provenance.length === 0) return humanize(itemType);
  // First-role variant prefixes the base name. "yew_wood" + "wooden_bow" → "Yew Wooden Bow".
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
      class="panel"
      style={{
        position: "fixed",
        left: `${t.screenX + 16}px`,
        top:  `${t.screenY}px`,
        zIndex: "var(--z-tooltip)",
        minWidth: "180px",
        maxWidth: "280px",
        boxShadow: "var(--shadow-tooltip)",
        pointerEvents: "none",
      }}
    >
      <div style={{ fontWeight: "bold", marginBottom: "var(--gap-xs)" }}>
        {name}
      </div>
      <div style={{ fontSize: "var(--text-xs)", color: "var(--col-text-dim)", marginBottom: "var(--gap-xs)" }}>
        {t.item.itemType}{t.item.quantity > 1 ? ` ×${t.item.quantity}` : ""}
      </div>

      {stats.length > 0 && (
        <div style={{ borderTop: "1px solid var(--col-border)", paddingTop: "var(--gap-xs)", marginTop: "var(--gap-xs)" }}>
          {stats.map(([k, v]) => (
            <div key={k} style={{ display: "flex", justifyContent: "space-between", fontSize: "var(--text-xs)" }}>
              <span style={{ color: "var(--col-text-dim)" }}>{humanize(k)}</span>
              <span>{Number.isFinite(v) ? v.toFixed(2) : "—"}</span>
            </div>
          ))}
        </div>
      )}

      {t.provenance && t.provenance.length > 0 && (
        <div style={{ borderTop: "1px solid var(--col-border)", paddingTop: "var(--gap-xs)", marginTop: "var(--gap-xs)", fontSize: "var(--text-xs)", color: "var(--col-text-dim)" }}>
          {t.provenance.map((p) => (
            <div key={p.role}>{humanize(p.role)}: {humanize(p.prefabId)}</div>
          ))}
        </div>
      )}
    </div>
  );
}
