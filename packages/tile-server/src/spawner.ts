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
import type { HeritageStore } from "./heritage_store.ts";
import { ResourceNode } from "./components/resource_node.ts";
import { Blueprint, WorkstationTag, WorkstationBuffer } from "./components/building.ts";
import { CorruptionExposure, SpeedModifier, EncumbrancePenalty } from "./components/world.ts";
import { LightEmitter } from "./components/light.ts";
import { LoreLoadout, ActiveEffects } from "./components/lore_loadout.ts";
import { Hitbox } from "./components/hitbox.ts";
import type { ContentStore, EntityTemplate, SkillSlot, EntityTemplateComponents } from "@voxim/content";
import { applyHitboxTemplate, solveSkeleton, REST_POSE, resolveMorphParams } from "@voxim/content";

// ---- spawn helpers ----

/**
 * Write the component's default value to an entity. Use this instead of
 * duplicating the default literal inline — changes to the default() function
 * propagate automatically, and the spawn sites stay declarative ("attach
 * these components") rather than repeating tuning values already owned by
 * the component definition.
 */
function writeDefault<T>(world: World, id: EntityId, def: ComponentDef<T>): void {
  world.write(id, def, def.default());
}

/** Variadic form: attach a list of components in their default state. */
// deno-lint-ignore no-explicit-any
function writeDefaults(world: World, id: EntityId, ...defs: ComponentDef<any>[]): void {
  for (const def of defs) writeDefault(world, id, def);
}

/**
 * Write components that every mobile entity (player or NPC) needs. Position
 * and Facing go on every spawn — only the starting x/y vary per-entity, so
 * those are explicit while the rest use component defaults.
 */
function writeMovementComponents(
  world: World,
  id: EntityId,
  x: number,
  y: number,
  speedMultiplier = 1.0,
): void {
  world.write(id, Position, { x, y, z: 4.0 });
  writeDefaults(world, id, Velocity, Facing, InputState);
  world.write(id, SpeedModifier, { multiplier: speedMultiplier });
  writeDefault(world, id, EncumbrancePenalty);
}

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

  const scale = content.getGameConfig().world.defaultEntityScale;

  world.create(id);
  writeMovementComponents(world, id, x, y);
  // Customised writes: values that differ from the component's default.
  world.write(id, Health, { current: maxHealth, max: maxHealth });
  world.write(id, Equipment, {
    weapon:  { itemType: "wooden_sword", quantity: 1, parts: [] },
    offHand: null, head: null, chest: null, legs: null, feet: null, back: null,
  });
  world.write(id, Inventory, {
    slots: [
      { itemType: "stone_axe",      quantity: 1, parts: [] },
      { itemType: "stone_pickaxe",  quantity: 1, parts: [] },
      { itemType: "hammer",         quantity: 1, parts: [] },
      { itemType: "plank",          quantity: 16, parts: [] },
    ],
    capacity: 20,
  });
  world.write(id, Heritage, heritage);
  world.write(id, ModelRef, { modelId: "human_base", scaleX: scale, scaleY: scale, scaleZ: scale, seed: 0 });
  // Everything else is the component's default.
  writeDefaults(
    world, id,
    Hunger, Thirst, CombatState, Stamina, CorruptionExposure,
    LoreLoadout, ActiveEffects, CraftingQueue, InteractCooldown, AnimationState,
  );
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
  const scale = content.getGameConfig().world.defaultEntityScale;

  world.create(id);
  writeMovementComponents(world, id, x, y, opts.speedMultiplier);
  world.write(id, Health, { current: maxHealth, max: maxHealth });
  world.write(id, NpcTag, { npcType: opts.npcType ?? "villager", name: opts.name ?? "Villager" });
  world.write(id, ModelRef, { modelId: opts.modelId ?? "human_base", scaleX: scale, scaleY: scale, scaleZ: scale, seed: 0 });
  const weapon = opts.weaponItemType ? { itemType: opts.weaponItemType, quantity: 1, parts: [] } : null;
  world.write(id, Equipment, { weapon, offHand: null, head: null, chest: null, legs: null, feet: null, back: null });
  const slots = opts.skillLoadout ?? [null, null, null, null];
  world.write(id, LoreLoadout, { skills: slots, learnedFragmentIds: [], skillCooldowns: slots.map(() => 0) });
  // Defaulted components.
  writeDefaults(
    world, id,
    Hunger, Thirst, CombatState, CorruptionExposure,
    NpcJobQueue, AnimationState, ActiveEffects,
  );
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

// ---- workstation spawning ----

export interface SpawnWorkstationOpts {
  x?: number;
  y?: number;
  z?: number;
  stationType: string;
  capacity?: number;
  /** Model ID to render. Provided by the entity template's modelId field. */
  modelId?: string;
}

/**
 * Create a workstation entity: WorkstationTag (server-only) + WorkstationBuffer (networked) + Hitbox.
 * Players place items on it via ACTION_INTERACT; attacks resolve recipes via WorkstationHitHandler.
 */
export function spawnWorkstation(world: World, content: ContentStore, opts: SpawnWorkstationOpts): EntityId {
  const id = newEntityId();
  const x = opts.x ?? 256;
  const y = opts.y ?? 256;

  world.create(id);
  world.write(id, Position, { x, y, z: opts.z ?? 4.0 });
  world.write(id, WorkstationTag, { stationType: opts.stationType });
  world.write(id, WorkstationBuffer, {
    stationType: opts.stationType,
    slots: [],
    capacity: opts.capacity ?? 4,
    activeRecipeId: null,
    progressTicks: null,
  });
  world.write(id, Hitbox, {
    parts: [{
      id: "body",
      fromFwd: 0, fromRight: 0, fromUp: 0,
      toFwd:   0, toRight:   0, toUp: 1.2,
      radius: 0.6,
    }],
  });

  if (opts.modelId) {
    const scale = content.getGameConfig().world.defaultEntityScale;
    world.write(id, ModelRef, { modelId: opts.modelId, scaleX: scale, scaleY: scale, scaleZ: scale, seed: 0 });
  }

  return id;
}

