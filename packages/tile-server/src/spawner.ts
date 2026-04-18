/**
 * Entity spawning — the single path from a Prefab to a live world entity.
 *
 * `spawnPrefab(world, content, prefabId, overrides)` is the only public entry
 * point. Every other spawn shape (player, NPC, workstation, resource node,
 * decorative prop) is expressed as a prefab with archetype components, and
 * dispatched through the installer chain below.
 *
 * Blueprints still go through `spawnBlueprint` because they are parameterised
 * by a StructureDef picked at placement time rather than a fixed prefab —
 * PREFAB_SYSTEM_PLAN.md Phase 4 folds structures into prefabs as well.
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
import { Inventory, CraftingQueue, InteractCooldown } from "./components/items.ts";
import { Equipment } from "./components/equipment.ts";
import { Heritage } from "./components/heritage.ts";
import type { HeritageData, EquipmentData, InventoryData } from "@voxim/codecs";
import { maxHealthFor } from "./account_client.ts";
import { ResourceNode } from "./components/resource_node.ts";
import { Blueprint, WorkstationTag, WorkstationBuffer } from "./components/building.ts";
import { CorruptionExposure, SpeedModifier, EncumbrancePenalty } from "./components/world.ts";
import { LightEmitter } from "./components/light.ts";
import { LoreLoadout, ActiveEffects } from "./components/lore_loadout.ts";
import { Hitbox } from "./components/hitbox.ts";
import type {
  ContentStore,
  Prefab,
  PrefabResourceNodeData,
  PrefabNpcData,
  PrefabPlayerData,
  PrefabWorkstationData,
  PrefabLightEmitterData,
} from "@voxim/content";
import { applyHitboxTemplate, solveSkeleton, REST_POSE, resolveMorphParams } from "@voxim/content";

// ---- small helpers ----

/**
 * Write the component's default value. Keeps spawn sites declarative — the
 * default lives with the component def, and changes propagate automatically.
 */
function writeDefault<T>(world: World, id: EntityId, def: ComponentDef<T>): void {
  world.write(id, def, def.default());
}

// deno-lint-ignore no-explicit-any
function writeDefaults(world: World, id: EntityId, ...defs: ComponentDef<any>[]): void {
  for (const def of defs) writeDefault(world, id, def);
}

/** Full empty equipment — used as the starting point for Equipment writes. */
function emptyEquipment(): EquipmentData {
  return {
    weapon: null, offHand: null, head: null,
    chest: null, legs: null, feet: null, back: null,
  };
}

// ---- archetype installers ----
//
// Each installer inspects prefab.components for its archetype key and, if
// present, writes the matching components to the entity. Installers are
// strictly additive: unrelated entities simply skip them. Spawn-time inputs
// the prefab can't know about (heritage, instanceName) arrive via `overrides`.

/**
 * Player archetype — writes the mobile character components (movement +
 * survival + combat state) plus Heritage-derived Health and the prefab's
 * declared starting inventory/equipment.
 */
function installPlayer(
  world: World,
  content: ContentStore,
  id: EntityId,
  prefab: Prefab,
  overrides: SpawnPrefabOverrides,
): void {
  const data = prefab.components.player as PrefabPlayerData | undefined;
  if (!data) return;

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
    itemType: s.itemType, quantity: s.quantity, parts: [],
  }));
  world.write(id, Inventory, { slots, capacity });

  const eq = emptyEquipment();
  for (const [slot, itemType] of Object.entries(data.startingEquipment ?? {})) {
    if (!itemType) continue;
    eq[slot as keyof EquipmentData] = { itemType, quantity: 1, parts: [] };
  }
  world.write(id, Equipment, eq);

  writeDefaults(
    world, id,
    Hunger, Thirst, CombatState, Stamina, CorruptionExposure,
    LoreLoadout, ActiveEffects, CraftingQueue, InteractCooldown, AnimationState,
  );
}

