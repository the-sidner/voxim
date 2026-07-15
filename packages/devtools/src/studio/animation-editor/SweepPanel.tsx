/// <reference lib="dom" />
/**
 * Sweep panel (T-322) — the swing-sweep debugger. Picks a WeaponActionDef,
 * renders its authored swingPath blade arc + tip trail against the
 * animation editor's shared skeleton view, scrubs `t` to pose the full
 * body (solveSwingPose) and show the swept blade capsule, and overlays the
 * capsule volume across the action's active window.
 *
 * Read-only v1 (per ticket) — no save-back editing. Parity target: the
 * SAME sampleSwingPath/solveSwingPose calls the server's weapon_trace
 * resolver and the client renderer use, so what this panel draws is what
 * the live game sweeps and hits (not a re-implementation).
 *
 * Superseded stub: AnimationEditor.tsx used to carry a bare comment here
 * ("weapon-sweep / attachment-override tooling (T-191e)") pointing at a
 * dead v1 clip_overrides plan — this panel is the real thing, built
 * against the current swingPath model instead.
 */
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type * as THREE from "three";
import { listDir, readJson } from "../shell/file_io.ts";
import type { WeaponActionDef } from "../shell/content_loader.ts";
import type { SkeletonView } from "./skeleton_view.ts";
import { SweepOverlay, poseSwingAt, readSwungBlade, readHandWorld, sampleHiltWorld } from "./sweep_overlay.ts";
import type { BoneDef } from "@voxim/content";

export interface SweepSkeletonLike {
  id: string;
  archetype: string;
  bones: BoneDef[];
}

