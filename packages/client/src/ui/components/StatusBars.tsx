import { computed } from "@preact/signals";
import { uiState } from "../ui_store.ts";
import { Bar } from "./primitives.tsx";

const health  = computed(() => uiState.value.health);
const stamina = computed(() => uiState.value.stamina);
const hunger  = computed(() => uiState.value.hunger);

// Vitals are runes that ride the body line — italic Spectral glyphs.
const RUNE = { health: "ᚼ", stamina: "ᛟ", hunger: "ᛒ" };

export function StatusBars() {
  const hp = health.value;
  const st = stamina.value;
  const hg = hunger.value;

  return (
    <div class="vitals" style={{
      position: "fixed", bottom: "100px", left: "50%",
      transform: "translateX(-50%)",
      zIndex: "var(--z-hud)",
    }}>
      {hp && (() => {
        const ratio = hp.current / hp.max;
        return (
          <Bar
            channel="health"
            rune={RUNE.health}
            fill={ratio}
            low={ratio < 0.3}
            readout={`${Math.ceil(hp.current)} / ${Math.ceil(hp.max)}`}
          />
        );
      })()}
      {st && (() => {
        const ratio = st.current / st.max;
        return (
          <Bar
            channel="stamina"
            rune={RUNE.stamina}
            fill={ratio}
            color={st.exhausted ? "var(--blood-dim)" : undefined}
            readout={st.exhausted ? "exhausted" : `${Math.ceil(st.current)} / ${Math.ceil(st.max)}`}
          />
        );
      })()}
      {hg && (() => {
        const ratio = Math.min(1, hg.value / 100);
        return (
          <Bar
            channel="hunger"
            rune={RUNE.hunger}
            fill={ratio}
            color={ratio > 0.7 ? "var(--rot)" : undefined}
            readout={ratio > 0.7 ? "starving" : ratio > 0.4 ? "hungry" : "fed"}
          />
        );
      })()}
    </div>
  );
}
