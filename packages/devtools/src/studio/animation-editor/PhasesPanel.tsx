/// <reference lib="dom" />
/**
 * Phases panel (T-327) — the combat-feel tuning pipeline's precision
 * complement to T-322's Sweep tab. Picks an ActionDef (data/actions/*.json —
 * the universal action primitive, NOT WeaponActionDef), renders its phase
 * timeline in TICKS as bars (windup/active/winddown/recovery, or whatever
 * phases the def declares), the hitbox-live / i-frame / block windows
 * derived from its `effects` (phase_windows.ts — no new vocabulary, just
 * reading back the same set_tag/clear_tag/weapon_trace shape those windows
 * are already authored as), and a hitStopTicks annotation. Scrubbable in
 * ticks, with the same action's blade sweep visible alongside via the SAME
 * overlay primitives the Sweep tab uses (sweep_overlay.ts) — Sweep shows the
 * swing's GEOMETRY, this shows its TIME; together they're the authoring
 * pair the ticket asks for.
 *
 * A generic swing (swing_medium etc.) resolves its weapon geometry
 * dynamically from whatever's equipped at runtime — it pins no
 * WeaponActionDef. This panel falls back to a manual weapon-action picker
 * in that case (pre-filled when a signature move like sword_overhead DOES
 * pin one via `effects[].params.weaponActionId`, T-254). The geometry
 * preview normalizes scrub position against THIS ActionDef's own phase
 * ticks (not the picked WeaponActionDef's windup/active/winddown, which the
 * Sweep tab uses and which can differ numerically per T-327's own content
 * survey) — an approximation appropriate for "how does this look across the
 * phases I'm tuning", not a byte-exact runtime replica (that exactness is
 * what the Sweep tab is for).
 */
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type * as THREE from "three";
import { listDir } from "../shell/file_io.ts";
import type { ActionDefSummary, WeaponActionDef } from "../shell/content_loader.ts";
import { loadActionDef, loadWeaponAction } from "../shell/content_loader.ts";
import type { SkeletonView } from "./skeleton_view.ts";
import { SweepOverlay, poseSwingAt, readSwungBlade } from "./sweep_overlay.ts";
import { derivePhaseWindows, windowCoversPhase, pinnedWeaponActionId } from "./phase_windows.ts";
import type { SweepSkeletonLike } from "./SweepPanel.tsx";

const PERPETUAL_PCT = 12;

interface Segment {
  phase: string;
  ticks: number;
  isPerpetual: boolean;
  widthPercent: number;
  tickStart: number;
  tickEnd: number;
}

function buildSegments(action: ActionDefSummary): { segments: Segment[]; totalTicks: number } {
  const phaseNames = Object.keys(action.phases);
  const finiteNames = phaseNames.filter((p) => action.phases[p].ticks >= 0);
  const finiteTotal = finiteNames.reduce((s, p) => s + action.phases[p].ticks, 0);

  if (finiteNames.length === 0) {
    const share = 100 / Math.max(1, phaseNames.length);
    const segments = phaseNames.map((phase) => ({
      phase, ticks: action.phases[phase].ticks, isPerpetual: true,
      widthPercent: share, tickStart: 0, tickEnd: 0,
    }));
    return { segments, totalTicks: 0 };
  }

  const perpetualBudget = (phaseNames.length - finiteNames.length) * PERPETUAL_PCT;
  const finiteBudget = Math.max(10, 100 - perpetualBudget);
  let cursor = 0;
  const segments = phaseNames.map((phase) => {
    const ticks = action.phases[phase].ticks;
    const isPerpetual = ticks < 0;
    const widthPercent = isPerpetual ? PERPETUAL_PCT : (ticks / finiteTotal) * finiteBudget;
    const tickStart = cursor;
    if (!isPerpetual) cursor += ticks;
    return { phase, ticks, isPerpetual, widthPercent, tickStart, tickEnd: cursor };
  });
  return { segments, totalTicks: cursor };
}

const WINDOW_COLORS: Record<string, string> = {
  "hitbox-live": "#ee5533",
  iframe: "#39d7c0",
  blocking: "#5a9fd7",
};

function colorForWindow(label: string): string {
  return WINDOW_COLORS[label] ?? "#c9a24a";
}

