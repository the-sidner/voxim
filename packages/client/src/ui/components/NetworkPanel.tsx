/// <reference lib="dom" />
/**
 * NetworkPanel — browser-DevTools-style protocol inspector.
 *
 * Layout (fixed to screen bottom, ~45% height):
 *
 *   ┌─────────────────────────────────────────────────────────────────────┐
 *   │  [All] [Input] [State] [Events] [Snapshot]    [In] [Out]  [▶/⏸] [✕]│
 *   ├───────────────────────────────┬─────────────────────────────────────┤
 *   │ #   t(ms)  dir  ch  summary   │  selected message detail            │
 *   │ …                             │  key: value tree                    │
 *   └───────────────────────────────┴─────────────────────────────────────┘
 *
 * The list is the left ~55%, detail is the right ~45%.
 * Clicking a row populates the detail pane (same pattern as DevTools).
 */
import { useCallback, useState, useEffect, useRef } from "preact/hooks";
import { computed, signal } from "@preact/signals";
import {
  captureSignal, capturePaused, captureEnabled, clearCapture,
  type CapturedMessage, type CaptureChannel, type CaptureDir,
} from "../network_capture.ts";

// ── Local selection state (module-level signal so it persists across re-renders) ─

const selectedId = signal<number | null>(null);

// ── Tab + filter types ──────────────────────────────────────────────────────────

type Tab = "all" | CaptureChannel;
type DirFilter = "all" | CaptureDir;

// ── Colour maps ────────────────────────────────────────────────────────────────

const CHANNEL_COLOR: Record<CaptureChannel, string> = {
  input:    "var(--ember)",
  state:    "var(--aether-dim)",
  event:    "var(--lichen-hi)",
  snapshot: "var(--ember-warm)",
};

const DIR_COLOR: Record<CaptureDir, string> = {
  in:  "var(--lichen-hi)",
  out: "var(--ember)",
};

// ── FieldTree — recursive JSON-style detail renderer ──────────────────────────

function FieldTree({ data, depth = 0 }: { data: unknown; depth?: number }) {
  const [collapsed, setCollapsed] = useState(depth > 1);
  const indent = depth * 12;

  if (data === null)      return <span style={{ color: "var(--bone-dim)" }}>null</span>;
  if (data === undefined) return <span style={{ color: "var(--bone-dim)" }}>undefined</span>;
  if (typeof data === "boolean") return <span style={{ color: "var(--ember)" }}>{String(data)}</span>;
  if (typeof data === "number")  return <span style={{ color: "var(--aether-dim)" }}>{data}</span>;
  if (typeof data === "string")  return <span style={{ color: "var(--lichen-hi)" }}>"{data}"</span>;

  if (Array.isArray(data)) {
    if (data.length === 0) return <span style={{ color: "var(--bone-dim)" }}>[]</span>;
    return (
      <span>
        <span
          class="interactive"
          style={{ cursor: "pointer", color: "var(--bone-dim)" }}
          onClick={() => setCollapsed((c) => !c)}
        >
          {collapsed ? "▶" : "▼"} [{data.length}]
        </span>
        {!collapsed && (
          <div style={{ marginLeft: `${indent + 12}px` }}>
            {data.map((item, i) => (
              <div key={i} style={{ fontSize: "11px" }}>
                <span style={{ color: "var(--bone-dim)" }}>{i}: </span>
                <FieldTree data={item} depth={depth + 1} />
              </div>
            ))}
          </div>
        )}
      </span>
    );
  }

  if (typeof data === "object") {
    const entries = Object.entries(data as Record<string, unknown>);
    if (entries.length === 0) return <span style={{ color: "var(--bone-dim)" }}>{"{}"}</span>;
    return (
      <span>
        <span
          class="interactive"
          style={{ cursor: "pointer", color: "var(--bone-dim)" }}
          onClick={() => setCollapsed((c) => !c)}
        >
          {collapsed ? "▶" : "▼"} {"{" + entries.length + "}"}
        </span>
        {!collapsed && (
          <div style={{ marginLeft: `${indent + 12}px` }}>
            {entries.map(([k, v]) => (
              <div key={k} style={{ fontSize: "11px", lineHeight: "1.8" }}>
                <span style={{ color: "var(--bone-dim)" }}>{k}: </span>
                <FieldTree data={v} depth={depth + 1} />
              </div>
            ))}
          </div>
        )}
      </span>
    );
  }

  return <span>{String(data)}</span>;
}

// ── Row component ──────────────────────────────────────────────────────────────

