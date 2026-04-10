import type { World, EntityId } from "@voxim/engine";
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
import type { HeritageStore } from "./heritage_store.ts";
import { ResourceNode } from "./components/resource_node.ts";
import { Blueprint } from "./components/building.ts";
import { CorruptionExposure, SpeedModifier } from "./components/world.ts";
import { LoreLoadout, ActiveEffects } from "./components/lore_loadout.ts";
import { Hitbox } from "./components/hitbox.ts";
import type { ContentStore, EntityTemplate, SkillSlot } from "@voxim/content";
import { deriveHitboxTemplate, applyHitboxTemplate, solveSkeleton, REST_POSE } from "@voxim/content";

// ---- player spawning ----

export interface SpawnPlayerOpts {
  id?: EntityId;
  x?: number;
  y?: number;
  dynastyId?: string;
  heritageStore?: HeritageStore;
}

/**
 * Create a player entity with all required components.
 * Heritage bonuses are applied if a dynastyId and HeritageStore are provided.
 */
export function spawnPlayer(world: World, content: ContentStore, opts: SpawnPlayerOpts = {}): EntityId {
  const id = opts.id ?? newEntityId();
  const x = opts.x ?? 256;
  const y = opts.y ?? 256;

  const dynastyId = opts.dynastyId ?? newEntityId();
  const heritage = opts.heritageStore?.get(dynastyId) ?? {
    dynastyId,
    generation: 0,
    traits: [],
  };
  const maxHealth = opts.heritageStore?.maxHealthFor(dynastyId) ?? 100;

  world.create(id);
  world.write(id, Position, { x, y, z: 4.0 });
  world.write(id, Velocity, { x: 0, y: 0, z: 0 });
  world.write(id, Facing, { angle: 0 });
  world.write(id, InputState, {
    facing: 0, movementX: 0, movementY: 0, actions: 0, seq: 0, timestamp: 0,
  });
  world.write(id, Health, { current: maxHealth, max: maxHealth });
  world.write(id, Hunger, { value: 0 });
  world.write(id, Thirst, { value: 0 });
  world.write(id, CombatState, { blockHeldTicks: 0, staggerTicksRemaining: 0, counterReady: false, iFrameTicksRemaining: 0, dodgeCooldownTicks: 0 });
  world.write(id, Stamina, { current: 100, max: 100, regenPerSecond: 8, exhausted: false });
  world.write(id, CorruptionExposure, { level: 0 });
  world.write(id, SpeedModifier, { multiplier: 1.0 });
  world.write(id, Equipment, {
    weapon:  { itemType: "wooden_sword", quantity: 1, parts: [] },
    offHand: null, head: null, chest: null, legs: null, feet: null, back: null,
  });
  world.write(id, LoreLoadout, { skills: [null, null, null, null], learnedFragmentIds: [], skillCooldowns: [0, 0, 0, 0] });
  world.write(id, ActiveEffects, { effects: [] });
  world.write(id, Inventory, {
    slots: [
      { itemType: "stone_axe",      quantity: 1, parts: [] },
      { itemType: "stone_pickaxe",  quantity: 1, parts: [] },
      { itemType: "hammer",         quantity: 1, parts: [] },
      { itemType: "plank",          quantity: 16, parts: [] },
    ],
    capacity: 20,
  });
  world.write(id, CraftingQueue, { activeRecipeId: null, progressTicks: 0, queued: [] });
  world.write(id, InteractCooldown, { remaining: 0 });
  world.write(id, Heritage, heritage);
  world.write(id, ModelRef, { modelId: "human_base", scaleX: 0.35, scaleY: 0.35, scaleZ: 0.35, seed: 0 });
  world.write(id, AnimationState, { mode: "idle", attackStyle: "", windupTicks: 0, activeTicks: 0, winddownTicks: 0, ticksIntoAction: 0, weaponActionId: "" });
  // Hitbox not written at spawn — HitboxSystem derives it from the live skeleton each tick.

  return id;
}

// ---- NPC spawning ----

export interface SpawnNpcOpts {
  x?: number;
  y?: number;
  npcType?: string;
  name?: string;
  maxHealth?: number;
  /** Model ID from the NPC template. Defaults to "human_base" if absent. */
  modelId?: string;
  /** Movement speed multiplier from the NPC template (default 1.0). */
  speedMultiplier?: number;
  /** Item type to equip as weapon (e.g. "wolf_bite"). Null = unarmed. */
  weaponItemType?: string | null;
  /** Skill slots from the NPC template. Written to LoreLoadout if provided. */
  skillLoadout?: (SkillSlot | null)[];
}

/**
 * Create an NPC entity. NPCs share the same physics path as players —
 * NpcAiSystem writes their movement intent to InputState each tick.
 */
