/**
 * Entity spawning — the single path from a Prefab to a live world entity.
 *
 * `spawnPrefab(world, content, prefabId, overrides)` is the only public entry
 * point. For every key in `prefab.components`:
 *   - If the key matches a compound-archetype installer (player, npc,
 *     resourceNode) its installer runs; these expand into multiple component
 *     writes and may consult overrides, templates, or config.
 *   - Otherwise the key is looked up in `DEF_BY_NAME`. The component's
 *     default is merged with the prefab data and written directly.
 *   - Unknown keys throw — the content loader should have caught them at
 *     startup, this is the last line of defence.
 *
 * Blueprints are ordinary prefabs (data/prefabs/wood_wall.json etc.);
 * PlacementSystem spawns them via spawnPrefab and patches in the cell
 * coordinates once the placement is validated.
 */
import type { World, EntityId, ComponentDef } from "@voxim/engine";
import { newEntityId } from "@voxim/engine";
import {
  Position,
  Velocity,
  Facing,
  InputState,
  Health,
  Hunger,
  Thirst,
  Stamina,
  ModelRef,
  AnimationState,
  Name,
} from "./components/game.ts";
import { NpcTag, NpcJobQueue } from "./components/npcs.ts";
import { AnimationSlots } from "./components/animation_slots.ts";
import { Inventory, CraftingQueue, ItemData } from "./components/items.ts";
import { Equipment } from "./components/equipment.ts";
import { Heritage } from "./components/heritage.ts";
import type { HeritageData, EquipmentData, InventoryData } from "@voxim/codecs";
import { maxHealthFor } from "./account_client.ts";
import { ResourceNode } from "./components/resource_node.ts";
import { Blueprint, WorkstationTag } from "./components/building.ts";
import { CorruptionExposure, SpeedModifier, EncumbrancePenalty } from "./components/world.ts";
import { LoreLoadout, ActiveEffects } from "./components/lore_loadout.ts";
import { FogState } from "./components/fog_state.ts";
import { Hitbox } from "./components/hitbox.ts";
import { Stats } from "./components/instance.ts";
import type {
  ContentStore,
  Prefab,
  PrefabResourceNodeData,
  PrefabNpcData,
  PrefabPlayerData,
} from "@voxim/content";
import { applyHitboxTemplate } from "@voxim/content";
import { DEF_BY_NAME } from "./component_registry.ts";

// ---- small helpers ----

function writeDefault<T>(world: World, id: EntityId, def: ComponentDef<T>): void {
  world.write(id, def, def.default());
}

// deno-lint-ignore no-explicit-any
function writeDefaults(world: World, id: EntityId, ...defs: ComponentDef<any>[]): void {
  for (const def of defs) writeDefault(world, id, def);
}

function emptyEquipment(): EquipmentData {
  return {
    weapon: null, offHand: null, head: null,
    chest: null, legs: null, feet: null, back: null,
  };
}

/**
 * Create an item entity with no Position (it lives in an equipment slot, not the world).
 * Returns an EquipmentSlot carrying both the new EntityId and the prefabId.
 */
function spawnEquipEntity(world: World, prefabId: string): import("@voxim/codecs").EquipmentSlot {
  const entityId = newEntityId();
  world.create(entityId);
  world.write(entityId, ItemData, { prefabId, quantity: 1 });
  return { entityId, prefabId };
}

// ---- compound archetype installers ----
//
// These keys in `prefab.components` fan out to several engine components at
// spawn, or need runtime inputs the prefab can't know about (heritage,
// NpcTemplate, overrides). A direct-write in the generic loop is insufficient,
// so they live here and short-circuit the generic dispatch.

type CompoundInstaller = (
  world: World,
  content: ContentStore,
  id: EntityId,
  prefab: Prefab,
  data: unknown,
  overrides: SpawnPrefabOverrides,
) => void;

