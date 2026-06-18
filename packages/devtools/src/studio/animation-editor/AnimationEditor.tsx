/// <reference lib="dom" />
/**
 * Animation editor — Layer A. Pick a skeleton + an animation clip
 * (from the same archetype's library), play it on the rendered
 * bones. Multi-layer playback + maneuver driver + equipment overlay
 * come in T-191c next iteration / T-191d.
 *
 * Today's surface:
 *   left  — file pick (skeletons/ + anim_library/), then a clip list
 *           filtered to the picked skeleton's archetype.
 *   centre — bone skeleton view, posed per render frame.
 *   right — clip details + play / pause / loop / scrub / speed.
 *
 * Pure data tooling: no game content. Imports only file IO + the
 * local Three.js shell.
 */
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { Layout } from "../shell/Layout.tsx";
import { AssetBrowser } from "../shell/AssetBrowser.tsx";
import { ViewportPane } from "../shell/ViewportPane.tsx";
import { listDir, readJson } from "../shell/file_io.ts";
import type { Viewport } from "../shell/viewport.ts";
import { buildSkeletonView, type SkeletonView, type BoneLike } from "./skeleton_view.ts";
import { sampleClipAtTime, type ClipLike } from "./clip_sampler.ts";
import { EquipmentPanel, type SlotState } from "./EquipmentPanel.tsx";
import { ManeuverPanel, type ManeuverTick } from "./ManeuverPanel.tsx";
import { attachEquipment, type AttachedEquipment } from "./equip_attach.ts";
import { loadWeaponAction, type PrefabSummary } from "../shell/content_loader.ts";
import type { MaterialDef } from "../voxel-editor/model_types.ts";

// state_machines/ kept in the dir list as legacy content; the SM-driver tab
// was removed with the CSM (T-228) — see T-268 for the broader studio de-drift.
const ANIM_DIRS = ["skeletons", "anim_library", "maneuvers", "weapon_actions", "clip_overrides"];

type RightTab = "clip" | "equipment" | "maneuver";

interface Skeleton {
  id: string;
  archetype: string;
  bones: BoneLike[];
}

interface Clip extends ClipLike {
  id: string;
}

