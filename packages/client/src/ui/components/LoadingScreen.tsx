import { uiState } from "../ui_store.ts";

export function LoadingScreen() {
  const progress = uiState.value.loadingProgress;
  const pct = Math.round(progress * 100);
  const label = progress < 1 ? `Loading terrain… ${pct}%` : "Loading assets…";

  return (
    <div
      style={{
        position: "fixed", inset: "0",
        background: "var(--col-bg, #0a0a0a)",
        display: "flex", flexDirection: "column",
        alignItems: "center", justifyContent: "center",
        zIndex: "var(--z-modal)",
        color: "var(--col-text-muted, #888)",
        fontFamily: "inherit",
      }}
    >
      <div style={{ fontSize: "var(--text-xl)", marginBottom: "var(--gap-xl)", letterSpacing: "0.15em" }}>
        {label}
      </div>
      <div style={{
        width: "240px", height: "4px",
        background: "var(--col-surface-2, #222)",
        borderRadius: "2px",
        overflow: "hidden",
      }}>
        <div style={{
          height: "100%",
          width: `${pct}%`,
          background: "var(--col-accent, #8af)",
          borderRadius: "2px",
          transition: "width 100ms linear",
        }} />
      </div>
    </div>
  );
}