/** Player: Heritage-derived Health + declared starter loadout + survival defaults. */
const installPlayer: CompoundInstaller = (world, content, id, _prefab, rawData, overrides) => {
  const data = rawData as PrefabPlayerData;
  const heritage = overrides.heritage ?? {
    dynastyId: newEntityId(),
    generation: 0,
    traits: [],
  };
  const maxHealth = maxHealthFor(heritage);

  writeDefaults(world, id, Velocity, Facing, InputState, EncumbrancePenalty);
  world.write(id, SpeedModifier, { multiplier: 1.0 });
  world.write(id, Health, { current: maxHealth, max: maxHealth });
  world.write(id, Heritage, heritage);

  const capacity = content.getGameConfig().player.inventoryCapacity;
  const slots: InventoryData["slots"] = data.startingInventory.map((s) => ({
    kind: "stack" as const, prefabId: s.itemType, quantity: s.quantity,
  }));
  world.write(id, Inventory, { slots, capacity });

  const eq = emptyEquipment();
  for (const [slot, prefabId] of Object.entries(data.startingEquipment ?? {})) {
    if (!prefabId) continue;
    eq[slot as keyof EquipmentData] = spawnEquipEntity(world, prefabId as string);
  }
  world.write(id, Equipment, eq);

  writeDefaults(
    world, id,
    Hunger, Thirst, Stamina, CorruptionExposure,
    LoreLoadout, ActiveEffects, CraftingQueue, AnimationState,
    FogState,
  );
};

/** NPC: NpcTemplate-driven stats + NpcTag + survival defaults. */
const installNpc: CompoundInstaller = (world, content, id, _prefab, rawData, overrides) => {
  const data = rawData as PrefabNpcData;
  const template = content.npcTemplates.get(data.npcType);
  const maxHealth = template?.maxHealth ?? 80;
  const speedMultiplier = template?.speedMultiplier ?? 1.0;

  writeDefaults(world, id, Velocity, Facing, InputState, EncumbrancePenalty);
  world.write(id, SpeedModifier, { multiplier: speedMultiplier });
  world.write(id, Health, { current: maxHealth, max: maxHealth });
  const npcDisplayName = overrides.instanceName ?? template?.displayName ?? data.npcType;
  world.write(id, NpcTag, {
    npcType: data.npcType,
    name: npcDisplayName,
  });
  // Mirror the same string into the networked Name component so the client's
  // floating-name overlay sees NPCs without re-deriving from NpcTag (which is
  // server-only).
  world.write(id, Name, { value: npcDisplayName });

  const eq = emptyEquipment();
  if (template?.weaponItemType) {
    eq.weapon = spawnEquipEntity(world, template.weaponItemType as string);
  }
  world.write(id, Equipment, eq);

  const slots = template?.skillLoadout ?? [null, null, null, null];
  world.write(id, LoreLoadout, {
    skills: slots,
    learnedFragmentIds: [],
    skillCooldowns: slots.map(() => 0),
  });

  writeDefaults(
    world, id,
    Hunger, Thirst, CorruptionExposure,
    NpcJobQueue, AnimationState, ActiveEffects,
  );
};

/** Resource node: the static harvest-behaviour data lives on the prefab; runtime state is derived. */
const installResourceNode: CompoundInstaller = (world, _content, id, prefab, rawData) => {
  const data = rawData as PrefabResourceNodeData;
  world.write(id, ResourceNode, {
    nodeTypeId: prefab.id,
    hitPoints: data.hitPoints,
    depleted: false,
    respawnTicksRemaining: null,
  });
};

const COMPOUND_INSTALLERS: ReadonlyMap<string, CompoundInstaller> = new Map([
  ["player",       installPlayer],
  ["npc",          installNpc],
  ["resourceNode", installResourceNode],
]);

/**
 * Keys consumed by compound installers — exposed so the loader validator can
 * treat them as legal without requiring a corresponding ComponentDef.
 */
export const COMPOUND_ARCHETYPE_KEYS: ReadonlySet<string> = new Set(COMPOUND_INSTALLERS.keys());

// ---- visual shell ----