export function AnimationEditor() {
  const [skeleton, setSkeleton] = useState<Skeleton | null>(null);
  const [clipList, setClipList] = useState<string[]>([]);  // clip ids in current archetype
  const [clip, setClip]         = useState<Clip | null>(null);
  const [time, setTime]         = useState(0);             // normalized [0..1]
  const [playing, setPlaying]   = useState(false);
  const [speed, setSpeed]       = useState(1);
  const [loopOverride, setLoopOverride] = useState<boolean | null>(null);

  const viewportRef = useRef<Viewport | null>(null);
  const skViewRef   = useRef<SkeletonView | null>(null);

  // ── Layer B: equipment overlay ──────────────────────────────────────
  const [rightTab, setRightTab] = useState<RightTab>("clip");
  const [slots, setSlots]       = useState<SlotState>({ weapon: null, offHand: null });
  const [materials, setMaterials] = useState<Map<number, MaterialDef>>(new Map());
  const equippedRef = useRef<{ weapon: AttachedEquipment | null; offHand: AttachedEquipment | null }>({
    weapon: null, offHand: null,
  });
  // Per-prefab slot map used to resolve "$weapon.swing_clip" etc. We
  // pull this from the actor prefab the user picked (defaults to
  // _playable_character).
  const slotMapRef = useRef<Record<string, string>>({});
  useEffect(() => {
    (async () => {
      try {
        const pc = await readJson<{ animationSlots?: Record<string, string> }>("prefabs/_base/playable_character.json");
        slotMapRef.current = pc.animationSlots ?? {};
      } catch { /* leave default */ }
    })();
  }, []);

  // Materials load (same as voxel editor — needed for held weapon colours).
  useEffect(() => {
    (async () => {
      try {
        const list = await readJson<MaterialDef[]>("materials.json");
        const map = new Map<number, MaterialDef>();
        for (const m of list) map.set(m.id, m);
        setMaterials(map);
      } catch (e) {
        console.warn("anim editor: materials load failed:", e);
      }
    })();
  }, []);

  const effectiveLoop = loopOverride ?? clip?.loop ?? true;

  // Picking files: route by directory to either skeleton or clip load.
  const onPickFile = async (path: string) => {
    if (path.startsWith("skeletons/")) {
      try {
        const sk = await readJson<Skeleton>(path);
        setSkeleton(sk);
        // Reload clip list for the new archetype.
        try {
          const entries = await listDir(`anim_library/${sk.archetype}`);
          setClipList(entries.filter((e) => e.kind === "file").map((e) => e.name.replace(/\.json$/, "")));
        } catch {
          setClipList([]);
        }
        // Drop the active clip (likely from a different archetype).
        setClip(null);
        setTime(0);
        setPlaying(false);
      } catch (e) {
        console.warn("animation editor: skeleton load failed:", e);
      }
      return;
    }
    if (path.startsWith("anim_library/")) {
      try {
        const c = await readJson<Clip>(path);
        setClip(c);
        setTime(0);
        setPlaying(false);
      } catch (e) {
        console.warn("animation editor: clip load failed:", e);
      }
      return;
    }
    // Other dirs (maneuvers/) — picked up later when the maneuver driver lands.
  };

  // Build / rebuild the skeleton view on skeleton change.
  useEffect(() => {
    const vp = viewportRef.current;
    if (!vp || !skeleton) return;
    skViewRef.current?.dispose();
    const view = buildSkeletonView(skeleton.bones, { scale: 1 });
    vp.contentGroup.add(view.group);
    vp.frame(view.bbox, 1.6);
    skViewRef.current = view;
    return () => { view.dispose(); };
  }, [skeleton]);

  // Pose update each render frame while playing.
  useEffect(() => {
    let raf = 0;
    let lastTs = performance.now();
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      const dt = (now - lastTs) / 1000;
      lastTs = now;
      if (playing && clip) {
        const dur = clip.durationSeconds ?? 1;
        const advance = (dt * speed) / dur;
        setTime((t) => {
          let n = t + advance;
          if (effectiveLoop) {
            n = n - Math.floor(n);
          } else if (n >= 1) {
            n = 1;
            // auto-stop at end of non-looped clip
            setPlaying(false);
          }
          return n;
        });
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, clip, speed, effectiveLoop]);

  // Equipment overlay: re-attach when the skeleton view rebuilds or the
  // slot selection changes. We resolve the weapon's primary action to
  // pick up its blade.{baseLocal,tipLocal} — same data the engine
  // renderer uses for in-game attachment, so the studio matches.
  useEffect(() => {
    const view = skViewRef.current;
    if (!view) return;
    let cancelled = false;

    const apply = async (slotKey: "weapon" | "offHand", prefab: PrefabSummary | null) => {
      // Tear down previous
      equippedRef.current[slotKey]?.dispose();
      equippedRef.current[slotKey] = null;
      if (!prefab || !prefab.modelId) return;

      const swingable = prefab.components["swingable"] as
        | { chain?: { light: string; heavy: string }[]; heavyChargeMs?: number }
        | undefined;
      const primaryActionId = swingable?.chain?.[0]?.light;
      const primaryAction = primaryActionId ? await loadWeaponAction(primaryActionId) : null;

      // modelScale lives on the prefab; pull it out of the picked
      // PrefabSummary's full file. PrefabSummary doesn't carry it
      // today — re-fetch the JSON for the scale value.
      let weaponScale = 1.0;
      try {
        const full = await readJson<{ modelScale?: number }>(prefab.path);
        weaponScale = full.modelScale ?? 1.0;
      } catch { /* leave default */ }

      const attached = await attachEquipment(
        prefab.id,
        prefab.modelId,
        view,
        materials,
        {
          holdBone:    slotKey === "weapon" ? "hand_r" : "hand_l",
          weaponScale,
          blade:       primaryAction?.blade,
        },
      );
      if (!cancelled) equippedRef.current[slotKey] = attached;
    };

    apply("weapon",  slots.weapon);
    apply("offHand", slots.offHand);

    return () => { cancelled = true; };
  }, [skeleton, slots, materials]);

  // Push the sampled pose into the skeleton view whenever time/clip
  // changes (manual clip-player mode).
  useEffect(() => {
    const view = skViewRef.current;
    if (!view) return;
    if (!clip) {
      view.applyPose(new Map());     // rest pose
      return;
    }
    const pose = sampleClipAtTime(clip, time);
    view.applyPose(pose);
  }, [time, clip, skeleton, rightTab]);

  // Maneuver pose driver — when the maneuver tab is firing, sample
  // the right_hand track's active clip and apply. (Per-hand masking
  // arrives in T-191d v3; v1 plays the right-hand clip as a whole-body
  // override, which matches what most authored maneuvers expect when
  // both tracks reference the same clip.)
  const onManeuverTick = (t: ManeuverTick) => {
    const view = skViewRef.current;
    if (!view) return;
    const clipId = t.rightClipId || t.leftClipId;
    if (!clipId) { view.applyPose(new Map()); return; }
    loadClipById(clipId, skeleton).then((c) => {
      if (!c) return;
      const dur = c.durationSeconds ?? 1;
      let normT = t.elapsed / dur;
      if (c.loop) normT = normT - Math.floor(normT); else normT = Math.min(1, normT);
      view.applyPose(sampleClipAtTime(c, normT));
    });
  };
  const onManeuverIdle = () => {
    skViewRef.current?.applyPose(new Map());
  };

  const tracksCount = clip ? Object.keys(clip.tracks).length : 0;

  return (
    <Layout
      topBar={
        <div style={{ display: "flex", alignItems: "center", width: "100%", gap: 16 }}>
          <span style={{ color: "var(--bone-dim)", fontSize: 12 }}>
            {skeleton ? `${skeleton.id} (${skeleton.archetype})` : "(no skeleton)"}
          </span>
          <span style={{ color: "var(--bone-ghost)" }}>/</span>
          <span style={{ color: "var(--bone-dim)", fontSize: 12 }}>
            {clip ? `${clip.id} — ${tracksCount} tracks` : "(no clip)"}
          </span>
          <div style={{ flex: 1 }} />
          <button onClick={() => setPlaying((p) => !p)} disabled={!clip} style={btn(playing ? "var(--ember-warm)" : undefined)}>
            {playing ? "Pause" : "Play"}
          </button>
          <button onClick={() => setTime(0)} disabled={!clip} style={btn()}>⏮</button>
          <label style={{ color: "var(--bone-dim)", fontSize: 11 }}>
            <input type="checkbox" checked={effectiveLoop}
              onChange={(e) => setLoopOverride((e.target as HTMLInputElement).checked)} /> loop
          </label>
          <label style={{ color: "var(--bone-dim)", fontSize: 11 }}>
            speed
            <input type="number" value={speed} step={0.1} min={0.05} max={5}
              onInput={(e) => setSpeed(parseFloat((e.target as HTMLInputElement).value) || 1)}
              style={{ ...inputStyle, width: 50, marginLeft: 6 }} />
          </label>
        </div>
      }
      left={
        <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
          <div style={{ flex: 1, overflowY: "auto", borderBottom: "1px solid var(--line-strong)" }}>
            <AssetBrowser filter={ANIM_DIRS} onPickFile={onPickFile} />
          </div>
          {skeleton && (
            <div style={{ flex: 1, overflowY: "auto" }}>
              <div style={{ padding: "6px 10px", color: "var(--bone-dim)", fontSize: 11, borderBottom: "1px solid var(--line-strong)" }}>
                Clips ({clipList.length}) — {skeleton.archetype}
              </div>
              <div style={{ padding: "4px 0" }}>
                {clipList.map((id) => (
                  <div
                    key={id}
                    onClick={() => onPickFile(`anim_library/${skeleton.archetype}/${id}.json`)}
                    style={{
                      cursor: "pointer",
                      padding: "2px 12px",
                      color: clip?.id === id ? "var(--bone-hi)" : "var(--bone)",
                      background: clip?.id === id ? "var(--moss-hov)" : undefined,
                      fontSize: 11,
                    }}
                    onMouseOver={(e) => { if (clip?.id !== id) (e.currentTarget as HTMLElement).style.background = "var(--moss-hov)"; }}
                    onMouseOut={(e)  => { if (clip?.id !== id) (e.currentTarget as HTMLElement).style.background = ""; }}
                  >{id}</div>
                ))}
              </div>
            </div>
          )}
        </div>
      }
      centre={
        <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", minHeight: 0 }}>
          <div style={{ flex: 1, minHeight: 0 }}>
            <ViewportPane onReady={(vp) => { viewportRef.current = vp; }} />
          </div>
          <div style={{
            flex: "0 0 56px",
            display: "flex",
            alignItems: "center",
            padding: "0 14px",
            gap: 10,
            background: "var(--moss)",
            borderTop: "1px solid var(--line-strong)",
            color: "var(--bone-dim)",
            fontSize: 11,
          }}>
            <span style={{ minWidth: 38, color: "var(--bone-dim)" }}>{(time * 100).toFixed(1)}%</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.001}
              value={time}
              onInput={(e) => { setTime(parseFloat((e.target as HTMLInputElement).value)); setPlaying(false); }}
              style={{ flex: 1 }}
              disabled={!clip}
            />
            <span style={{ minWidth: 60, color: "var(--bone-dim)" }}>
              {clip?.durationSeconds ? `${clip.durationSeconds.toFixed(2)}s` : "—"}
            </span>
          </div>
        </div>
      }
      right={
        <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
          <RightTabs current={rightTab} onPick={setRightTab} />
          <div style={{ flex: 1, overflowY: "auto", minHeight: 0 }}>
            {rightTab === "clip"      && <ClipInspector clip={clip} skeleton={skeleton} />}
            {rightTab === "equipment" && <EquipmentPanel slots={slots} onEquip={(slot, prefab) => setSlots((s) => ({ ...s, [slot]: prefab }))} />}
            {rightTab === "maneuver"  && <ManeuverPanel active={rightTab === "maneuver"} onTick={onManeuverTick} onIdle={onManeuverIdle} />}
          </div>
        </div>
      }
    />
  );
}

