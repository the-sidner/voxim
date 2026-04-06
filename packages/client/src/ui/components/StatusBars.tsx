import { computed } from "@preact/signals";
import { uiState } from "../ui_store.ts";

const health  = computed(() => uiState.value.health);
const stamina = computed(() => uiState.value.stamina);
const hunger  = computed(() => uiState.value.hunger);

function Bar({ label, fill, color, text }: {
  label: string; fill: number; color: string; text: string;
}) {
  return (
    <div class="bar">
      <span class="bar__label">{label}</span>
      <div class="bar__track">
        <div class="bar__fill" style={{ width: `${fill}%`, background: color }} />
      </div>
      <span class="bar__value">{text}</span>
    </div>
  );
}

export function StatusBars() {
  const hp = health.value;
  const st = stamina.value;
  const hg = hunger.value;

  const hpRatio  = hp ? hp.current / hp.max : 0;
  const stRatio  = st ? st.current / st.max : 0;
  const hgRatio  = hg ? Math.min(1, hg.value / 100) : 0;

  return (
    <div style={{
      position: "fixed", bottom: "24px", left: "50%",
      transform: "translateX(-50%)",
      display: "flex", flexDirection: "column", gap: "var(--gap-xs)",
      width: "220px",
      zIndex: "var(--z-hud)",
    }}>
      {hp && (
        <Bar
          label="HP"
          fill={hpRatio * 100}
          color={hpRatio < 0.3 ? "var(--col-health-low)" : "var(--col-health)"}
          text={`${Math.ceil(hp.current)}/${Math.ceil(hp.max)}`}
        />
      )}
      {st && (
        <Bar
          label="ST"
          fill={stRatio * 100}
          color={st.exhausted ? "var(--col-stamina-exh)" : "var(--col-stamina)"}
          text={st.exhausted ? "EXHAUSTED" : `${Math.ceil(st.current)}/${Math.ceil(st.max)}`}
        />
      )}
      {hg && (
        <Bar
          label="HG"
          fill={hgRatio * 100}
          color={hgRatio > 0.7 ? "var(--col-danger)" : hgRatio > 0.4 ? "var(--col-warn)" : "var(--col-hunger)"}
          text={hgRatio > 0.7 ? "starving" : hgRatio > 0.4 ? "hungry" : "fed"}
        />
      )}
    </div>
  );
}
