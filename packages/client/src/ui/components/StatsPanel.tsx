import { computed } from "@preact/signals";
import { uiState } from "../ui_store.ts";
import { usePanel } from "../use_panel.ts";

const stats = computed(() => uiState.value.stats);

function StatRow({ label, value }: { label: string; value: number | string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", fontSize: "var(--text-sm)" }}>
      <span style={{ color: "var(--col-text-dim)" }}>{label}</span>
      <span>{value}</span>
    </div>
  );
}

export function StatsPanel() {
  const s = stats.value;
  if (!s) return null;
  const { panelProps, titleProps } = usePanel({ defaultX: 460, defaultY: 80 });

  return (
    <div class="panel interactive" {...panelProps} style={{ ...panelProps.style, width: "240px" }}>
      <div class="panel__title" {...titleProps}>Character</div>
      <div style={{ marginBottom: "var(--gap-sm)" }}>
        <StatRow label="Level"     value={s.level} />
        <StatRow label="XP"        value={`${s.experience} / ${s.nextLevel}`} />
      </div>
      <div class="panel__title" style={{ marginTop: "var(--gap-sm)" }}>Attributes</div>
      <div style={{ marginBottom: "var(--gap-sm)" }}>
        <StatRow label="Strength"  value={s.strength} />
        <StatRow label="Endurance" value={s.endurance} />
        <StatRow label="Agility"   value={s.agility} />
        <StatRow label="Lore"      value={s.lore} />
      </div>
      <div class="panel__title" style={{ marginTop: "var(--gap-sm)" }}>Combat</div>
      <div>
        <StatRow label="Attack"    value={s.derived.attackDamage} />
        <StatRow label="Spd"       value={s.derived.attackSpeed} />
        <StatRow label="Defense"   value={s.derived.defense} />
        <StatRow label="Move"      value={s.derived.moveSpeed} />
        <StatRow label="Carry"     value={s.derived.carryCapacity} />
      </div>
    </div>
  );
}