export function SweepPanel({
  skeleton,
  skeletonView,
  viewportContentGroup,
}: {
  skeleton: SweepSkeletonLike | null;
  skeletonView: SkeletonView | null;
  /** The viewport's content root — overlay geometry parents in here. */
  viewportContentGroup: THREE.Group | null;
}) {
  const [actionIds, setActionIds] = useState<string[]>([]);
  const [actionId, setActionId] = useState<string | null>(null);
  const [action, setAction] = useState<WeaponActionDef | null>(null);
  const [t, setT] = useState(0.5);
  const [showSweep, setShowSweep] = useState(true);
  const [sweepSamples, setSweepSamples] = useState(10);

  const overlayRef = useRef<SweepOverlay | null>(null);

  // List weapon_actions/ once.
  useEffect(() => {
    (async () => {
      try {
        const entries = await listDir("weapon_actions");
        setActionIds(
          entries.filter((e) => e.kind === "file").map((e) => e.name.replace(/\.json$/, "")).sort(),
        );
      } catch (e) {
        console.warn("sweep panel: weapon_actions list failed:", e);
      }
    })();
  }, []);

  const pick = async (id: string) => {
    setActionId(id);
    try {
      setAction(await readJson<WeaponActionDef>(`weapon_actions/${id}.json`));
    } catch (e) {
      console.warn("sweep panel: weapon action load failed:", e);
      setAction(null);
    }
  };

  // Overlay lifecycle: one SweepOverlay per (viewport, skeleton) pairing.
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

  const swingPath = action?.swingPath ?? null;
  const holdHand = action?.holdHand ?? "hand_r";

  const totalTicks = action ? (action.windupTicks ?? 0) + (action.activeTicks ?? 0) + (action.winddownTicks ?? 0) : 0;
  const activeStart = action && totalTicks > 0 ? (action.windupTicks ?? 0) / totalTicks : 0;
  const activeEnd = action && totalTicks > 0 ? ((action.windupTicks ?? 0) + (action.activeTicks ?? 0)) / totalTicks : 0;
  const inActiveWindow = !!action && t >= activeStart && t <= activeEnd;

  // Pose + place the blade whenever t / action / skeleton changes.
  useEffect(() => {
    const overlay = overlayRef.current;
    const view = skeletonView;
    if (!overlay || !view || !skeleton || !boneIndex || !swingPath) {
      overlay?.clearSweptVolume();
      return;
    }
    poseSwingAt(skeleton, boneIndex, view, swingPath, t);
    const blade = readSwungBlade(view, swingPath, holdHand);
    if (blade) overlay.setBlade(blade.base, blade.tip, blade.radius, inActiveWindow);

    // Authored hilt target (world) vs. where the IK actually placed the
    // hand — same over-reach tell the client Swing Inspector surfaces.
    const handPos = readHandWorld(view, holdHand);
    if (handPos) overlay.setHiltGuide(handPos, sampleHiltWorld(swingPath, t));

    overlay.buildArc(swingPath);
  }, [t, skeleton, boneIndex, swingPath, holdHand, inActiveWindow]);

  // Swept-volume bake: only recompute when the toggle/samples/action change
  // (re-poses the rig `sweepSamples` times), then restore the scrub-time
  // pose so the visible skeleton matches the `t` slider again.
  useEffect(() => {
    const overlay = overlayRef.current;
    const view = skeletonView;
    if (!overlay || !view || !skeleton || !boneIndex || !swingPath || totalTicks <= 0) {
      overlay?.clearSweptVolume();
      return;
    }
    if (!showSweep) { overlay.clearSweptVolume(); return; }
    overlay.buildSweptVolume(
      skeleton, boneIndex, view, swingPath, holdHand,
      activeStart, activeEnd, sweepSamples,
    );
    // Restore the scrubbed instant's pose (buildSweptVolume re-posed the rig).
    poseSwingAt(skeleton, boneIndex, view, swingPath, t);
    const blade = readSwungBlade(view, swingPath, holdHand);
    if (blade) overlay.setBlade(blade.base, blade.tip, blade.radius, inActiveWindow);
    // t/inActiveWindow deliberately excluded from deps — the bake only
    // depends on the action + sample settings; scrubbing re-poses via the
    // effect above and shouldn't re-bake all N sweep segments every frame.
  }, [showSweep, sweepSamples, swingPath, activeStart, activeEnd, totalTicks, skeleton, boneIndex, holdHand]);

  if (!skeleton) {
    return <div style={{ padding: 12, color: "var(--bone-dim)", fontSize: 12 }}>
      Pick a skeleton from <code>skeletons/</code> to start.
    </div>;
  }

  return (
    <div style={{ padding: 12, fontSize: 11 }}>
      <div style={{ color: "var(--aether-hi)", fontWeight: 600, marginBottom: 8 }}>Swing sweep</div>

      <div style={{ marginBottom: 10 }}>
        <div style={{ color: "var(--bone-dim)", marginBottom: 3 }}>weapon action</div>
        <select
          value={actionId ?? ""}
          onChange={(e) => pick((e.target as HTMLSelectElement).value)}
          style={selectStyle}
        >
          <option value="" disabled>— pick —</option>
          {actionIds.map((id) => <option key={id} value={id}>{id}</option>)}
        </select>
      </div>

      {actionId && !action && (
        <div style={{ color: "var(--rot)" }}>failed to load "{actionId}"</div>
      )}

      {action && !swingPath && (
        <div style={{ color: "var(--rot)" }}>
          "{action.id}" has no authored <code>swingPath</code> — nothing to sweep
          (clip-driven blade actions aren't in scope for this panel; see T-322).
        </div>
      )}

      {action && swingPath && (
        <>
          <Field label="length">{swingPath.length.toFixed(2)}</Field>
          <Field label="radius">{swingPath.radius.toFixed(3)}</Field>
          <Field label="keyframes">{swingPath.keyframes.length}</Field>
          <Field label="grips">{swingPath.grips?.length ?? "1 (default 1H)"}</Field>
          <Field label="hold bone">{holdHand}</Field>

          <div style={{ margin: "12px 0 4px", color: "var(--bone-dim)" }}>
            scrub t = {t.toFixed(3)} {inActiveWindow ? <b style={{ color: "#6fcf6f" }}>ACTIVE</b> : null}
          </div>
          <input
            type="range" min={0} max={1} step={0.005} value={t}
            onInput={(e) => setT(parseFloat((e.target as HTMLInputElement).value))}
            style={{ width: "100%" }}
          />
          <div style={{ display: "flex", justifyContent: "space-between", color: "var(--bone-faint)", fontSize: 10, marginTop: 2 }}>
            <span>windup</span>
            <span style={{ color: "#6fcf6f" }}>active [{activeStart.toFixed(2)}–{activeEnd.toFixed(2)}]</span>
            <span>winddown</span>
          </div>

          <div style={{ marginTop: 14 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--bone-dim)" }}>
              <input type="checkbox" checked={showSweep} onChange={(e) => setShowSweep((e.target as HTMLInputElement).checked)} />
              swept volume across active window
            </label>
            {showSweep && (
              <div style={{ marginTop: 6, display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ color: "var(--bone-dim)" }}>samples</span>
                <input
                  type="range" min={2} max={24} step={1} value={sweepSamples}
                  onInput={(e) => setSweepSamples(parseInt((e.target as HTMLInputElement).value, 10))}
                  style={{ flex: 1 }}
                />
                <span style={{ color: "var(--bone)" }}>{sweepSamples}</span>
              </div>
            )}
          </div>

          <div style={{ marginTop: 14, color: "var(--bone-faint)", fontSize: 10, lineHeight: 1.5 }}>
            Blade turns <span style={{ color: "#ee5533" }}>red</span> during the active window — this
            is the same interval weapon_trace's hit sweep runs in. The teal
            marker (when shown) is the authored hilt target vs. where the arm's
            IK actually landed the hand — a visible gap means the arm is
            over-reaching the authored arc for this skeleton.
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
