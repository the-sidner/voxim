/// <reference lib="dom" />
/**
 * BuildHud (T-284) — the build brush control. Visible only in build mode; shows
 * the blueprint, tool, voxel size and line spacing, with steppers to adjust the
 * brush live. Reads + writes modeState.brush directly (pure client build state,
 * not server state), so the ghost (which subscribes to modeState) updates the
 * preview the instant a control changes.
 */
import { computed } from "@preact/signals";
import { modeState } from "../../input/context.ts";

/** Voxel size steps on the terrain lattice (HEIGHT_STEP = 0.25). */
const SIZE_STEP = 0.25;
const SIZE_MIN = 0.25;
const SIZE_MAX = 2.0;
const SPACING_MIN = 0;
const SPACING_MAX = 8;

const buildMode = computed(() => {
  const m = modeState.value;
  return m.kind === "build" ? m : null;
});

function setVoxelSize(next: number): void {
  const m = modeState.value;
  if (m.kind !== "build") return;
  const voxelSize = Math.round(Math.min(SIZE_MAX, Math.max(SIZE_MIN, next)) / SIZE_STEP) * SIZE_STEP;
  modeState.value = { ...m, brush: { ...m.brush, voxelSize } };
}

function setSpacing(next: number): void {
  const m = modeState.value;
  if (m.kind !== "build") return;
  const spacing = Math.min(SPACING_MAX, Math.max(SPACING_MIN, Math.round(next)));
  modeState.value = { ...m, brush: { ...m.brush, spacing } };
}

function Stepper(
  { label, value, onDec, onInc }: { label: string; value: string; onDec: () => void; onInc: () => void },
) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "6px", justifyContent: "space-between" }}>
      <span style={{ opacity: "0.7", minWidth: "52px" }}>{label}</span>
      <div style={{ display: "flex", alignItems: "center", gap: "4px" }}>
        <button class="ghost-btn" onClick={onDec}>−</button>
        <span style={{ minWidth: "40px", textAlign: "center", fontVariantNumeric: "tabular-nums" }}>{value}</span>
        <button class="ghost-btn" onClick={onInc}>+</button>
      </div>
    </div>
  );
}

export function BuildHud() {
  const m = buildMode.value;
  if (!m) return null;
  const { tool, voxelSize, spacing } = m.brush;

  return (
    <div
      class="panel"
      style={{
        position: "fixed",
        left: "16px",
        bottom: "120px",
        width: "180px",
        padding: "10px 12px",
        display: "flex",
        flexDirection: "column",
        gap: "8px",
        fontSize: "12px",
        pointerEvents: "auto",
        zIndex: "var(--z-hud)",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <strong>Build</strong>
        <span style={{ opacity: "0.7" }}>{m.blueprintId}</span>
      </div>
      <div style={{ opacity: "0.7" }}>tool: {tool}</div>
      <Stepper
        label="size"
        value={voxelSize.toFixed(2)}
        onDec={() => setVoxelSize(voxelSize - SIZE_STEP)}
        onInc={() => setVoxelSize(voxelSize + SIZE_STEP)}
      />
      {tool === "line" && (
        <Stepper
          label="spacing"
          value={String(spacing)}
          onDec={() => setSpacing(spacing - 1)}
          onInc={() => setSpacing(spacing + 1)}
        />
      )}
    </div>
  );
}
