export function LoadingScreen() {
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
        Loading world…
      </div>
      <div style={{
        width: "200px", height: "4px",
        background: "var(--col-surface-2, #222)",
        borderRadius: "2px",
        overflow: "hidden",
      }}>
        <div style={{
          height: "100%",
          background: "var(--col-accent, #8af)",
          borderRadius: "2px",
          animation: "loading-pulse 1.4s ease-in-out infinite",
        }} />
      </div>
      <style>{`
        @keyframes loading-pulse {
          0%   { width: 0%; margin-left: 0; }
          50%  { width: 60%; margin-left: 20%; }
          100% { width: 0%; margin-left: 100%; }
        }
      `}</style>
    </div>
  );
}