export function PhasesPanel({
  skeleton,
  skeletonView,
  viewportContentGroup,
}: {
  skeleton: SweepSkeletonLike | null;
  skeletonView: SkeletonView | null;
  viewportContentGroup: THREE.Group | null;
}) {
  const [actionIds, setActionIds] = useState<string[]>([]);
  const [actionId, setActionId] = useState<string | null>(null);
  const [action, setAction] = useState<ActionDefSummary | null>(null);

  const [weaponActionIds, setWeaponActionIds] = useState<string[]>([]);
  const [weaponActionId, setWeaponActionId] = useState("");
  const [weaponAction, setWeaponAction] = useState<WeaponActionDef | null>(null);

  const [scrubTick, setScrubTick] = useState(0);

  const overlayRef = useRef<SweepOverlay | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const entries = await listDir("actions");
        setActionIds(entries.filter((e) => e.kind === "file").map((e) => e.name.replace(/\.json$/, "")).sort());
      } catch (e) {
        console.warn("phases panel: actions list failed:", e);
      }
      try {
        const entries = await listDir("weapon_actions");
        setWeaponActionIds(entries.filter((e) => e.kind === "file").map((e) => e.name.replace(/\.json$/, "")).sort());
      } catch (e) {
        console.warn("phases panel: weapon_actions list failed:", e);
      }
    })();
  }, []);

  const pickAction = async (id: string) => {
    setActionId(id);
    setScrubTick(0);
    try {
      const def = await loadActionDef(id);
      setAction(def);
      const pinned = def ? pinnedWeaponActionId(def) ?? "" : "";
      await pickWeaponAction(pinned);
    } catch (e) {
      console.warn("phases panel: action load failed:", e);
      setAction(null);
      await pickWeaponAction("");
    }
  };

  const pickWeaponAction = async (id: string) => {
    setWeaponActionId(id);
    setWeaponAction(id ? await loadWeaponAction(id) : null);
  };

  // Overlay lifecycle — same pattern as SweepPanel.
  useEffect(() => {
    if (!viewportContentGroup) return;
    const overlay = new SweepOverlay();
    viewportContentGroup.add(overlay.group);
    overlayRef.current = overlay;
    return () => {
      viewportContentGroup.remove(overlay.group);
      overlay.dispose();
      overlayRef.current = null;
    };
  }, [viewportContentGroup, skeleton?.id]);

  const boneIndex = useMemo(() => {
    if (!skeleton) return null;
    return new Map(skeleton.bones.map((b) => [b.id, b]));
  }, [skeleton]);

  const { segments, totalTicks } = useMemo(
    () => action ? buildSegments(action) : { segments: [] as Segment[], totalTicks: 0 },
    [action],
  );
  const windows = useMemo(() => action ? derivePhaseWindows(action) : [], [action]);
  const currentSegment = segments.find((s) => !s.isPerpetual && scrubTick >= s.tickStart && scrubTick <= s.tickEnd)
    ?? segments.find((s) => !s.isPerpetual) ?? null;
  const currentPhase = currentSegment?.phase ?? null;
  const t = totalTicks > 0 ? scrubTick / totalTicks : 0;
  const inHitboxWindow = !!action && !!currentPhase &&
    windows.some((w) => w.label === "hitbox-live" && windowCoversPhase(action, w, currentPhase));

  const swingPath = weaponAction?.swingPath ?? null;
  const holdHand = weaponAction?.holdHand ?? "hand_r";

  useEffect(() => {
    const overlay = overlayRef.current;
    const view = skeletonView;
    if (!overlay || !view || !skeleton || !boneIndex || !swingPath) {
      overlay?.clearSweptVolume();
      return;
    }
    poseSwingAt(skeleton, boneIndex, view, swingPath, t);
    const blade = readSwungBlade(view, swingPath, holdHand);
    if (blade) overlay.setBlade(blade.base, blade.tip, blade.radius, inHitboxWindow);
    overlay.buildArc(swingPath);
  }, [t, skeleton, boneIndex, swingPath, holdHand, inHitboxWindow]);

  if (!skeleton) {
    return <div style={{ padding: 12, color: "var(--bone-dim)", fontSize: 12 }}>
      Pick a skeleton from <code>skeletons/</code> to start.
    </div>;
  }

  return (
    <div style={{ padding: 12, fontSize: 11 }}>
      <div style={{ color: "var(--aether-hi)", fontWeight: 600, marginBottom: 8 }}>Phase timeline</div>

      <div style={{ marginBottom: 10 }}>
        <div style={{ color: "var(--bone-dim)", marginBottom: 3 }}>action</div>
        <select
          value={actionId ?? ""}
          onChange={(e) => pickAction((e.target as HTMLSelectElement).value)}
          style={selectStyle}
        >
          <option value="" disabled>— pick —</option>
          {actionIds.map((id) => <option key={id} value={id}>{id}</option>)}
        </select>
      </div>

      {actionId && !action && (
        <div style={{ color: "var(--rot)" }}>failed to load "{actionId}"</div>
      )}

      {action && (
        <>
          <Field label="kind">{action.kind}</Field>
          <Field label="slot">{action.slot}</Field>
          {action.hitStopTicks !== undefined && action.hitStopTicks > 0 && (
            <Field label="hitstop">+{action.hitStopTicks}t freeze on hit</Field>
          )}
          {action.cooldownTicks !== undefined && action.cooldownTicks > 0 && (
            <Field label="cooldown">{action.cooldownTicks}t</Field>
          )}

          {/* ── Phase bars ──────────────────────────────────────────────── */}
          <div style={{ margin: "12px 0 4px", color: "var(--bone-dim)" }}>phases (ticks)</div>
          <div style={{ display: "flex", width: "100%", height: 28, border: "1px solid var(--line-strong)" }}>
            {segments.map((s) => (
              <div
                key={s.phase}
                title={s.isPerpetual ? `${s.phase}: held` : `${s.phase}: ${s.ticks}t`}
                style={{
                  width: `${s.widthPercent}%`,
                  borderRight: "1px solid var(--line)",
                  background: s.phase === currentPhase ? "var(--aether-hi)" : "var(--bog)",
                  color: s.phase === currentPhase ? "#111" : "var(--bone)",
                  display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
                  fontSize: 9, lineHeight: 1.2, overflow: "hidden",
                }}
              >
                <span>{s.phase}</span>
                <span style={{ opacity: 0.8 }}>{s.isPerpetual ? "∞" : s.ticks}</span>
              </div>
            ))}
          </div>

          {/* ── Window swimlanes (hitbox-live / iframe / blocking / …) ──── */}
          {windows.length > 0 && (
            <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 2 }}>
              {windows.map((w, i) => (
                <div key={`${w.label}-${i}`} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ width: 72, flexShrink: 0, color: colorForWindow(w.label), fontSize: 9 }}>{w.label}</span>
                  <div style={{ display: "flex", width: "100%", height: 8 }}>
                    {segments.map((s) => (
                      <div
                        key={s.phase}
                        style={{
                          width: `${s.widthPercent}%`,
                          background: windowCoversPhase(action, w, s.phase) ? colorForWindow(w.label) : "transparent",
                          opacity: windowCoversPhase(action, w, s.phase) ? 0.7 : 1,
                        }}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* ── Scrub ───────────────────────────────────────────────────── */}
          {totalTicks > 0 ? (
            <>
              <div style={{ margin: "12px 0 4px", color: "var(--bone-dim)" }}>
                scrub tick = {scrubTick} / {totalTicks} {currentPhase && <span>({currentPhase})</span>}
                {inHitboxWindow && <b style={{ color: "#6fcf6f", marginLeft: 6 }}>ACTIVE</b>}
              </div>
              <input
                type="range" min={0} max={totalTicks} step={1} value={scrubTick}
                onInput={(e) => setScrubTick(parseInt((e.target as HTMLInputElement).value, 10))}
                style={{ width: "100%" }}
              />
            </>
          ) : (
            <div style={{ margin: "12px 0 4px", color: "var(--bone-faint)" }}>
              no finite phase to scrub — held as long as the input is held (e.g. block)
            </div>
          )}

          {/* ── Geometry preview (alongside, via the Sweep tab's own overlay) ── */}
          <div style={{ marginTop: 14, color: "var(--bone-dim)" }}>blade sweep (T-322, alongside)</div>
          <select
            value={weaponActionId}
            onChange={(e) => pickWeaponAction((e.target as HTMLSelectElement).value)}
            style={selectStyle}
          >
            <option value="">— none (no geometry preview) —</option>
            {weaponActionIds.map((id) => <option key={id} value={id}>{id}</option>)}
          </select>
          {!weaponAction?.swingPath && weaponActionId && (
            <div style={{ marginTop: 4, color: "var(--rot)" }}>
              "{weaponActionId}" has no authored swingPath — nothing to preview.
            </div>
          )}
          <div style={{ marginTop: 6, color: "var(--bone-faint)", fontSize: 10, lineHeight: 1.5 }}>
            Scrub position maps to this ACTION's own phase ticks, not the picked weapon
            action's windup/active/winddown (those can differ — the Sweep tab is the
            byte-exact geometry reference; this is "roughly where the blade is right now"
            while you tune timing.
          </div>
        </>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: preact.ComponentChildren }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "80px 1fr", gap: 6, marginBottom: 2 }}>
      <span style={{ color: "var(--bone-dim)" }}>{label}</span>
      <span style={{ color: "var(--bone)" }}>{children}</span>
    </div>
  );
}

const selectStyle = {
  width: "100%",
  background: "var(--bog)",
  border: "1px solid var(--line-strong)",
  color: "var(--bone)",
  borderRadius: 0,
  padding: "4px 6px",
  fontSize: 11,
  fontFamily: "inherit",
  outline: "none",
} as const;
