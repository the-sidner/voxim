/// <reference lib="dom" />
/**
 * DebugPanel — central place for all debug toggles and utilities.
 *
 * Sections:
 *   Render overlays   — toggle visual debug layers (skeleton, blade, etc.)
 *   Network           — open/close the network inspector panel
 *   Future sections go here as the game grows.
 *
 * Actions are dispatched via UIAction so game.ts is the only place that
 * touches the renderer/overlay state.
 */
import { debugOverlays, debugItemList } from "../debug_store.ts";
import { uiState, openPanel, closePanel } from "../ui_store.ts";
import { usePanel } from "../use_panel.ts";
import type { UIAction } from "../ui_actions.ts";
import type { DebugLayer } from "../debug_store.ts";
import { captureEnabled, capturePaused, captureSignal } from "../network_capture.ts";
import { computed, signal } from "@preact/signals";

const networkOpen = computed(() => uiState.value.openPanels.has("network"));

// ── Sub-section wrapper ────────────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: preact.ComponentChildren }) {
  return (
    <div style={{ marginBottom: "var(--gap-md)" }}>
      <div class="panel__title">{title}</div>
      {children}
    </div>
  );
}

// ── Toggle row ─────────────────────────────────────────────────────────────────

function ToggleRow({ label, on, onToggle, hint }: {
  label: string;
  on: boolean;
  onToggle: () => void;
  hint?: string;
}) {
  return (
    <div style={{
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      padding: "var(--gap-xs) 0",
      borderBottom: "1px solid var(--col-border)",
      fontSize: "var(--text-sm)",
    }}>
      <div>
        <span>{label}</span>
        {hint && <span style={{ color: "var(--col-text-dim)", fontSize: "var(--text-xs)", marginLeft: "var(--gap-xs)" }}>{hint}</span>}
      </div>
      <button
        class="btn interactive"
        onClick={onToggle}
        style={{
          minWidth: "52px",
          padding: "2px 8px",
          fontSize: "var(--text-xs)",
          borderColor: on ? "var(--col-accent)" : "var(--col-border)",
          color: on ? "var(--col-accent)" : "var(--col-text-dim)",
        }}
      >
        {on ? "ON" : "OFF"}
      </button>
    </div>
  );
}

// ── Main panel ─────────────────────────────────────────────────────────────────

export function DebugPanel({ onAction }: { onAction: (a: UIAction) => void }) {
  const overlays = debugOverlays.value;
  const { panelProps, titleProps } = usePanel({ defaultX: 20, defaultY: 80 });

  function toggle(layer: DebugLayer) {
    onAction({ type: "debug_toggle", layer });
  }

  return (
    <div class="panel interactive" {...panelProps} style={{ ...panelProps.style, width: "260px", maxHeight: "80vh", overflowY: "auto" }}>
      <div class="panel__title" {...titleProps}>Debug</div>

      {/* ── Post-processing ───────────────────────────────────────────────── */}
      <Section title="Post-processing">
        <ToggleRow
          label="FXAA"
          hint="anti-aliasing"
          on={overlays.fxaa}
          onToggle={() => toggle("fxaa")}
        />
      </Section>

      {/* ── Render overlays ───────────────────────────────────────────────── */}
      <Section title="Render overlays">
        <ToggleRow
          label="Skeleton"
          hint="bone axes"
          on={overlays.skeleton}
          onToggle={() => toggle("skeleton")}
        />
        <ToggleRow
          label="Facing"
          hint="direction arrow"
          on={overlays.facing}
          onToggle={() => toggle("facing")}
        />
        <ToggleRow
          label="Chunks"
          hint="terrain boundaries"
          on={overlays.chunks}
          onToggle={() => toggle("chunks")}
        />
        <ToggleRow
          label="Heightmap"
          hint="elevation wireframe"
          on={overlays.heightmap}
          onToggle={() => toggle("heightmap")}
        />
        <ToggleRow
          label="Blade"
          hint="hit capsule"
          on={overlays.blade}
          onToggle={() => toggle("blade")}
        />
        <ToggleRow
          label="Hitbox"
          hint="body part capsules"
          on={overlays.hitbox}
          onToggle={() => toggle("hitbox")}
        />
      </Section>

      {/* ── Network inspector ─────────────────────────────────────────────── */}
      <Section title="Network">
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--gap-xs)" }}>
          <ToggleRow
            label="Network panel"
            on={networkOpen.value}
            onToggle={() => networkOpen.value ? closePanel("network") : openPanel("network")}
          />
          <ToggleRow
            label="Capture enabled"
            on={captureEnabled.value}
            onToggle={() => { captureEnabled.value = !captureEnabled.value; }}
          />
          <div style={{
            fontSize: "var(--text-xs)",
            color: "var(--col-text-dim)",
            paddingTop: "var(--gap-xs)",
          }}>
            {captureSignal.value.length} messages buffered
            {capturePaused.value && <span style={{ color: "var(--col-warn)", marginLeft: "var(--gap-xs)" }}>⏸ paused</span>}
          </div>
        </div>
      </Section>

      {/* ── Give item ─────────────────────────────────────────────────────── */}
      <GiveItemSection onAction={onAction} />

      {/* ── Future sections ───────────────────────────────────────────────── */}
      {/* TODO: Physics debug (collision shapes, velocity vectors) */}
      {/* TODO: AI debug (NPC job queues, pathfinding) */}
      {/* TODO: Performance (tick timing, draw calls) */}
    </div>
  );
}