function RightTabs({ current, onPick }: { current: RightTab; onPick: (t: RightTab) => void }) {
  const tab = (id: RightTab, label: string) => (
    <div
      onClick={() => onPick(id)}
      style={{
        cursor: "pointer",
        padding: "8px 14px",
        fontSize: 11,
        color: current === id ? "var(--bone-hi)" : "var(--bone-dim)",
        background: current === id ? "var(--moss-hov)" : "transparent",
        borderRight: "1px solid var(--line-strong)",
        borderBottom: current === id ? "1px solid var(--moss-hov)" : "1px solid var(--line-strong)",
      }}
    >{label}</div>
  );
  return (
    <div style={{ display: "flex", borderBottom: "1px solid var(--line-strong)", background: "var(--moss)" }}>
      {tab("clip",      "Clip")}
      {tab("equipment", "Equipment")}
      {tab("maneuver",  "Maneuver")}
    </div>
  );
}

/**
 * Best-effort clip loader keyed by clipId — SM driver doesn't know
 * which archetype directory the clip lives in, so we infer from the
 * skeleton's archetype.
 */
const clipCache = new Map<string, Clip | null>();
async function loadClipById(clipId: string, skeleton: Skeleton | null): Promise<Clip | null> {
  if (!skeleton) return null;
  const key = `${skeleton.archetype}/${clipId}`;
  const cached = clipCache.get(key);
  if (cached !== undefined) return cached;
  try {
    const c = await readJson<Clip>(`anim_library/${skeleton.archetype}/${clipId}.json`);
    clipCache.set(key, c);
    return c;
  } catch {
    clipCache.set(key, null);
    return null;
  }
}

