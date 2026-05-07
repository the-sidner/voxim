/**
 * Assign panel — pick a prefab and edit its `animationSlots` map.  Each row
 * is one slot ("idle", "walk", "walk_limp", ...) → clipId on the prefab's
 * skeleton.  Empty slot value = falls back to the slot name as the clip id
 * at runtime (back-compat).
 *
 * Saves the WHOLE prefab JSON back via POST /content/prefabs/...; if you
 * hand-edit the prefab while the devtool has it open, the devtool's save
 * will overwrite your edits.  This is a single-author tool, not multi-user.
 */
import { useState, useEffect } from "preact/hooks";
import type { Prefab, SkeletonDef, AnimationClip, LibraryClipFile } from "@voxim/content";
import type { BrowserContentStore } from "../../content_loader.ts";
import { libraryClips, flashStatus } from "../lib_state.ts";
import { savePrefab } from "../lib_api.ts";

interface Props { content: BrowserContentStore; }

const STANDARD_SLOTS = ["idle", "walk", "walk_limp", "crouch", "crouch_walk", "roll", "death"];

const INPUT: preact.JSX.CSSProperties = {
  background: "#2a2a2a", border: "1px solid #444", color: "#ddd",
  fontFamily: "monospace", fontSize: 11, padding: "3px 6px", borderRadius: 3,
};
const BTN: preact.JSX.CSSProperties = { ...INPUT, cursor: "pointer", padding: "4px 12px" };