/**
 * Attach ModelRef + initial Hitbox when the prefab declares a `modelId`.
 *
 * Skeletal models (humans, wolves) get `{ derive: true, parts: [] }` — the
 * HitboxSystem fills parts each tick from the live pose.
 * Non-skeletal models (trees, rocks, props) get `{ derive: false, parts }`
 * derived once at spawn from the rest-pose template — HitboxSystem skips
 * them for the rest of their life.
 *
 * A prefab may override by declaring its own `hitbox` component; the generic
 * direct-write in spawnPrefab runs after this and wins. This function never
 * writes a Hitbox if the prefab already declares one.
 */
function installVisualShell(
  world: World,
  content: ContentStore,
  id: EntityId,
  prefab: Prefab,
  seed: number,
): void {
  if (!prefab.modelId) return;
  const defaultScale = content.getGameConfig().world.defaultEntityScale;
  const entityScale = defaultScale * (prefab.modelScale ?? 1);
  world.write(id, ModelRef, {
    modelId: prefab.modelId,
    scaleX: entityScale, scaleY: entityScale, scaleZ: entityScale,
    seed,
  });

  if ("hitbox" in prefab.components) return;

  const skeleton = content.getSkeletonForModel(prefab.modelId);
  if (skeleton) {
    world.write(id, Hitbox, { derive: true, parts: [] });
    return;
  }

  const template = content.getHitboxTemplate(prefab.modelId, seed, entityScale);
  const parts = applyHitboxTemplate(template, new Map());
  world.write(id, Hitbox, { derive: false, parts });
}

// ---- spawnPrefab ----

export interface SpawnPrefabOverrides {
  /** Pre-allocated entity id. Used for players, whose id comes from the account service. */
  id?: EntityId;
  x?: number;
  y?: number;
  z?: number;
  /** Per-spawn visual variation (morph params, pool selection). Defaults to 0. */
  seed?: number;
  /**
   * Initial facing angle (radians, around world Y). Used to give static
   * props like trees / rocks per-instance rotation so a forest of one
   * prefab doesn't read as a regimented grid. Defaults to 0.
   */
  facing?: number;
  /** Heritage record applied by the player installer. Absent = default-lineage player. */
  heritage?: HeritageData;
  /** Display-name override applied by the npc installer to NpcTag.name. */
  instanceName?: string;
}

/**
 * Spawn a world entity from a prefab id.
 *
 * Walks `prefab.components` once: compound archetype keys fan out through
 * their installer; other keys are looked up in `DEF_BY_NAME` and written
 * directly with their default merged in for omitted fields.
 *
 * Throws if the prefab id is unknown, if the prefab is abstract (id starts
 * with `_`), or if any component name is not registered.
 */
export function spawnPrefab(
  world: World,
  content: ContentStore,
  prefabId: string,
  overrides: SpawnPrefabOverrides = {},
): EntityId {
  const prefab = content.prefabs.get(prefabId);
  if (!prefab) throw new Error(`spawnPrefab: unknown prefab '${prefabId}'`);
  if (prefab.id.startsWith("_")) {
    throw new Error(`spawnPrefab: '${prefab.id}' is abstract and cannot be spawned directly`);
  }

  const id = overrides.id ?? newEntityId();
  const x = overrides.x ?? 256;
  const y = overrides.y ?? 256;
  const z = overrides.z ?? 4.0;
  const seed = overrides.seed ?? 0;

  world.create(id);
  world.write(id, Position, { x, y, z });
  if (overrides.facing !== undefined) {
    world.write(id, Facing, { angle: overrides.facing });
  }
  installVisualShell(world, content, id, prefab, seed);

  // Per-prefab animation slot map — copied onto the entity so AnimationSystem
  // can pick clips per-prefab without walking back through the prefab table.
  // Only written when the prefab declares slots; absence is the back-compat
  // path where AnimationSystem falls back to the slot name as the clip id.
  if (prefab.animationSlots && Object.keys(prefab.animationSlots).length > 0) {
    world.write(id, AnimationSlots, { slots: { ...prefab.animationSlots } });
  }

  // Raw-material stats live on the prefab and are copied onto the entity at
  // spawn so subsequent recipes (and the future Stats UI) read them uniformly
  // — same component shape regardless of whether the item was gathered or
  // crafted. Crafted items get their stats written by the crafting system at
  // recipe completion (T-124).
  if (prefab.stats !== undefined) {
    world.write(id, Stats, { ...prefab.stats });
  }

  for (const [name, data] of Object.entries(prefab.components)) {
    const compound = COMPOUND_INSTALLERS.get(name);
    if (compound) {
      compound(world, content, id, prefab, data, overrides);
      continue;
    }
    const def = DEF_BY_NAME.get(name);
    if (!def) {
      throw new Error(`spawnPrefab '${prefab.id}': unknown component '${name}'`);
    }
    const merged = { ...def.default(), ...(data as Record<string, unknown>) };
    world.write(id, def, merged);
  }

  return id;
}