function ClipInspector({ clip, skeleton }: { clip: Clip | null; skeleton: Skeleton | null }) {
  if (!skeleton) {
    return <div style={{ padding: 12, color: "var(--bone-dim)", fontSize: 12 }}>
      Pick a skeleton from <code>skeletons/</code> to start.
    </div>;
  }
  if (!clip) {
    return <div style={{ padding: 12, color: "var(--bone-dim)", fontSize: 12 }}>
      Pick a clip from the list on the left.
    </div>;
  }
  const tracks = Object.entries(clip.tracks)
    .map(([bone, kfs]) => ({ bone, count: kfs.length }))
    .sort((a, b) => a.bone < b.bone ? -1 : 1);

  return (
    <div style={{ padding: 12, fontSize: 11 }}>
      <div style={{ color: "var(--aether-hi)", fontWeight: 600, marginBottom: 8 }}>Clip</div>
      <Field label="id">{clip.id}</Field>
      <Field label="loop">{String(clip.loop)}</Field>
      <Field label="duration">{clip.durationSeconds ?? "—"}s</Field>
      <Field label="tracks">{tracks.length}</Field>

      <div style={{ color: "var(--aether-hi)", fontWeight: 600, margin: "14px 0 8px" }}>Per-bone keyframes</div>
      <div style={{
        display: "grid",
        gridTemplateColumns: "1fr auto",
        gap: "2px 8px",
        color: "var(--bone)",
        maxHeight: 360,
        overflowY: "auto",
      }}>
        {tracks.map(({ bone, count }) => (
          <>
            <span style={{ color: skeleton.bones.find((b) => b.id === bone) ? "var(--bone)" : "var(--rot)" }}>
              {bone}
            </span>
            <span style={{ color: "var(--bone-dim)" }}>{count}</span>
          </>
        ))}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: preact.ComponentChildren }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "70px 1fr", gap: 6, marginBottom: 2 }}>
      <span style={{ color: "var(--bone-dim)" }}>{label}</span>
      <span style={{ color: "var(--bone)" }}>{children}</span>
    </div>
  );
}

const inputStyle = {
  background: "var(--bog)",
  border: "1px solid var(--line-strong)",
  color: "var(--bone)",
  borderRadius: 0,
  padding: "2px 4px",
  fontSize: 11,
  fontFamily: "inherit",
  outline: "none",
} as const;

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