/**
 * NPC archetype — writes the mobile character components plus NpcTag and a
 * skill loadout sourced from the referenced NpcTemplate. NpcTemplate is the
 * single source of stats (health, speed, weapon, skills, model override);
 * the prefab only names which template to use via `npc.npcType`.
 */
function installNpc(
  world: World,
  content: ContentStore,
  id: EntityId,
  prefab: Prefab,
  overrides: SpawnPrefabOverrides,
): void {
  const data = prefab.components.npc as PrefabNpcData | undefined;
  if (!data) return;

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
    eq.weapon = { itemType: template.weaponItemType, quantity: 1, parts: [] };
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
}

/**
 * Workstation archetype — WorkstationTag (server-only) + WorkstationBuffer
 * (networked). Hit detection and recipe resolution run via WorkstationHitHandler.
 */
function installWorkstation(
  world: World,
  _content: ContentStore,
  id: EntityId,
  prefab: Prefab,
  _overrides: SpawnPrefabOverrides,
): void {
  const data = prefab.components.workstation as PrefabWorkstationData | undefined;
  if (!data) return;

  world.write(id, WorkstationTag, { stationType: data.stationType });
  world.write(id, WorkstationBuffer, {
    stationType: data.stationType,
    slots: [],
    capacity: data.capacity ?? 4,
    activeRecipeId: null,
    progressTicks: null,
  });
  // Workstations without a prefab.modelId fall back to a swingable stub hitbox.
  if (!prefab.modelId) {
    world.write(id, Hitbox, {
      parts: [{
        id: "body",
        fromFwd: 0, fromRight: 0, fromUp: 0,
        toFwd:   0, toRight:   0, toUp: 1.2,
        radius: 0.6,
      }],
    });
  }
}

/** Resource-node archetype — attaches the ResourceNode state component. */
function installResourceNode(
  world: World,
  _content: ContentStore,
  id: EntityId,
  prefab: Prefab,
  _overrides: SpawnPrefabOverrides,
): void {
  const data = prefab.components.resourceNode as PrefabResourceNodeData | undefined;
  if (!data) return;
  world.write(id, ResourceNode, {
    nodeTypeId: prefab.id,
    hitPoints: data.hitPoints,
    depleted: false,
    respawnTicksRemaining: null,
  });
}

/** Light-emitter archetype — placed light source on a prop (torch, lantern). */
function installLightEmitter(
  world: World,
  _content: ContentStore,
  id: EntityId,
  prefab: Prefab,
  _overrides: SpawnPrefabOverrides,
): void {
  const data = prefab.components.lightEmitter as PrefabLightEmitterData | undefined;
  if (!data) return;
  world.write(id, LightEmitter, data);
}

type PrefabInstaller = (
  world: World,
  content: ContentStore,
  id: EntityId,
  prefab: Prefab,
  overrides: SpawnPrefabOverrides,
) => void;

/**
 * Ordered installer chain. Each inspects its archetype key and no-ops when
 * absent, so the order matters only for writes that overwrite one another
 * (none do at present). Add new archetypes here.
 */
const INSTALLERS: PrefabInstaller[] = [
  installPlayer,
  installNpc,
  installWorkstation,
  installResourceNode,
  installLightEmitter,
];

// ---- visual shell ----

/**
 * Attach ModelRef + rest-pose-derived Hitbox when the prefab declares a
 * `modelId`. The Hitbox is a placeholder for tick 0 only: HitboxSystem
 * overwrites it from the live skeleton each tick for animated entities;
 * for static props the rest-pose derivation IS the final hitbox.
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
  const hitboxParts = content.getHitboxTemplate(prefab.modelId, seed, entityScale);
  if (hitboxParts.length === 0) return;
  const skeleton = content.getSkeletonForModel(prefab.modelId);
  const boneTransforms = skeleton
    ? solveSkeleton(
        skeleton,
        content.getBoneIndex(skeleton.id),
        REST_POSE,
        entityScale,
        resolveMorphParams(skeleton, seed),
      )
    : new Map();
  const parts = applyHitboxTemplate(hitboxParts, boneTransforms);
  if (parts.length > 0) world.write(id, Hitbox, { parts });
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
  /** Heritage record applied by installPlayer. Absent = default-lineage player. */
  heritage?: HeritageData;
  /** Display-name override applied by installNpc to NpcTag.name. */
  instanceName?: string;
}

