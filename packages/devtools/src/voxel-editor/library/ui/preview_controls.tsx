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

const LABEL: preact.JSX.CSSProperties = {
  color: "var(--bone-faint)",
  fontSize: "var(--fs-eyebrow)",
  letterSpacing: "var(--ls-eyebrow)",
  textTransform: "uppercase",
  fontFamily: "var(--font-mono)",
  marginRight: 6,
};

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
      flexShrink: 0,
      padding: "var(--s-3) var(--s-4)",
      background: "linear-gradient(180deg, var(--moss-hi), var(--moss))",
      borderTop: "1px solid var(--line-strong)",
      color: "var(--bone)",
      fontFamily: "var(--font-body)",
      fontSize: "var(--fs-small)",
      display: "flex", flexWrap: "wrap", gap: "var(--s-4)", alignItems: "center",
    }}>
      <div>
        <span style={LABEL}>Prefab</span>
        <select value={prefabId ?? ""}
          onChange={(e) => previewPrefabId.value = (e.target as HTMLSelectElement).value || null}>
          <option value="">— pick —</option>
          {skeletalPrefabs.map((p) => <option key={p.id} value={p.id}>{p.id}</option>)}
        </select>
      </div>

      <div>
        <span style={LABEL}>Held</span>
        <select value={weaponId ?? ""}
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
              class={`btn xs ${isActive ? "is-active" : ""}`}
              style={{ marginRight: 4 }}
              title={`Plays clip "${resolved}"`}
              onClick={() => previewLocomotion.value = name}
            >{name}</button>
          );
        })}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: "var(--s-2)" }}>
        <span style={LABEL}>Speed</span>
        <input type="range" min={0} max={3} step={0.05} value={speed}
          onInput={(e) => previewSpeed.value = parseFloat((e.target as HTMLInputElement).value)}
          style={{ width: 120 }} />
        <span class="num text-dim">{speed.toFixed(2)}×</span>
      </div>

      <div>
        <button class="btn sm" onClick={() => previewPlaying.value = !playing}>
          {playing ? "❚❚ Pause" : "▶ Play"}
        </button>
      </div>

      {weaponId && swingableActions.length > 0 && (
        <div>
          <span style={LABEL}>Action</span>
          {swingableActions.map((a) => (
            <button
              key={a.actionId}
              class={`btn xs ${swing?.weaponActionId === a.actionId ? "is-active" : ""}`}
              style={{ marginRight: 4 }}
              onClick={() => triggerSwing(a.actionId)}
            >▸ {a.actionId}</button>
          ))}
          {swing && (
            <span class="num" style={{ marginLeft: 8, color: "var(--lichen-hi)", fontSize: 10 }}>
              swinging — t={swing.ticksIntoAction.toFixed(1)}/{swing.totalTicks}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