function MessageRow({ msg, isSelected, t0, onClick }: {
  msg: CapturedMessage;
  isSelected: boolean;
  t0: number;
  onClick: () => void;
}) {
  const relMs = (msg.t - t0).toFixed(0);

  return (
    <div
      class="interactive"
      onClick={onClick}
      style={{
        display: "grid",
        gridTemplateColumns: "40px 52px 28px 58px 1fr 42px",
        gap: "var(--s-1)",
        padding: "2px var(--s-1)",
        fontSize: "11px",
        borderBottom: "1px solid var(--line-strong)",
        background: isSelected ? "var(--moss-hov)" : "transparent",
        cursor: "pointer",
        alignItems: "center",
        fontFamily: "var(--font-body)",
      }}
    >
      <span style={{ color: "var(--bone-dim)" }}>{msg.id}</span>
      <span style={{ color: "var(--bone-dim)" }}>+{relMs}ms</span>
      <span style={{ color: DIR_COLOR[msg.dir], fontWeight: "bold" }}>
        {msg.dir === "in" ? "↓" : "↑"}
      </span>
      <span style={{
        color: CHANNEL_COLOR[msg.channel],
        background: "rgba(0,0,0,0.25)",
        padding: "1px 4px",
        borderRadius: "0",
        fontSize: "9px",
        textTransform: "uppercase",
        letterSpacing: "0.08em",
      }}>
        {msg.channel}
      </span>
      <span style={{
        color: "var(--bone)",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      }}>
        {msg.summary}
      </span>
      <span style={{ color: "var(--bone-dim)", textAlign: "right" }}>
        {msg.bytes > 0 ? `${msg.bytes}B` : "—"}
      </span>
    </div>
  );
}

// ── Main panel ─────────────────────────────────────────────────────────────────