/**
 * Spawn a world entity from a prefab id.
 *
 * Writes Position universally, then runs the visual shell installer followed
 * by every archetype installer. Installers consult `prefab.components` for
 * their archetype key and skip when absent, so the same entry point covers
 * players, NPCs, workstations, resource nodes, and decorative props.
 *
 * Throws if the prefab id is unknown — callers that may receive untrusted ids
 * should guard with `content.getPrefab()` first.
 */
export function spawnPrefab(
  world: World,
  content: ContentStore,
  prefabId: string,
  overrides: SpawnPrefabOverrides = {},
): EntityId {
  const prefab = content.getPrefab(prefabId);
  if (!prefab) throw new Error(`spawnPrefab: unknown prefab '${prefabId}'`);

  const id = overrides.id ?? newEntityId();
  const x = overrides.x ?? 256;
  const y = overrides.y ?? 256;
  const z = overrides.z ?? 4.0;
  const seed = overrides.seed ?? 0;

  world.create(id);
  world.write(id, Position, { x, y, z });
  installVisualShell(world, content, id, prefab, seed);
  for (const install of INSTALLERS) install(world, content, id, prefab, overrides);

  return id;
}

// ---- blueprint spawning (separate path — StructureDef, not Prefab) ----

const CHUNK_SIZE = 32;

export interface SpawnBlueprintOpts {
  structureType: string;
  /** World-space placement coordinates (server x/y plane). */
  worldX: number;
  worldY: number;
  /** Surface height at this position — used as the entity z position. */
  surfaceZ: number;
}

/**
 * Place a Blueprint entity in the world.
 * Returns the entity ID on success, or null if the structure type is unknown.
 *
 * Snaps to cell grid: (worldX, worldY) → (chunkX, chunkY, localX, localY).
 * The entity position is the cell center so the player can swing at it.
 */
export function spawnBlueprint(world: World, content: ContentStore, opts: SpawnBlueprintOpts): EntityId | null {
  const def = content.getStructureDef(opts.structureType);
  if (!def) return null;

  const cellX = Math.floor(opts.worldX);
  const cellY = Math.floor(opts.worldY);
  const chunkX = Math.floor(cellX / CHUNK_SIZE);
  const chunkY = Math.floor(cellY / CHUNK_SIZE);
  const localX = ((cellX % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
  const localY = ((cellY % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;

  // Center the entity in the cell
  const posX = cellX + 0.5;
  const posY = cellY + 0.5;

  const id = newEntityId();
  world.create(id);
  world.write(id, Position, { x: posX, y: posY, z: opts.surfaceZ });
  world.write(id, Blueprint, {
    structureType: def.id,
    chunkX, chunkY, localX, localY,
    heightDelta:   def.heightDelta,
    materialId:    def.materialId,
    materialCost:  def.materialCost,
    totalTicks:    def.totalTicks,
    ticksRemaining: def.totalTicks,
    materialsDeducted: false,
  });

  // Walls (heightDelta > 0) get a full-height capsule; floors get a short stub.
  const capsuleHeight = def.heightDelta > 0 ? def.heightDelta : 0.8;
  world.write(id, Hitbox, {
    parts: [{
      id: "body",
      fromFwd: 0, fromRight: 0, fromUp: 0,
      toFwd:   0, toRight:   0, toUp: capsuleHeight,
      radius:  0.5,
    }],
  });

  return id;
}
