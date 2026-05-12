/// <reference lib="dom" />
/**
 * Maneuver picker — Layer B. Lists ManeuverDefs from data/maneuvers/,
 * lets the user fire one and watches its timeline tick out. While
 * "playing", the panel hands the active right_hand / left_hand clip
 * ids back to the editor each tick via `onTick`; the editor samples
 * those clips and drives the actor's pose.
 *
 * Visual tracks (right_hand / left_hand / locomotion / hitEffects)
 * render as a coloured bar with markers per scheduled entry so the
 * authoring shape is obvious at a glance.
 */
import { useEffect, useState } from "preact/hooks";
import { listManeuvers, type ManeuverDef } from "../shell/content_loader.ts";

export interface ManeuverTick {
  /** Maneuver def currently firing. */
  def: ManeuverDef;
  /** Seconds since fire(). */
  elapsed: number;
  /** Active right-hand clip id (latest track entry with t ≤ elapsed). */
  rightClipId: string;
  /** Active left-hand clip id. */
  leftClipId: string;
  /** Hit-effect tags currently in window. */
  activeTags: { tag: string; magnitude: number }[];
}

export function ManeuverPanel({
  active,
  onTick,
  onIdle,
}: {
  active: boolean;
  onTick: (t: ManeuverTick) => void;
  /** Fires once when maneuver completes / is reset, so the editor can stop driving from it. */
  onIdle: () => void;
}) {
  const [all, setAll]     = useState<ManeuverDef[]>([]);
  const [picked, setPicked] = useState<ManeuverDef | null>(null);
  const [firedAt, setFiredAt] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    listManeuvers().then(setAll).catch((e) => console.warn("maneuver listing:", e));
  }, []);

  // RAF loop while firing.
  useEffect(() => {
    if (!active || firedAt === null || !picked) return;
    let raf = 0;
    const tick = (now: number) => {
      const t = (now - firedAt) / 1000;
      if (t >= picked.duration) {
        setElapsed(picked.duration);
        setFiredAt(null);
        onIdle();
        return;
      }
      setElapsed(t);
      onTick({
        def: picked,
        elapsed: t,
        rightClipId: pickActive(picked.tracks.right_hand, t),
        leftClipId:  pickActive(picked.tracks.left_hand,  t),
        activeTags: picked.tracks.hitEffects
          .filter((fx) => t >= fx.fromT && (fx.toT === undefined || t < fx.toT))
          .map((fx) => ({ tag: fx.tag, magnitude: fx.magnitude })),
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active, firedAt, picked, onTick, onIdle]);

  const fire = () => {
    if (!picked) return;
    setElapsed(0);
    setFiredAt(performance.now());
  };
  const stop = () => {
    setFiredAt(null);
    setElapsed(0);
    onIdle();
  };

  return (
    <div style={{ padding: 12, fontSize: 11 }}>
      <div style={{ color: "var(--aether-hi)", fontWeight: 600, marginBottom: 8 }}>Maneuvers</div>

      <select
        value={picked?.id ?? ""}
        onChange={(e) => {
          const id = (e.target as HTMLSelectElement).value;
          const m = all.find((m) => m.id === id) ?? null;
          setPicked(m);
          setFiredAt(null);
          setElapsed(0);
        }}
        style={{
          background: "var(--bog)", border: "1px solid var(--line-strong)", color: "var(--bone)",
          borderRadius: 0, padding: "3px 6px", fontSize: 11, width: "100%", marginBottom: 10,
          outline: "none",
        }}
      >
        <option value="">(pick a maneuver)</option>
        {all.map((m) => <option key={m.id} value={m.id}>{m.id} — {m.duration.toFixed(2)}s</option>)}
      </select>

      {picked && (
        <>
          <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
            <button onClick={fire} disabled={firedAt !== null} style={btn(firedAt !== null ? "var(--moss)" : "var(--ember-warm)")}>
              Fire ▶
            </button>
            <button onClick={stop} disabled={firedAt === null} style={btn()}>Stop</button>
            <span style={{ marginLeft: "auto", color: "var(--bone-dim)", alignSelf: "center" }}>
              {elapsed.toFixed(2)}s / {picked.duration.toFixed(2)}s
            </span>
          </div>

          <TimelineRow label="right_hand" entries={picked.tracks.right_hand.map((e) => ({ t: e.t, label: e.clip }))} duration={picked.duration} elapsed={elapsed} color="var(--aether-hi)" />
          <TimelineRow label="left_hand"  entries={picked.tracks.left_hand.map((e)  => ({ t: e.t, label: e.clip }))} duration={picked.duration} elapsed={elapsed} color="var(--rot)" />
          <TimelineRow label="locomotion" entries={picked.tracks.locomotion.map((e) => ({ t: e.t, label: `${e.kind}+${(e.forward ?? 0).toFixed(1)}m`, span: e.duration }))} duration={picked.duration} elapsed={elapsed} color="var(--lichen-hi)" />
          <TimelineRow label="hitEffects" entries={picked.tracks.hitEffects.map((e) => ({ t: e.fromT, label: e.tag, span: (e.toT ?? picked.duration) - e.fromT }))} duration={picked.duration} elapsed={elapsed} color="var(--ember-hi)" />

          {picked.interruptWindows.length > 0 && (
            <>
              <div style={{ color: "var(--bone-dim)", marginTop: 12, marginBottom: 4 }}>Interrupt windows</div>
              {picked.interruptWindows.map((w, i) => (
                <div key={i} style={{ fontSize: 10, color: "var(--bone)", marginBottom: 2 }}>
                  {w.fromT.toFixed(2)}–{w.toT.toFixed(2)}s by [{w.by.join(", ")}]
                </div>
              ))}
            </>
          )}
        </>
      )}
    </div>
  );
}

interface TLEntry { t: number; label: string; span?: number }

function TimelineRow({
  label, entries, duration, elapsed, color,
}: {
  label: string;
  entries: TLEntry[];
  duration: number;
  elapsed: number;
  color: string;
}) {
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ color: "var(--bone-dim)", marginBottom: 2 }}>{label}</div>
      <div style={{
        position: "relative",
        height: 18,
        background: "var(--bog)",
        border: "1px solid var(--line-strong)",
        borderRadius: 0,
        overflow: "hidden",
      }}>
        {entries.map((e, i) => {
          const left  = (e.t / duration) * 100;
          const width = ((e.span ?? 0.04) / duration) * 100;
          return (
            <div key={i} style={{
              position: "absolute",
              left: `${left}%`,
              width: `${Math.max(width, 2)}%`,
              top: 1, bottom: 1,
              background: color,
              opacity: 0.7,
              fontSize: 9,
              color: "var(--peat-solid)",
              paddingLeft: 3,
              whiteSpace: "nowrap",
              overflow: "hidden",
            }}>{e.label}</div>
          );
        })}
        <div style={{
          position: "absolute",
          left: `${(elapsed / duration) * 100}%`,
          top: 0, bottom: 0,
          width: 1,
          background: "var(--bone-hi)",
        }} />
      </div>
    </div>
  );
}

/** Latest track entry with t ≤ elapsed; "" when none scheduled yet. */
function pickActive(track: { t: number; clip: string }[], elapsed: number): string {
  let active = "";
  for (const e of track) if (e.t <= elapsed && e.t >= 0) active = e.clip;
  return active;
}

function btn(bg?: string) {
  return {
    padding: "4px 10px",
    background: bg ?? "var(--moss-hi)",
    color: "var(--bone-hi)",
    border: "1px solid var(--line-strong)",
    borderRadius: 0,
    cursor: "pointer",
    fontSize: 11,
  } as const;
}
