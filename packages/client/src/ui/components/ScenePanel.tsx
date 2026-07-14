/// <reference lib="dom" />
/**
 * ScenePanel — the scene graph as a tree (T-224, client half).
 *
 * Buildable for the first time as of T-223: the client's entity store gained a
 * parent→children reverse index (`ClientWorld.childrenOf` / `descendants`), so
 * the replicated hierarchy can finally be walked. Before that the client had a
 * flat `Map<entityId, EntityState>` and there was no tree to show.
 *
 *   ┌──────────────────────────────┬───────────────────────────────────────┐
 *   │  521 entities · 318 roots    │  selected entity                      │
 *   │  [search…]         [⟳ live]  │                                       │
 *   ├──────────────────────────────┤  parent → …                           │
 *   │ ▾ ☗ you            019f5db9  │  components:                          │
 *   │   ▾ ⦿ root                   │    position { x: 256, y: 256, z: … }  │
 *   │     ▾ ⦿ torso_lower          │    health   { current: 100, max: … }  │
 *   │       … 17 bones             │                                       │
 *   │       ⚔ stone_axe (hand_r)   │                                       │
 *   └──────────────────────────────┴───────────────────────────────────────┘
 *
 * What it shows is the REPLICATED graph — the same `Parent`/`Bone` edges the
 * server authored. It is deliberately NOT the Three.js scene: those two are
 * different trees on purpose (entities supply structure, content supplies the
 * pose), and a panel that conflated them would hide exactly the bug you would
 * open it to find.
 */
import { useEffect, useState } from "preact/hooks";
import { signal } from "@preact/signals";
import { clientWorld, localPlayerId } from "../client_world_ref.ts";
import type { EntityState } from "../../state/client_world.ts";
import { closePanel } from "../ui_store.ts";
import { Pane, Btn } from "./primitives.tsx";

/** Selected entity id — module-level so it survives re-renders. */
const selectedId = signal<string | null>(null);
/** Expanded node ids. Seeded with the local player on first open. */
const expanded = signal<Set<string>>(new Set());
/** Live refresh on/off — pause to inspect a moving target. */
const live = signal(true);
const query = signal("");

/** Bookkeeping fields on EntityState that are not game components. */
const NON_COMPONENT_KEYS = new Set(["raw", "versions"]);

/** Components whose payload is a big typed array — summarise, never dump. */
const BULK_KEYS = new Set([
  "heightmap", "materialGrid", "openMask", "kindGrid",
  "vegFieldGrid", "surfaceStateGrid", "waterGrid", "cliffGrid",
]);

interface Node {
  id: string;
  label: string;
  glyph: string;
  tint: string;
  childIds: string[];
}

function describe(id: string, e: EntityState, playerId: string | null): Omit<Node, "id" | "childIds"> {
  if (id === playerId) return { label: "you", glyph: "☗", tint: "var(--ember)" };
  if (e.bone) return { label: e.bone.boneId, glyph: "⦿", tint: "var(--aether-dim)" };
  if (e.heightmap) {
    const hm = e.heightmap as unknown as { chunkX?: number; chunkY?: number };
    return { label: `chunk ${hm.chunkX ?? "?"},${hm.chunkY ?? "?"}`, glyph: "▦", tint: "var(--lichen-hi)" };
  }
  const item = e.itemData as unknown as { prefabId?: string } | undefined;
  if (item?.prefabId) return { label: item.prefabId, glyph: "⚔", tint: "var(--ember-warm)" };
  const model = e.modelRef as unknown as { modelId?: string } | undefined;
  if (model?.modelId) return { label: model.modelId, glyph: "◆", tint: "var(--bone)" };
  return { label: "entity", glyph: "·", tint: "var(--bone-dim)" };
}

/** Component names present on an entity, minus bookkeeping fields. */
function componentsOf(e: EntityState): string[] {
  const rec = e as unknown as Record<string, unknown>;
  return Object.keys(rec).filter((k) => !NON_COMPONENT_KEYS.has(k) && rec[k] !== undefined);
}

