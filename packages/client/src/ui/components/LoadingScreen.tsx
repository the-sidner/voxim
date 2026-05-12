import { uiState } from "../ui_store.ts";

export function LoadingScreen() {
  const progress = uiState.value.loadingProgress;
  const pct = Math.round(progress * 100);
  const label = progress < 1 ? `Loading terrain… ${pct}%` : "Loading assets…";

  return (
    <div
      style={{
        position: "fixed", inset: "0",
        background: "var(--peat-solid)",
        display: "flex", flexDirection: "column",
        alignItems: "center", justifyContent: "center",
        zIndex: "var(--z-modal)",
        gap: "var(--s-7)",
      }}
    >
      <div class="ds-h2" style={{ color: "var(--bone)", letterSpacing: "0.06em" }}>
        {label}
      </div>
      <div class="bar-track" style={{ width: "240px", height: "4px" }}>
        <div
          class="bar-fill gain"
          style={{ width: `${pct}%`, background: "var(--ember)" }}
        />
      </div>
    </div>
  );
}