export function NetworkPanel() {
  const [tab, setTab] = useState<Tab>("all");
  const [dirFilter, setDirFilter] = useState<DirFilter>("all");
  const listRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  const messages = captureSignal.value;
  const paused   = capturePaused.value;

  // Filter the list
  const filtered = messages.filter((m) => {
    if (tab !== "all" && m.channel !== tab) return false;
    if (dirFilter !== "all" && m.dir !== dirFilter) return false;
    return true;
  });

  const t0 = filtered[0]?.t ?? performance.now();
  const selected = filtered.find((m) => m.id === selectedId.value) ?? null;

  // Auto-scroll list to bottom on new messages
  useEffect(() => {
    if (autoScroll && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [filtered.length, autoScroll]);

  const handleScroll = useCallback(() => {
    if (!listRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = listRef.current;
    setAutoScroll(scrollHeight - scrollTop - clientHeight < 8);
  }, []);

  function TabBtn({ id, label }: { id: Tab; label: string }) {
    return (
      <button
        class="interactive"
        onClick={() => setTab(id)}
        style={{
          padding: "3px 10px",
          fontSize: "11px",
          cursor: "pointer",
          background: tab === id ? "var(--moss-hov)" : "transparent",
          border: "none",
          borderBottom: tab === id ? `2px solid var(--ember)` : "2px solid transparent",
          color: tab === id ? "var(--bone)" : "var(--bone-dim)",
          fontFamily: "var(--font-body)",
          letterSpacing: "var(--ls-mono)",
        }}
      >
        {label}
      </button>
    );
  }

  function DirBtn({ id, label }: { id: DirFilter; label: string }) {
    return (
      <button
        class="interactive"
        onClick={() => setDirFilter(id)}
        style={{
          padding: "2px 8px",
          fontSize: "11px",
          cursor: "pointer",
          background: dirFilter === id ? "var(--moss-hov)" : "transparent",
          border: `1px solid ${dirFilter === id ? "var(--line-bright)" : "var(--line-strong)"}`,
          borderRadius: "0",
          color: dirFilter === id ? "var(--bone)" : "var(--bone-dim)",
          fontFamily: "var(--font-body)",
        }}
      >
        {label}
      </button>
    );
  }

  return (
    <div
      class="interactive"
      style={{
        position: "fixed",
        bottom: 0, left: 0, right: 0,
        height: "42vh",
        background: "var(--moss)",
        borderTop: "2px solid var(--line-strong)",
        zIndex: "var(--z-panel)",
        display: "flex",
        flexDirection: "column",
        fontFamily: "var(--font-body)",
      }}
    >
      {/* ── Toolbar ────────────────────────────────────────────────────────── */}
      <div style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--s-1)",
        borderBottom: "1px solid var(--line-strong)",
        padding: "0 var(--s-3)",
        flexShrink: 0,
        height: "32px",
      }}>
        {/* Channel tabs */}
        <TabBtn id="all"      label="All" />
        <TabBtn id="input"    label="Input" />
        <TabBtn id="state"    label="State" />
        <TabBtn id="event"    label="Events" />
        <TabBtn id="snapshot" label="Snapshot" />

        <div style={{ flex: 1 }} />

        {/* Direction filter */}
        <DirBtn id="all" label="All" />
        <DirBtn id="in"  label="↓ In" />
        <DirBtn id="out" label="↑ Out" />

        <div style={{ width: "1px", height: "16px", background: "var(--line-strong)", margin: "0 var(--s-1)" }} />

        {/* Count */}
        <span style={{ fontSize: "11px", color: "var(--bone-dim)" }}>
          {filtered.length}/{messages.length}
        </span>

        {/* Pause/resume */}
        <button
          class="btn interactive"
          style={{ fontSize: "11px", padding: "2px 8px" }}
          onClick={() => { capturePaused.value = !paused; }}
        >
          {paused ? "▶ Resume" : "⏸ Pause"}
        </button>

        {/* Clear */}
        <button
          class="btn interactive"
          style={{ fontSize: "11px", padding: "2px 8px" }}
          onClick={() => { clearCapture(); selectedId.value = null; }}
        >
          Clear
        </button>
      </div>

      {/* ── Content: list + detail ─────────────────────────────────────────── */}
      <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>

        {/* Message list */}
        <div
          ref={listRef}
          onScroll={handleScroll}
          style={{
            width: selected ? "55%" : "100%",
            overflow: "auto",
            borderRight: selected ? "1px solid var(--line-strong)" : "none",
          }}
        >
          {/* Column header */}
          <div style={{
            display: "grid",
            gridTemplateColumns: "40px 52px 28px 58px 1fr 42px",
            gap: "var(--s-1)",
            padding: "3px var(--s-1)",
            fontSize: "9px",
            color: "var(--bone-dim)",
            textTransform: "uppercase",
            letterSpacing: "0.1em",
            background: "var(--moss-hi)",
            borderBottom: "1px solid var(--line-strong)",
            position: "sticky",
            top: 0,
          }}>
            <span>#</span>
            <span>Time</span>
            <span>Dir</span>
            <span>Channel</span>
            <span>Summary</span>
            <span style={{ textAlign: "right" }}>Size</span>
          </div>

          {filtered.length === 0 ? (
            <div style={{
              padding: "var(--s-6)",
              color: "var(--bone-dim)",
              fontSize: "12px",
              textAlign: "center",
            }}>
              No messages captured yet.
            </div>
          ) : (
            filtered.map((msg) => (
              <MessageRow
                key={msg.id}
                msg={msg}
                isSelected={msg.id === selectedId.value}
                t0={t0}
                onClick={() => {
                  selectedId.value = selectedId.value === msg.id ? null : msg.id;
                }}
              />
            ))
          )}
        </div>

        {/* Detail pane */}
        {selected && (
          <div style={{
            width: "45%",
            overflow: "auto",
            padding: "var(--s-3)",
            fontSize: "11px",
          }}>
            {/* Detail header */}
            <div style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginBottom: "var(--s-3)",
              paddingBottom: "var(--s-1)",
              borderBottom: "1px solid var(--line-strong)",
            }}>
              <div style={{ display: "flex", gap: "var(--s-3)", alignItems: "center" }}>
                <span style={{ color: DIR_COLOR[selected.dir], fontWeight: "bold" }}>
                  {selected.dir === "in" ? "↓ incoming" : "↑ outgoing"}
                </span>
                <span style={{ color: CHANNEL_COLOR[selected.channel], textTransform: "uppercase", fontSize: "9px" }}>
                  {selected.channel}
                </span>
              </div>
              <button
                class="interactive"
                style={{ background: "none", border: "none", color: "var(--bone-dim)", cursor: "pointer", fontSize: "12px" }}
                onClick={() => { selectedId.value = null; }}
              >
                ✕
              </button>
            </div>

            <div style={{ marginBottom: "var(--s-1)", color: "var(--bone-dim)" }}>
              #{selected.id} · +{(selected.t - t0).toFixed(1)}ms
              {selected.bytes > 0 && ` · ${selected.bytes}B`}
            </div>
            <div style={{
              marginBottom: "var(--s-3)",
              padding: "var(--s-1)",
              background: "var(--moss-hi)",
              borderRadius: "0",
              fontFamily: "monospace",
              color: "var(--bone)",
              wordBreak: "break-all",
            }}>
              {selected.summary}
            </div>

            {/* Field tree */}
            <div style={{ paddingLeft: "var(--s-1)" }}>
              {Object.entries(selected.fields).map(([k, v]) => (
                <div key={k} style={{ lineHeight: "1.9", fontSize: "11px" }}>
                  <span style={{ color: "var(--bone-dim)" }}>{k}: </span>
                  <FieldTree data={v} depth={0} />
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