export function ScenePanel() {
  // ClientWorld is a plain Map, not a signal — poll it. A debug panel is the one
  // place where polling beats threading reactivity through the hot decode path.
  const [, forceTick] = useState(0);
  useEffect(() => {
    const h = setInterval(() => { if (live.value) forceTick((n) => n + 1); }, 400);
    return () => clearInterval(h);
  }, []);

  const world = clientWorld.value;
  const playerId = localPlayerId.value;

  if (!world) {
    return (
      <Pane title="Scene graph" glyph="⌘" onClose={() => closePanel("scene")}>
        <div style={{ padding: 12, color: "var(--bone-dim)" }}>no world yet — join first</div>
      </Pane>
    );
  }

  const all = [...world.entries()];
  const byId = new Map(all);

  // Roots: no parent, or a parent that is not in our AoI (an orphan — show it,
  // flagged, rather than dropping it: a silently vanished subtree is exactly the
  // failure this panel exists to expose).
  const roots: string[] = [];
  for (const [id, e] of all) {
    const p = e.parent?.entityId;
    if (!p || !byId.has(p)) roots.push(id);
  }
  // The player first, then everything else — you almost always want yourself.
  roots.sort((a, b) => (a === playerId ? -1 : b === playerId ? 1 : 0));

  const q = query.value.trim().toLowerCase();
  const matches = (id: string, e: EntityState): boolean => {
    if (!q) return true;
    if (id.toLowerCase().includes(q)) return true;
    const d = describe(id, e, playerId);
    if (d.label.toLowerCase().includes(q)) return true;
    return componentsOf(e).some((c) => c.toLowerCase().includes(q));
  };
  /** A node survives the filter if it or any descendant matches. */
  const subtreeMatches = (id: string): boolean => {
    const e = byId.get(id);
    if (!e) return false;
    if (matches(id, e)) return true;
    return world.childrenOf(id).some(subtreeMatches);
  };

  const boneCount = all.filter(([, e]) => e.bone).length;

  const rows: preact.JSX.Element[] = [];
  const walk = (id: string, depth: number) => {
    const e = byId.get(id);
    if (!e) return;
    if (q && !subtreeMatches(id)) return;

    const kids = world.childrenOf(id);
    const d = describe(id, e, playerId);
    const isOpen = expanded.value.has(id) || (!!q && kids.length > 0);
    const isSel = selectedId.value === id;
    const orphan = !!e.parent?.entityId && !byId.has(e.parent.entityId);

    rows.push(
      <div
        key={id}
        onClick={() => { selectedId.value = id; }}
        style={{
          display: "flex", alignItems: "center", gap: 6,
          padding: "1px 4px", paddingLeft: 4 + depth * 12,
          cursor: "pointer", whiteSpace: "nowrap",
          background: isSel ? "var(--peat-solid)" : "transparent",
          fontFamily: "var(--font-mono)", fontSize: "var(--fs-small)",
        }}
      >
        <span
          onClick={(ev) => {
            ev.stopPropagation();
            const next = new Set(expanded.value);
            if (next.has(id)) next.delete(id); else next.add(id);
            expanded.value = next;
          }}
          style={{ width: 10, color: "var(--bone-dim)", visibility: kids.length ? "visible" : "hidden" }}
        >
          {isOpen ? "▾" : "▸"}
        </span>
        <span style={{ color: d.tint }}>{d.glyph}</span>
        <span style={{ color: isSel ? "var(--bone)" : "var(--bone-dim)" }}>{d.label}</span>
        {orphan && <span title="parent not in AoI" style={{ color: "var(--ember)" }}>⚠</span>}
        {kids.length > 0 && <span style={{ color: "var(--bone-faint, var(--bone-dim))" }}>({kids.length})</span>}
        <span style={{ marginLeft: "auto", color: "var(--bone-faint, var(--bone-dim))", opacity: 0.5 }}>
          {id.slice(0, 6)}
        </span>
      </div>,
    );
    if (isOpen) for (const k of kids) walk(k, depth + 1);
  };
  for (const r of roots) walk(r, 0);

  const sel = selectedId.value ? byId.get(selectedId.value) : undefined;

  return (
    <Pane title="Scene graph" glyph="⌘" onClose={() => closePanel("scene")}>
      <div style={{ display: "flex", flexDirection: "column", height: "60vh", width: "62vw", minWidth: 640 }}>
        {/* header */}
        <div style={{
          display: "flex", alignItems: "center", gap: 8, padding: "4px 6px",
          borderBottom: "1px solid var(--line)", fontSize: "var(--fs-small)",
          fontFamily: "var(--font-mono)", color: "var(--bone-dim)",
        }}>
          <span>{all.length} entities</span>
          <span>· {roots.length} roots</span>
          <span>· {boneCount} bones</span>
          <input
            value={query.value}
            onInput={(ev) => { query.value = (ev.target as HTMLInputElement).value; }}
            placeholder="filter id / name / component…"
            style={{
              marginLeft: "auto", width: 220,
              background: "var(--peat-solid)", border: "1px solid var(--line)",
              color: "var(--bone)", padding: "2px 6px",
              fontSize: "var(--fs-small)", fontFamily: "var(--font-mono)",
            }}
          />
          <Btn active={live.value} onClick={() => { live.value = !live.value; }}>
            {live.value ? "⟳ live" : "⏸ paused"}
          </Btn>
          <Btn
            onClick={() => {
              // Expand the whole chain down to the local player — the one path
              // you always want open, and 17 bones deep to reach by hand.
              if (!playerId) return;
              const next = new Set(expanded.value);
              next.add(playerId);
              for (const d of world.descendants(playerId)) next.add(d);
              expanded.value = next;
              selectedId.value = playerId;
            }}
          >
            ☗ reveal me
          </Btn>
        </div>

        <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
          {/* tree */}
          <div style={{ flex: "0 0 55%", overflow: "auto", borderRight: "1px solid var(--line)" }}>
            {rows.length ? rows : (
              <div style={{ padding: 12, color: "var(--bone-dim)" }}>nothing matches “{q}”</div>
            )}
          </div>

          {/* detail */}
          <div style={{ flex: 1, overflow: "auto", padding: "6px 8px", fontFamily: "var(--font-mono)", fontSize: "var(--fs-small)" }}>
            {!sel || !selectedId.value ? (
              <div style={{ color: "var(--bone-dim)" }}>select a node</div>
            ) : (
              <EntityDetail id={selectedId.value} e={sel} byId={byId} playerId={playerId} />
            )}
          </div>
        </div>
      </div>
    </Pane>
  );
}

