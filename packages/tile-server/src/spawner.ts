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
import { CorruptionExposure, SpeedModifier } from "./components/world.ts";
import { LoreLoadout, ActiveEffects } from "./components/lore_loadout.ts";
import { Hitbox } from "./components/hitbox.ts";
import type { ContentStore, ResourceNodeTemplate, SkillSlot } from "@voxim/content";
import { deriveHitboxParts } from "@voxim/content";

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
    ],
    capacity: 20,
  });
  world.write(id, CraftingQueue, { activeRecipeId: null, progressTicks: 0, queued: [] });
  world.write(id, InteractCooldown, { remaining: 0 });
  world.write(id, Heritage, heritage);
  world.write(id, ModelRef, { modelId: "human_base", scaleX: 0.35, scaleY: 0.35, scaleZ: 0.35, seed: 0 });
  world.write(id, AnimationState, { mode: "idle", attackStyle: "", windupTicks: 0, activeTicks: 0, winddownTicks: 0, ticksIntoAction: 0 });
  const playerHitboxDef = content.getModelHitboxDef("human_base");
  if (playerHitboxDef) world.write(id, Hitbox, { parts: playerHitboxDef.parts });

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
  world.write(id, AnimationState, { mode: "idle", attackStyle: "", windupTicks: 0, activeTicks: 0, winddownTicks: 0, ticksIntoAction: 0 });
  const slots = opts.skillLoadout ?? [null, null, null, null];
  world.write(id, LoreLoadout, { skills: slots, learnedFragmentIds: [], skillCooldowns: slots.map(() => 0) });
  world.write(id, ActiveEffects, { effects: [] });
  const npcModelId = opts.modelId ?? "human_base";
  const npcHitboxDef = content.getModelHitboxDef(npcModelId);
  if (npcHitboxDef) {
    world.write(id, Hitbox, { parts: npcHitboxDef.parts });
  } else {
    const parts = deriveHitboxParts(npcModelId, 0, content, 0.35);
    if (parts.length > 0) world.write(id, Hitbox, { parts });
  }

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

// ---- resource node spawning ----

export interface SpawnNodeOpts {
  x?: number;
  y?: number;
  z?: number;
  template: ResourceNodeTemplate;
  /**
   * Procedural seed — must match ModelRef.seed so the derived hitbox covers
   * the same sub-objects (branch variants, etc.) that the client renders.
   * Defaults to 0.
   */
  seed?: number;
}

const NODE_SCALE = 0.35;

/**
 * Create a resource node entity from a template.
 * Position defaults to tile centre; callers should pass an explicit location.
 *
 * The hitbox capsule is derived from the model's AABB — no separate hitbox
 * definition needed on the node template.
 */
export function spawnNode(world: World, content: ContentStore, opts: SpawnNodeOpts): EntityId {
  const id = newEntityId();
  const x = opts.x ?? 256;
  const y = opts.y ?? 256;

  world.create(id);
  world.write(id, Position, { x, y, z: opts.z ?? 4.0 });
  world.write(id, ResourceNode, {
    nodeTypeId: opts.template.id,
    hitPoints: opts.template.hitPoints,
    depleted: false,
    respawnTicksRemaining: null,
  });
  if (opts.template.modelTemplateId) {
    const nodeSeed = opts.seed ?? 0;
    world.write(id, ModelRef, { modelId: opts.template.modelTemplateId, scaleX: NODE_SCALE, scaleY: NODE_SCALE, scaleZ: NODE_SCALE, seed: nodeSeed });
    const parts = deriveHitboxParts(opts.template.modelTemplateId, nodeSeed, content, NODE_SCALE);
    if (parts.length > 0) world.write(id, Hitbox, { parts });
  }

  return id;
}
