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
 * BuildingSystem spawns them via spawnPrefab and patches in the cell
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
  CombatState,
  ModelRef,
  AnimationState,
} from "./components/game.ts";
import { NpcTag, NpcJobQueue } from "./components/npcs.ts";
import { Inventory, CraftingQueue, InteractCooldown, ItemData } from "./components/items.ts";
import { Equipment } from "./components/equipment.ts";
import { Heritage } from "./components/heritage.ts";
import type { HeritageData, EquipmentData, InventoryData } from "@voxim/codecs";
import { maxHealthFor } from "./account_client.ts";
import { ResourceNode } from "./components/resource_node.ts";
import { CorruptionExposure, SpeedModifier, EncumbrancePenalty } from "./components/world.ts";
import { LoreLoadout, ActiveEffects } from "./components/lore_loadout.ts";
import { Hitbox } from "./components/hitbox.ts";
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
 * Returns the new EntityId (string) for storage in EquipmentData slots.
 */
function spawnEquipEntity(world: World, prefabId: string): EntityId {
  const id = newEntityId();
  world.create(id);
  world.write(id, ItemData, { prefabId, quantity: 1 });
  return id;
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
    eq[slot as keyof EquipmentData] = spawnEquipEntity(world, prefabId);
  }
  world.write(id, Equipment, eq);

  writeDefaults(
    world, id,
    Hunger, Thirst, CombatState, Stamina, CorruptionExposure,
    LoreLoadout, ActiveEffects, CraftingQueue, InteractCooldown, AnimationState,
  );
};

/** NPC: NpcTemplate-driven stats + NpcTag + survival defaults. */
const installNpc: CompoundInstaller = (world, content, id, _prefab, rawData, overrides) => {
  const data = rawData as PrefabNpcData;
  const template = content.getNpcTemplate(data.npcType);
  const maxHealth = template?.maxHealth ?? 80;
  const speedMultiplier = template?.speedMultiplier ?? 1.0;

  writeDefaults(world, id, Velocity, Facing, InputState, EncumbrancePenalty);
  world.write(id, SpeedModifier, { multiplier: speedMultiplier });
  world.write(id, Health, { current: maxHealth, max: maxHealth });
  world.write(id, NpcTag, {
    npcType: data.npcType,
    name: overrides.instanceName ?? template?.displayName ?? data.npcType,
  });

  const eq = emptyEquipment();
  if (template?.weaponItemType) {
    eq.weapon = spawnEquipEntity(world, template.weaponItemType);
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
    Hunger, Thirst, CombatState, CorruptionExposure,
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
  const prefab = content.getPrefab(prefabId);
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
  installVisualShell(world, content, id, prefab, seed);

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