// ── Give item section ─────────────────────────────────────────────────────────

const giveFilter = signal("");
const giveQty    = signal(1);

function GiveItemSection({ onAction }: { onAction: (a: UIAction) => void }) {
  const items = debugItemList.value;
  const filter = giveFilter.value.toLowerCase();
  const filtered = filter
    ? items.filter((it) => it.id.includes(filter) || it.category.includes(filter))
    : items;

  return (
    <Section title="Give item">
      <div style={{ display: "flex", gap: "var(--gap-xs)", marginBottom: "var(--gap-xs)" }}>
        <input
          type="text"
          placeholder="filter…"
          value={giveFilter.value}
          onInput={(e) => { giveFilter.value = (e.target as HTMLInputElement).value; }}
          style={{
            flex: 1,
            background: "var(--col-bg-panel)",
            border: "1px solid var(--col-border)",
            color: "var(--col-text)",
            borderRadius: "3px",
            padding: "2px 6px",
            fontSize: "var(--text-xs)",
          }}
        />
        <input
          type="number"
          min={1}
          max={255}
          value={giveQty.value}
          onInput={(e) => {
            const v = parseInt((e.target as HTMLInputElement).value);
            if (!isNaN(v)) giveQty.value = Math.max(1, Math.min(255, v));
          }}
          style={{
            width: "44px",
            background: "var(--col-bg-panel)",
            border: "1px solid var(--col-border)",
            color: "var(--col-text)",
            borderRadius: "3px",
            padding: "2px 4px",
            fontSize: "var(--text-xs)",
            textAlign: "right",
          }}
        />
      </div>
      <div style={{
        maxHeight: "180px",
        overflowY: "auto",
        display: "flex",
        flexDirection: "column",
        gap: "2px",
      }}>
        {filtered.slice(0, 60).map((item) => (
          <button
            key={item.id}
            class="btn interactive"
            onClick={() => onAction({ type: "debug_give_item", itemType: item.id, quantity: giveQty.value })}
            style={{
              textAlign: "left",
              padding: "3px 6px",
              fontSize: "var(--text-xs)",
              display: "flex",
              justifyContent: "space-between",
              gap: "var(--gap-xs)",
            }}
          >
            <span>{item.id}</span>
            <span style={{ color: "var(--col-text-dim)" }}>{item.category}</span>
          </button>
        ))}
        {filtered.length === 0 && (
          <div style={{ color: "var(--col-text-dim)", fontSize: "var(--text-xs)", padding: "4px 0" }}>
            no items match
          </div>
        )}
        {filtered.length > 60 && (
          <div style={{ color: "var(--col-text-dim)", fontSize: "var(--text-xs)", padding: "4px 0" }}>
            {filtered.length - 60} more — refine filter
          </div>
        )}
      </div>
    </Section>
  );
}