// ---- ground-stack drops --------------------------------------------------

/**
 * Spawn a stackable item entity at a world position — used by every "drop
 * something to the ground" path (manual drop_item, gather yields, terrain
 * dig drops, stackable crafting outputs).
 *
 * Equivalent to a stripped-down spawnPrefab that installs ONLY:
 *   - Position
 *   - ItemData { prefabId, quantity }   — the stack identity
 *   - ModelRef + Hitbox (via installVisualShell)  — so the client renders
 *     the actual prefab model instead of falling back to the placeholder
 *     cylinder.
 *
 * Notably skipped: equippable / swingable / tool / etc. The dropped stack
 * is just a pickable thing in the world, not a wieldable one.
 */
/**
 * Optional ejection parameters for spawnGroundStack.
 *
 * `from`: world position to push the drop AWAY from (typically the source
 * entity's centre). The horizontal launch direction is normalized
 * (pos − from); when degenerate (drop spawned at the source centre) a
 * random direction is picked so the drop still flies somewhere visible.
 *
 * `speed` defaults: 4 m/s horizontal, 4 m/s upward — combined with the
 * default world gravity (~20 m/s²) that lands the drop ~1.5 cells away
 * after a ~0.4 s arc.  ItemPhysicsSystem then snaps the landing cell
 * via findFreeDropCell so the final resting spot is always clickable.
 */
export interface DropEjection {
  from: { x: number; y: number };
  horizontalSpeed?: number;
  verticalSpeed?: number;
  /** Random angular jitter (radians) added to the launch direction. */
  spreadRad?: number;
}

export function spawnGroundStack(
  world: World,
  content: ContentStore,
  prefabId: string,
  quantity: number,
  pos: { x: number; y: number; z: number },
  eject?: DropEjection,
): EntityId {
  const id = newEntityId();
  world.create(id);

  if (eject) {
    // In-flight: spawn at the source point and add Velocity.  ItemPhysicsSystem
    // will integrate, settle on terrain contact, and snap to a free cell.
    world.write(id, Position, pos);
    world.write(id, Velocity, computeEjectionVelocity(pos, eject));
  } else {
    // No physics: snap directly to a free cell at spawn time.
    const free = findFreeDropCell(world, pos.x, pos.y, pos.z);
    world.write(id, Position, free);
  }

  world.write(id, ItemData, { prefabId, quantity });
  const prefab = content.prefabs.get(prefabId);
  if (prefab) installVisualShell(world, content, id, prefab, 0);
  return id;
}

