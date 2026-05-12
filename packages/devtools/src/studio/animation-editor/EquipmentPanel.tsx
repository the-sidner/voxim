/// <reference lib="dom" />
/**
 * Equipment panel — Layer B. Lists prefabs with an `equippable`
 * component grouped by slot, lets the user pick one for either hand;
 * fires the caller's `onEquip(slot, prefab | null)`.
 *
 * Selection bubbles up; the AnimationEditor performs the actual
 * attach via attachEquipment().
 */
import { useEffect, useState } from "preact/hooks";
import { listPrefabs, equippablePrefabs, type PrefabSummary } from "../shell/content_loader.ts";

export interface SlotState {
  weapon:  PrefabSummary | null;
  offHand: PrefabSummary | null;
}

export function EquipmentPanel({
  slots,
  onEquip,
}: {
  slots: SlotState;
  onEquip: (slot: "weapon" | "offHand", prefab: PrefabSummary | null) => void;
}) {
  const [all, setAll] = useState<PrefabSummary[]>([]);

  useEffect(() => {
    (async () => {
      try {
        const prefabs = await listPrefabs();
        setAll(equippablePrefabs(prefabs));
      } catch (e) {
        console.warn("equipment panel: prefab listing failed:", e);
      }
    })();
  }, []);

  // Bucket by the equippable slot declared on the prefab.
  const byTargetSlot = new Map<string, PrefabSummary[]>();
  for (const p of all) {
    const eq = p.components["equippable"] as { slot?: string } | undefined;
    const target = eq?.slot ?? "?";
    let bucket = byTargetSlot.get(target);
    if (!bucket) { bucket = []; byTargetSlot.set(target, bucket); }
    bucket.push(p);
  }

  return (
    <div style={{ padding: 12, fontSize: 11 }}>
      <div style={{ color: "var(--aether-hi)", fontWeight: 600, marginBottom: 8 }}>Equipment</div>

      <SlotRow
        label="weapon (hand_r)"
        picked={slots.weapon}
        choices={byTargetSlot.get("weapon") ?? []}
        onPick={(p) => onEquip("weapon", p)}
      />
      <SlotRow
        label="offHand (hand_l)"
        picked={slots.offHand}
        choices={[
          ...(byTargetSlot.get("offHand") ?? []),
          // Weapons typically declare slot:"weapon" — allow them in
          // off-hand too so authors can dual-wield. Same workaround
          // the spawner uses at player spawn.
          ...(byTargetSlot.get("weapon") ?? []),
        ]}
        onPick={(p) => onEquip("offHand", p)}
      />

      <div style={{ color: "var(--bone-faint)", marginTop: 12, fontSize: 11, fontStyle: "italic" }}>
        T-191d will also gain a state-machine driver + maneuver picker.
      </div>
    </div>
  );
}

function SlotRow({
  label, picked, choices, onPick,
}: {
  label: string;
  picked: PrefabSummary | null;
  choices: PrefabSummary[];
  onPick: (p: PrefabSummary | null) => void;
}) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ color: "var(--bone-dim)", marginBottom: 4 }}>{label}</div>
      <select
        value={picked?.id ?? ""}
        onChange={(e) => {
          const id = (e.target as HTMLSelectElement).value;
          if (id === "") return onPick(null);
          const p = choices.find((c) => c.id === id);
          if (p) onPick(p);
        }}
        style={{
          background: "var(--bog)",
          border: "1px solid var(--line-strong)",
          color: "var(--bone)",
          borderRadius: 0,
          padding: "3px 6px",
          fontSize: 11,
          fontFamily: "inherit",
          width: "100%",
          outline: "none",
        }}
      >
        <option value="">(none)</option>
        {choices.map((c) => (
          <option key={c.id} value={c.id}>
            {c.id}{c.category ? `  [${c.category}]` : ""}
          </option>
        ))}
      </select>
    </div>
  );
}