export function spawnNpc(world: World, content: ContentStore, opts: SpawnNpcOpts = {}): EntityId {
  const id = newEntityId();
  const x = opts.x ?? 256;
  const y = opts.y ?? 256;
  const maxHealth = opts.maxHealth ?? 80;

  world.create(id);
  world.write(id, Position, { x, y, z: 4.0 });
  world.write(id, Velocity, { x: 0, y: 0, z: 0 });
  world.write(id, Facing, { angle: 0 });
  world.write(id, InputState, {
    facing: 0, movementX: 0, movementY: 0, actions: 0, seq: 0, timestamp: 0,
  });
  world.write(id, Health, { current: maxHealth, max: maxHealth });
  world.write(id, Hunger, { value: 0 });
  world.write(id, Thirst, { value: 0 });
  world.write(id, CombatState, { blockHeldTicks: 0, staggerTicksRemaining: 0, counterReady: false, iFrameTicksRemaining: 0, dodgeCooldownTicks: 0 });
  world.write(id, CorruptionExposure, { level: 0 });
  world.write(id, SpeedModifier, { multiplier: opts.speedMultiplier ?? 1.0 });
  world.write(id, NpcTag, { npcType: opts.npcType ?? "villager", name: opts.name ?? "Villager" });
  world.write(id, NpcJobQueue, { current: null, scheduled: [], plan: null });
  world.write(id, ModelRef, { modelId: opts.modelId ?? "human_base", scaleX: 0.35, scaleY: 0.35, scaleZ: 0.35, seed: 0 });
  const weapon = opts.weaponItemType ? { itemType: opts.weaponItemType, quantity: 1, parts: [] } : null;
  world.write(id, Equipment, { weapon, offHand: null, head: null, chest: null, legs: null, feet: null, back: null });
  world.write(id, AnimationState, { mode: "idle", attackStyle: "", windupTicks: 0, activeTicks: 0, winddownTicks: 0, ticksIntoAction: 0, weaponActionId: "" });
  const slots = opts.skillLoadout ?? [null, null, null, null];
  world.write(id, LoreLoadout, { skills: slots, learnedFragmentIds: [], skillCooldowns: slots.map(() => 0) });
  world.write(id, ActiveEffects, { effects: [] });
  // Hitbox not written at spawn — HitboxSystem derives it from the live skeleton each tick.

  return id;
}

// ---- blueprint spawning ----

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

  // Hitbox: a capsule tall enough to swing at.
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

// ---- prop spawning ----

export interface SpawnPropOpts {
  x?: number;
  y?: number;
  /** World-unit height (z). Should be the terrain surface height at (x, y). */
  z?: number;
  modelId: string;
  scale?: number;
  /**
   * Seed for procedural model variation.  Pass a non-zero value when the model
   * uses pool sub-objects so each prop instance looks distinct.
   * Use positionSeed(x, y) for stable, position-based variation that survives
   * server restarts without needing to be persisted.
   */
  seed?: number;
}

/**
 * Create a purely decorative prop entity (Position + ModelRef only).
 * Props are not interactive and carry no game-state components.
 */
export function spawnProp(world: World, opts: SpawnPropOpts): EntityId {
  const id = newEntityId();
  const x = opts.x ?? 256;
  const y = opts.y ?? 256;
  const scale = opts.scale ?? 0.35;

  world.create(id);
  world.write(id, Position, { x, y, z: opts.z ?? 4.0 });
  world.write(id, ModelRef, { modelId: opts.modelId, scaleX: scale, scaleY: scale, scaleZ: scale, seed: opts.seed ?? 0 });

  return id;
}

// ---- entity spawning ----

export interface SpawnEntityOpts {
  x?: number;
  y?: number;
  z?: number;
  template: EntityTemplate;
  seed?: number;
}

const ENTITY_SCALE = 0.35;

/**
 * Create a world entity from an EntityTemplate.
 * Always writes ModelRef and derives Hitbox from template.modelId.
 * Writes ResourceNode only when template.components.resourceNode is present.
 */
export function spawnEntity(world: World, content: ContentStore, opts: SpawnEntityOpts): EntityId {
  const id = newEntityId();
  const x = opts.x ?? 256;
  const y = opts.y ?? 256;
  const seed = opts.seed ?? 0;

  world.create(id);
  world.write(id, Position, { x, y, z: opts.z ?? 4.0 });

  const entityScale = ENTITY_SCALE * (opts.template.modelScale ?? 1);
  world.write(id, ModelRef, {
    modelId: opts.template.modelId,
    scaleX: entityScale, scaleY: entityScale, scaleZ: entityScale,
    seed,
  });
  const template = deriveHitboxTemplate(opts.template.modelId, seed, content, entityScale);
  if (template.length > 0) {
    const skeleton = content.getSkeletonForModel(opts.template.modelId);
    const boneIndex = skeleton ? new Map(skeleton.bones.map((b) => [b.id, b])) : new Map();
    const boneTransforms = skeleton ? solveSkeleton(skeleton, boneIndex, REST_POSE, entityScale) : new Map();
    const parts = applyHitboxTemplate(template, boneTransforms);
    if (parts.length > 0) world.write(id, Hitbox, { parts });
  }

  const rn = opts.template.components.resourceNode;
  if (rn) {
    world.write(id, ResourceNode, {
      nodeTypeId: opts.template.id,
      hitPoints: rn.hitPoints,
      depleted: false,
      respawnTicksRemaining: null,
    });
  }

  return id;
}
