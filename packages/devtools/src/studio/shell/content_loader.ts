/**
 * Layer B helpers — fetch specific content categories from the dev
 * server. This is where the studio crosses from pure data tools into
 * game-content knowledge: prefabs and weapon actions. Each helper is
 * independent so Layer-B features can pull only what they need (no full
 * ContentService load required).
 *
 * Listing helpers walk the per-item directory + optional sub-buckets
 * (e.g. prefabs/items/) the way the engine's JsonSource does, so the
 * results match what spawns in-game.
 */
import { listDir, readJson } from "./file_io.ts";

export interface PrefabSummary {
  id: string;
  path: string;
  modelId?: string;
  category?: string;
  components: Record<string, unknown>;
  extends?: string;
  animationSlots?: Record<string, string>;
}

/** Recursively walk a content dir and parse every .json file. */
async function readJsonTree<T>(dir: string): Promise<{ path: string; value: T }[]> {
  const out: { path: string; value: T }[] = [];
  const entries = await listDir(dir);
  for (const e of entries) {
    const sub = `${dir}/${e.name}`;
    if (e.kind === "directory") {
      out.push(...await readJsonTree<T>(sub));
    } else {
      try {
        out.push({ path: sub, value: await readJson<T>(sub) });
      } catch {
        // skip unparseable
      }
    }
  }
  return out;
}

export async function listPrefabs(): Promise<PrefabSummary[]> {
  const raw = await readJsonTree<{
    id: string;
    modelId?: string;
    category?: string;
    components?: Record<string, unknown>;
    extends?: string;
    animationSlots?: Record<string, string>;
  }>("prefabs");
  return raw.map(({ path, value }) => ({
    id:        value.id,
    path,
    modelId:   value.modelId,
    category:  value.category,
    components: value.components ?? {},
    extends:   value.extends,
    animationSlots: value.animationSlots,
  })).sort((a, b) => a.id < b.id ? -1 : 1);
}

/** Items with an equippable component, grouped by slot. */
export function equippablePrefabs(prefabs: PrefabSummary[]): PrefabSummary[] {
  return prefabs.filter((p) => "equippable" in p.components);
}

/** Resolve inheritance chain — returns the prefab with parent's fields merged. */
export async function resolvePrefab(
  picked: PrefabSummary,
  byId: Map<string, PrefabSummary>,
): Promise<PrefabSummary> {
  let result = picked;
  while (result.extends) {
    const parent = byId.get(result.extends);
    if (!parent) break;
    result = {
      ...parent,
      ...result,
      components:     { ...parent.components, ...result.components },
      animationSlots: { ...(parent.animationSlots ?? {}), ...(result.animationSlots ?? {}) },
    };
    // The merged object now has `extends` from `result` (which is the same we
    // just resolved); strip it to terminate the loop after one parent climb,
    // then re-iterate using the parent's own `extends` if present.
    result = { ...result, extends: parent.extends };
  }
  return result;
}

export interface WeaponBlade {
  baseLocal: [number, number, number];
  tipLocal:  [number, number, number];
  radius?:   number;
}

/** actor-local fwd/right/up, world units — matches content SwingKeyframe's point shape. */
export interface SwingPoint { fwd: number; right: number; up: number }

export interface SwingKeyframe {
  t: number;
  hilt: SwingPoint;
  blade: SwingPoint;
}

export interface SwingGrip {
  bone: string;
  along: number;
  drivesBlade?: boolean;
  poleHint?: SwingPoint;
}

/** Mirrors content's SwingPathDef — the T-307 authored blade arc. */
export interface SwingPath {
  length: number;
  radius: number;
  keyframes: SwingKeyframe[];
  grips?: SwingGrip[];
}

export interface WeaponActionDef {
  id: string;
  windupTicks?: number;
  activeTicks?: number;
  winddownTicks?: number;
  clipId?: string;
  blade?: WeaponBlade;
  holdHand?: string;
  swingPath?: SwingPath;
}

export async function loadWeaponAction(id: string): Promise<WeaponActionDef | null> {
  try {
    return await readJson<WeaponActionDef>(`weapon_actions/${id}.json`);
  } catch {
    return null;
  }
}

// ---- ActionDef (T-327 Phases panel) ----------------------------------------
//
// Mirrors content's ActionDef — the universal action primitive
// (data/actions/*.json), NOT WeaponActionDef above. An ActionDef's phases
// carry TIMING (windup/active/winddown/recovery ticks); WeaponActionDef
// carries GEOMETRY (swingPath). The Phases panel shows the former; the Sweep
// panel (T-322) shows the latter — this loader only pulls the fields the
// timeline needs, not the full effect/gate/animation vocabulary.

export interface ActionPhaseDef {
  /** Duration in ticks; -1 = perpetual (ambient actions only — held, not timed). */
  ticks: number;
}

export interface ActionEffectRef {
  /** "<phaseName>:enter" | "<phaseName>:exit" | "<phaseName>:tick" */
  phase: string;
  kind: string;
  params?: Record<string, unknown>;
}

export interface ActionDefSummary {
  id: string;
  kind: string;
  slot: string;
  /** Declaration order matters — it's the timeline's left-to-right order. */
  phases: Record<string, ActionPhaseDef>;
  hitStopTicks?: number;
  cooldownTicks?: number;
  effects: ActionEffectRef[];
}

export async function loadActionDef(id: string): Promise<ActionDefSummary | null> {
  try {
    return await readJson<ActionDefSummary>(`actions/${id}.json`);
  } catch {
    return null;
  }
}
