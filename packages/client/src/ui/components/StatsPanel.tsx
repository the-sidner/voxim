import { computed } from "@preact/signals";
import { uiState, closePanel } from "../ui_store.ts";
import { Pane, Section, StatRow, Kbd } from "./primitives.tsx";

const stats = computed(() => uiState.value.stats);

// Attribute runes — Norse-derived, each visually distinct. Match the design
// system dictionary in data/design/ui_kits/game/game-ui.jsx.
const RUNE = {
  str: "ᚦ",  // thurs — strength
  dex: "ᛇ",  // ihwaz — agility
  intl: "ᚨ", // ansuz — knowledge
  wil: "ᛟ",  // othala — will
  end: "ᛒ",  // berkanan — endurance
  luc: "ᛞ",  // dagaz — fortune
};

export function StatsPanel() {
  const s = stats.value;
  if (!s) return null;

  return (
    <Pane
      title="Self"
      defaultX={460} defaultY={80}
      onClose={() => closePanel("stats")}
      style={{ width: "260px" }}
      foot={
        <>
          <span><Kbd>C</Kbd>self</span>
          <span class="num">level {s.level} · {s.experience} / {s.nextLevel}</span>
        </>
      }
    >
      <Section title="Attributes">
        <StatRow rune={RUNE.str} label="Strength"   value={s.strength} />
        <StatRow rune={RUNE.end} label="Endurance"  value={s.endurance} />
        <StatRow rune={RUNE.dex} label="Agility"    value={s.agility} />
        <StatRow rune={RUNE.intl} label="Lore"      value={s.lore} />
      </Section>

      <Section title="Combat">
        <StatRow label="Attack"   value={s.derived.attackDamage} />
        <StatRow label="Speed"    value={s.derived.attackSpeed} />
        <StatRow label="Defense"  value={s.derived.defense} />
        <StatRow label="Move"     value={s.derived.moveSpeed} />
        <StatRow label="Carry"    value={s.derived.carryCapacity} />
      </Section>
    </Pane>
  );
}
