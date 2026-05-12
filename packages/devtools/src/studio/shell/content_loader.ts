/**
 * Layer B helpers — fetch specific content categories from the dev
 * server. This is where the studio crosses from pure data tools into
 * game-content knowledge: prefabs, weapon actions, state machines,
 * maneuvers. Each helper is independent so Layer-B features can pull
 * only what they need (no full ContentService load required).
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

export interface WeaponActionDef {
  id: string;
  windupTicks?: number;
  activeTicks?: number;
  winddownTicks?: number;
  clipId?: string;
  blade?: WeaponBlade;
  holdHand?: string;
}

export async function loadWeaponAction(id: string): Promise<WeaponActionDef | null> {
  try {
    return await readJson<WeaponActionDef>(`weapon_actions/${id}.json`);
  } catch {
    return null;
  }
}

export interface ManeuverDef {
  id: string;
  duration: number;
  interruptWindows: { fromT: number; toT: number; by: string[] }[];
  tracks: {
    right_hand: { t: number; clip: string }[];
    left_hand:  { t: number; clip: string }[];
    locomotion: { t: number; kind: string; forward?: number; duration?: number }[];
    hitEffects: { tag: string; fromT: number; toT?: number; magnitude: number }[];
  };
  requirements: Record<string, unknown>;
}

export async function listManeuvers(): Promise<ManeuverDef[]> {
  const raw = await readJsonTree<ManeuverDef>("maneuvers");
  return raw.map(({ value }) => value).sort((a, b) => a.id < b.id ? -1 : 1);
}

export interface StateMachineDef {
  id: string;
  layers: {
    id: string;
    output: string;
    mask?: string;
    priority?: number;
    initial: string;
    states: Record<string, unknown>;
    transitions: { from?: string | string[]; to: string; when: string; priority?: number }[];
  }[];
}

export async function loadStateMachine(id: string): Promise<StateMachineDef | null> {
  try {
    return await readJson<StateMachineDef>(`state_machines/${id}.json`);
  } catch {
    return null;
  }
}
