/**
 * Preview controls bar — sits beneath the 3D preview canvas.
 *
 * Drives the four state signals that the preview scene reads:
 *   - previewPrefabId          (which character to mount on the skeleton)
 *   - previewWeaponPrefabId    (held weapon, attached to hand_r)
 *   - previewLocomotion        (idle / walk / crouch / crouch_walk)
 *   - previewSpeed             (multiplier on top of the clip's native rate)
 *   - activeSwing              (one-shot swing trigger)
 */
import type { Prefab, WeaponActionDef } from "@voxim/content";
import type { BrowserContentStore } from "../../content_loader.ts";
import {
  previewPrefabId, previewWeaponPrefabId, previewLocomotion,
  previewSpeed, activeSwing, previewPlaying, type Locomotion,
} from "../inspect_state.ts";

interface Props { content: BrowserContentStore; }

const INPUT: preact.JSX.CSSProperties = {
  background: "#2a2a2a", border: "1px solid #444", color: "#ddd",
  fontFamily: "monospace", fontSize: 11, padding: "3px 6px", borderRadius: 3,
};
const BTN: preact.JSX.CSSProperties = { ...INPUT, cursor: "pointer", padding: "4px 10px" };
const LABEL: preact.JSX.CSSProperties = { color: "#888", fontSize: 10, marginRight: 6 };

const LOCOMOTIONS: Locomotion[] = ["idle", "walk", "crouch", "crouch_walk"];

export function PreviewControls({ content }: Props) {
  const prefabId = previewPrefabId.value;
  const weaponId = previewWeaponPrefabId.value;
  const loc = previewLocomotion.value;
  const speed = previewSpeed.value;
  const swing = activeSwing.value;
  const playing = previewPlaying.value;

  // Skeleton-bearing prefabs only — anything else has no skeleton to preview.
  const skeletalPrefabs: Prefab[] = content.prefabs.values()
    .filter((p) => {
      if (!p.modelId) return false;
      return content.models.get(p.modelId)?.skeletonId !== undefined;
    })
    .sort((a, b) => a.id.localeCompare(b.id));

  // Weapon prefabs — anything declaring a `swingable` component.  Some non-
  // weapon items are swingable (tools), so we don't filter further; the whole
  // set is the "things you could put in someone's hand".
  const weaponPrefabs: Prefab[] = content.prefabs.values()
    .filter((p) => "swingable" in (p.components as Record<string, unknown>))
    .sort((a, b) => a.id.localeCompare(b.id));

  const heldWeapon = weaponId ? content.prefabs.get(weaponId) : null;
  const swingableActions: { actionId: string }[] =
    (heldWeapon?.components as Record<string, unknown>)?.swingable
      ? (((heldWeapon!.components as Record<string, unknown>).swingable) as { actions?: { actionId: string }[] }).actions ?? []
      : [];

  const prefab = prefabId ? content.prefabs.get(prefabId) : null;
  const slotMap = prefab?.animationSlots ?? {};

  function triggerSwing(actionId: string) {
    const wa: WeaponActionDef | null = content.weaponActions.get(actionId);
    if (!wa) return;
    const total = wa.windupTicks + wa.activeTicks + wa.winddownTicks;
    activeSwing.value = { weaponActionId: actionId, ticksIntoAction: 0, totalTicks: total };
  }

  return (
    <div style={{
      flexShrink: 0, padding: "8px 10px", background: "#1a1a1a",
      borderTop: "1px solid #2a2a2a", color: "#ccc", fontFamily: "monospace",
      fontSize: 11, display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center",
    }}>
      <div>
        <span style={LABEL}>Prefab</span>
        <select value={prefabId ?? ""} style={INPUT}
          onChange={(e) => previewPrefabId.value = (e.target as HTMLSelectElement).value || null}>
          <option value="">— pick —</option>
          {skeletalPrefabs.map((p) => <option key={p.id} value={p.id}>{p.id}</option>)}
        </select>
      </div>

      <div>
        <span style={LABEL}>Held</span>
        <select value={weaponId ?? ""} style={INPUT}
          onChange={(e) => previewWeaponPrefabId.value = (e.target as HTMLSelectElement).value || null}>
          <option value="">— none —</option>
          {weaponPrefabs.map((p) => <option key={p.id} value={p.id}>{p.id}</option>)}
        </select>
      </div>

      <div>
        <span style={LABEL}>Locomotion</span>
        {LOCOMOTIONS.map((name) => {
          const resolved = slotMap[name] ?? name;
          const isActive = loc === name;
          return (
            <button
              key={name}
              style={{
                ...BTN,
                background: isActive ? "#2c4a6c" : "#2a2a2a",
                color: isActive ? "#cde" : "#aaa",
                marginRight: 4,
              }}
              title={`Plays clip "${resolved}"`}
              onClick={() => previewLocomotion.value = name}
            >{name}</button>
          );
        })}
      </div>

      <div>
        <span style={LABEL}>Speed</span>
        <input type="range" min={0} max={3} step={0.05} value={speed}
          onInput={(e) => previewSpeed.value = parseFloat((e.target as HTMLInputElement).value)}
          style={{ width: 120 }} />
        <span style={{ marginLeft: 6, color: "#aaa" }}>{speed.toFixed(2)}×</span>
      </div>

      <div>
        <button style={BTN} onClick={() => previewPlaying.value = !playing}>
          {playing ? "❚❚ Pause" : "▶ Play"}
        </button>
      </div>

      {weaponId && swingableActions.length > 0 && (
        <div>
          <span style={LABEL}>Action</span>
          {swingableActions.map((a) => (
            <button
              key={a.actionId}
              style={{ ...BTN, marginRight: 4, background: swing?.weaponActionId === a.actionId ? "#3a4a2a" : "#2a2a2a" }}
              onClick={() => triggerSwing(a.actionId)}
            >▸ {a.actionId}</button>
          ))}
          {swing && (
            <span style={{ marginLeft: 8, color: "#9d9", fontSize: 10 }}>
              swinging — t={swing.ticksIntoAction.toFixed(1)}/{swing.totalTicks}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