function EntityDetail({ id, e, byId, playerId }: {
  id: string;
  e: EntityState;
  byId: Map<string, EntityState>;
  playerId: string | null;
}) {
  const parentId = e.parent?.entityId ?? null;
  const parent = parentId ? byId.get(parentId) : undefined;

  return (
    <div>
      <div style={{ color: "var(--bone)", marginBottom: 2 }}>{describe(id, e, playerId).label}</div>
      <div style={{ color: "var(--bone-dim)", opacity: 0.7, marginBottom: 8, wordBreak: "break-all" }}>{id}</div>

      <div style={{ color: "var(--bone-dim)", marginBottom: 8 }}>
        parent:{" "}
        {parentId
          ? (
            <span
              style={{ color: parent ? "var(--aether-dim)" : "var(--ember)", cursor: parent ? "pointer" : "default" }}
              onClick={() => { if (parent) selectedId.value = parentId; }}
            >
              {parent ? describe(parentId, parent, playerId).label : `${parentId.slice(0, 8)} (not in AoI)`}
            </span>
          )
          : <span style={{ opacity: 0.6 }}>— root</span>}
      </div>

      {componentsOf(e).map((name) => {
        const v = (e as unknown as Record<string, unknown>)[name];
        const bulk = BULK_KEYS.has(name);
        let body: string;
        if (bulk) {
          const cells = (v as { cells?: ArrayLike<number> })?.cells;
          body = cells ? `⟨${cells.length} cells⟩` : "⟨grid⟩";
        } else {
          try {
            body = JSON.stringify(v, null, 1);
            if (body.length > 800) body = body.slice(0, 800) + " …";
          } catch {
            body = String(v);
          }
        }
        return (
          <div key={name} style={{ marginBottom: 6 }}>
            <div style={{ color: "var(--lichen-hi)" }}>{name}</div>
            <pre style={{
              margin: 0, color: "var(--bone-dim)", whiteSpace: "pre-wrap",
              wordBreak: "break-all", opacity: 0.85,
            }}>{body}</pre>
          </div>
        );
      })}
    </div>
  );
}