export function AssignPanel({ content }: Props) {
  const [prefabId, setPrefabId] = useState<string>("");
  const [relPath, setRelPath] = useState<string>("");
  const [prefab, setPrefab] = useState<Prefab | null>(null);
  const [slots, setSlots] = useState<Record<string, string>>({});
  const [extraSlot, setExtraSlot] = useState<string>("");

  // Filter to prefabs that ultimately reference a skeleton-bearing model.
  const prefabsWithSkeleton: { id: string; relPath: string; skeleton: string }[] = (() => {
    const all = content.getAllPrefabs ? content.getAllPrefabs() : [];
    const out: { id: string; relPath: string; skeleton: string }[] = [];
    for (const p of all) {
      if (!p.modelId) continue;
      const m = content.getModel(p.modelId);
      if (!m?.skeletonId) continue;
      // Best-effort guess: assume prefabs/{id}.json or prefabs/items/{id}.json.
      const guessed = guessPrefabPath(p.id);
      out.push({ id: p.id, relPath: guessed, skeleton: m.skeletonId });
    }
    return out.sort((a, b) => a.id.localeCompare(b.id));
  })();

  const skel: SkeletonDef | null = prefab && prefab.modelId
    ? (content.getModel(prefab.modelId)?.skeletonId
        ? content.getSkeleton(content.getModel(prefab.modelId)!.skeletonId!)
        : null)
    : null;

  const availableClips: AnimationClip[] = (() => {
    if (!skel) return [];
    const inline = skel.clips ?? [];
    const lib = libraryClips.value.filter((c) => c._skeleton === skel.id) as unknown as AnimationClip[];
    const seen = new Set<string>();
    const all: AnimationClip[] = [];
    for (const c of [...lib, ...inline]) {
      if (!seen.has(c.id)) { seen.add(c.id); all.push(c); }
    }
    return all;
  })();

  // When a different prefab is picked, fetch its current JSON so we save the
  // whole file (not just the slot map — we don't want to drop fields we
  // don't render).
  useEffect(() => {
    if (!prefabId) { setPrefab(null); return; }
    const meta = prefabsWithSkeleton.find((p) => p.id === prefabId);
    if (!meta) return;
    setRelPath(meta.relPath);
    fetch(`/content/prefabs/${meta.relPath}`)
      .then((r) => r.ok ? r.json() : null)
      .then((p) => {
        const pre = p as Prefab | null;
        setPrefab(pre);
        setSlots(pre?.animationSlots ?? {});
      })
      .catch((err) => flashStatus("err", `prefab load failed: ${err.message}`));
  }, [prefabId]);

  async function doSave() {
    if (!prefab || !relPath) return;
    const next: Prefab = {
      ...prefab,
      animationSlots: Object.fromEntries(
        Object.entries(slots).filter(([, v]) => v.trim() !== ""),
      ),
    };
    if (Object.keys(next.animationSlots ?? {}).length === 0) {
      // Drop the field entirely if empty — cleaner JSON.
      delete next.animationSlots;
    }
    try {
      await savePrefab(relPath, next);
      flashStatus("ok", `saved ${prefab.id} (${Object.keys(next.animationSlots ?? {}).length} slots)`);
    } catch (err) {
      flashStatus("err", `save failed: ${(err as Error).message}`);
    }
  }

  const allSlotNames = [...new Set([...STANDARD_SLOTS, ...Object.keys(slots)])];

  return (
    <div>
      <h3 style={{ margin: "0 0 8px", fontSize: 12, color: "#aaa" }}>Assign clips to a prefab</h3>

      <Row label="Prefab">
        <select value={prefabId} onChange={(e) => setPrefabId((e.target as HTMLSelectElement).value)} style={{ ...INPUT, width: 260 }}>
          <option value="">— pick —</option>
          {prefabsWithSkeleton.map((p) => (
            <option key={p.id} value={p.id}>{p.id} ({p.skeleton})</option>
          ))}
        </select>
      </Row>

      {prefab && skel && (
        <>
          <p style={{ color: "#777", fontSize: 11, margin: "8px 0" }}>
            Skeleton: <span style={{ color: "#aaa" }}>{skel.id}</span> —
            {availableClips.length} clips available (inline + library).  Empty slot
            value falls back to the slot name as the clip id.
          </p>

          <table style={{ borderCollapse: "collapse", marginTop: 8 }}>
            <thead>
              <tr style={{ color: "#888", fontSize: 10, textAlign: "left" }}>
                <th style={{ padding: "2px 8px" }}>Slot</th>
                <th style={{ padding: "2px 8px" }}>Clip</th>
              </tr>
            </thead>
            <tbody>
              {allSlotNames.map((s) => (
                <tr key={s}>
                  <td style={{ padding: "2px 8px", color: "#bbb" }}>{s}</td>
                  <td style={{ padding: "2px 8px" }}>
                    <select
                      value={slots[s] ?? ""}
                      onChange={(e) => setSlots({ ...slots, [s]: (e.target as HTMLSelectElement).value })}
                      style={INPUT}
                    >
                      <option value="">— default ({s}) —</option>
                      {availableClips.map((c) => <option key={c.id} value={c.id}>{c.id}</option>)}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div style={{ display: "flex", alignItems: "center", marginTop: 10, gap: 6 }}>
            <input
              value={extraSlot}
              onInput={(e) => setExtraSlot((e.target as HTMLInputElement).value)}
              placeholder="custom slot name"
              style={{ ...INPUT, width: 180 }}
            />
            <button style={BTN} onClick={() => {
              const s = extraSlot.trim();
              if (!s || s in slots) return;
              setSlots({ ...slots, [s]: "" });
              setExtraSlot("");
            }}>Add slot</button>
          </div>

          <div style={{ marginTop: 14 }}>
            <button style={BTN} onClick={doSave}>Save prefab</button>
          </div>
        </>
      )}
    </div>
  );
}

function guessPrefabPath(prefabId: string): string {
  // We don't ship a prefab → file map; the loader scans a tree.  Fortunately
  // the convention is `prefabs/{id}.json` for top-level prefabs and
  // `prefabs/items/{id}.json` for items.  Try a couple of known buckets;
  // worst case the user sees a 404 and we ship a smarter resolver later.
  // Heuristic: if it looks like an item id (matches a common item suffix or
  // has no underscore prefix), put under items/.
  const ITEM_HINTS = ["sword", "axe", "bow", "spear", "crossbow", "ingot", "ore", "fiber",
                      "cloth", "string", "stave", "head", "hammer", "pickaxe", "stone",
                      "coal", "berries", "tunic", "boots"];
  const lower = prefabId.toLowerCase();
  if (ITEM_HINTS.some((h) => lower.includes(h))) return `items/${prefabId}.json`;
  return `${prefabId}.json`;
}

function Row({ label, children }: { label: string; children: preact.ComponentChildren }) {
  return (
    <div style={{ display: "flex", alignItems: "center", marginBottom: 8, gap: 8 }}>
      <label style={{ width: 160, color: "#888", fontSize: 11 }}>{label}</label>
      {children}
    </div>
  );
}