function computeEjectionVelocity(
  pos: { x: number; y: number; z: number },
  eject: DropEjection,
): { x: number; y: number; z: number } {
  const dx = pos.x - eject.from.x;
  const dy = pos.y - eject.from.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  let nx: number, ny: number;
  if (len < 0.01) {
    // Degenerate — pick a random horizontal direction.
    const a = Math.random() * Math.PI * 2;
    nx = Math.cos(a);
    ny = Math.sin(a);
  } else {
    nx = dx / len;
    ny = dy / len;
  }
  // Apply optional angular jitter so multiple yields from one node fan out.
  const spread = eject.spreadRad ?? 0;
  if (spread > 0) {
    const a = (Math.random() - 0.5) * spread;
    const cos = Math.cos(a), sin = Math.sin(a);
    const rx = nx * cos - ny * sin;
    const ry = nx * sin + ny * cos;
    nx = rx; ny = ry;
  }
  const hSpeed = eject.horizontalSpeed ?? 4.0;
  const vSpeed = eject.verticalSpeed   ?? 4.0;
  return { x: nx * hSpeed, y: ny * hSpeed, z: vSpeed };
}

/**
 * Pick a cell whose centre is free of resource nodes, blueprints,
 * workstations, and other ground items so a freshly spawned drop is
 * actually clickable.  Walks an expanding ring around floor(x, y);
 * returns the first cell whose centre has no occupant within the cell
 * bounds.  Falls back to the original position when nothing is free
 * inside the search radius (rare; only happens in extreme clutter).
 *
 * Z is preserved — drops sit at the supplied terrain height.
 */
export function findFreeDropCell(
  world: World,
  x: number,
  y: number,
  z: number,
): { x: number; y: number; z: number } {
  const startCx = Math.floor(x);
  const startCy = Math.floor(y);
  const occupied = collectOccupiedCells(world, startCx, startCy, DROP_SEARCH_RADIUS);

  // Walk the candidate cells in expanding-ring order so drops favour the
  // closest free spot to the source.
  for (const [cx, cy] of cellsByDistance(startCx, startCy, DROP_SEARCH_RADIUS)) {
    const key = cellKey(cx, cy);
    if (occupied.has(key)) continue;
    return { x: cx + 0.5, y: cy + 0.5, z };
  }
  return { x, y, z };
}

const DROP_SEARCH_RADIUS = 3;  // cells; an 8-direction spiral up to 3 cells out (~49 cells).

function cellKey(cx: number, cy: number): string {
  return `${cx},${cy}`;
}

function collectOccupiedCells(
  world: World,
  centerCx: number,
  centerCy: number,
  radius: number,
): Set<string> {
  const out = new Set<string>();
  const minCx = centerCx - radius, maxCx = centerCx + radius;
  const minCy = centerCy - radius, maxCy = centerCy + radius;

  // One Position query covers everything we care about; we filter in TS.
  // Smallest-component-set scan in @voxim/engine keeps this O(matches),
  // not O(all entities).
  const tag = (id: EntityId): boolean =>
    world.has(id, ItemData) ||
    world.has(id, ResourceNode) ||
    world.has(id, Blueprint) ||
    world.has(id, WorkstationTag);

  for (const { entityId, position } of world.query(Position)) {
    const cx = Math.floor(position.x);
    const cy = Math.floor(position.y);
    if (cx < minCx || cx > maxCx || cy < minCy || cy > maxCy) continue;
    if (!tag(entityId)) continue;
    out.add(cellKey(cx, cy));
  }
  return out;
}

/**
 * Yield (cx, cy) coordinates in expanding-ring order around (centerCx, centerCy):
 * the centre cell first, then the 8 neighbours, then the 16 cells in ring 2,
 * etc., up to `radius`.  Within a ring the order is deterministic but
 * arbitrary (clockwise from the +x axis is fine).
 */
function* cellsByDistance(
  centerCx: number,
  centerCy: number,
  radius: number,
): Generator<[number, number]> {
  yield [centerCx, centerCy];
  for (let r = 1; r <= radius; r++) {
    // Top + bottom edges (full width including corners)
    for (let dx = -r; dx <= r; dx++) {
      yield [centerCx + dx, centerCy - r];
      yield [centerCx + dx, centerCy + r];
    }
    // Left + right edges (excluding corners — already covered above)
    for (let dy = -r + 1; dy <= r - 1; dy++) {
      yield [centerCx - r, centerCy + dy];
      yield [centerCx + r, centerCy + dy];
    }
  }
}