// ---- entity spawning ----

export interface SpawnEntityOpts {
  x?: number;
  y?: number;
  z?: number;
  template: EntityTemplate;
  seed?: number;
  /** Display name override — forwarded to NPC entities, overrides npc_template.displayName. */
  instanceName?: string;
}

/**
 * Per-template-component installer.
 *
 * When spawnEntity runs it iterates `opts.template.components` and dispatches
 * each key to the matching installer. Adding a new optional component to
 * EntityTemplateComponents is two steps: add the shape to the types file and
 * register an installer here — no churn in the main spawnEntity body.
 */
type TemplateInstaller = (
  world: World,
  id: EntityId,
  template: EntityTemplate,
  content: ContentStore,
) => void;

/** Resource-node installer — just attaches the component from template data. */
const installResourceNode: TemplateInstaller = (world, id, template) => {
  const rn = template.components.resourceNode;
  if (!rn) return;
  world.write(id, ResourceNode, {
    nodeTypeId: template.id,
    hitPoints: rn.hitPoints,
    depleted: false,
    respawnTicksRemaining: null,
  });
};

const installLightEmitter: TemplateInstaller = (world, id, template) => {
  const le = template.components.lightEmitter;
  if (!le) return;
  world.write(id, LightEmitter, le);
};

/**
 * Non-npc / non-workstation installers. NPC and workstation entities take the
 * delegation path in spawnEntity before this map is consulted, since they're
 * full different entity shapes rather than additive components on a visual
 * prop.
 */
const INSTALLERS: { [K in keyof EntityTemplateComponents]?: TemplateInstaller } = {
  resourceNode: installResourceNode,
  lightEmitter: installLightEmitter,
};

/**
 * Attach the default visual shell: ModelRef + derived Hitbox from the model's
 * rest-pose skeleton. Returns true if a model was attached.
 */
function installVisualShell(
  world: World,
  id: EntityId,
  template: EntityTemplate,
  content: ContentStore,
  seed: number,
): boolean {
  if (!template.modelId) return false;
  const defaultScale = content.getGameConfig().world.defaultEntityScale;
  const entityScale = defaultScale * (template.modelScale ?? 1);
  world.write(id, ModelRef, {
    modelId: template.modelId,
    scaleX: entityScale, scaleY: entityScale, scaleZ: entityScale,
    seed,
  });
  const hitboxParts = content.getHitboxTemplate(template.modelId, seed, entityScale);
  if (hitboxParts.length > 0) {
    const skeleton = content.getSkeletonForModel(template.modelId);
    const boneTransforms = skeleton
      ? solveSkeleton(skeleton, content.getBoneIndex(skeleton.id), REST_POSE, entityScale, resolveMorphParams(skeleton, seed))
      : new Map();
    const parts = applyHitboxTemplate(hitboxParts, boneTransforms);
    if (parts.length > 0) world.write(id, Hitbox, { parts });
  }
  return true;
}

/**
 * Create a world entity from an EntityTemplate.
 *
 * Dispatch:
 *   components.npc         → full NPC entity (delegates to spawnNpc)
 *   components.workstation → workstation entity (delegates to spawnWorkstation,
 *                            then applies additive installers like lightEmitter)
 *   else                   → visual shell (ModelRef + derived Hitbox) +
 *                            any matching installers from INSTALLERS
 */
export function spawnEntity(world: World, content: ContentStore, opts: SpawnEntityOpts): EntityId {
  // ── NPC entities ────────────────────────────────────────────────────────────
  const npcComp = opts.template.components.npc;
  if (npcComp) {
    const npcTemplate = content.getNpcTemplate(npcComp.npcType);
    return spawnNpc(world, content, {
      x: opts.x,
      y: opts.y,
      npcType: npcComp.npcType,
      name:            opts.instanceName ?? npcTemplate?.displayName,
      maxHealth:       npcTemplate?.maxHealth,
      modelId:         npcTemplate?.modelTemplateId,
      speedMultiplier: npcTemplate?.speedMultiplier,
      weaponItemType:  npcTemplate?.weaponItemType ?? null,
      skillLoadout:    npcTemplate?.skillLoadout ?? undefined,
    });
  }

  // ── Workstation entities ─────────────────────────────────────────────────────
  const wsComp = opts.template.components.workstation;
  if (wsComp) {
    const wsId = spawnWorkstation(world, content, {
      x: opts.x, y: opts.y, z: opts.z,
      stationType: wsComp.stationType,
      capacity: wsComp.capacity,
      modelId: opts.template.modelId,
    });
    // Additive installers run on the existing workstation entity.
    for (const key of Object.keys(opts.template.components) as (keyof EntityTemplateComponents)[]) {
      const installer = INSTALLERS[key];
      if (installer) installer(world, wsId, opts.template, content);
    }
    return wsId;
  }

  // ── Visual shell (resource nodes, decorative props) ─────────────────────────
  const id = newEntityId();
  const x = opts.x ?? 256;
  const y = opts.y ?? 256;
  const seed = opts.seed ?? 0;

  world.create(id);
  world.write(id, Position, { x, y, z: opts.z ?? 4.0 });
  installVisualShell(world, id, opts.template, content, seed);

  // Run any additive installers declared by the template.
  for (const key of Object.keys(opts.template.components) as (keyof EntityTemplateComponents)[]) {
    const installer = INSTALLERS[key];
    if (installer) installer(world, id, opts.template, content);
  }

  return id;
}
