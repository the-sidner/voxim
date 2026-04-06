/**
 * Core content type definitions.
 *
 * These are the schemas for all data-driven game content: materials, models,
 * recipes, structures, lore, item templates.  Actual data lives in
 * packages/content/data/ as JSON files loaded at startup via loadContentStore().
 *
 * The server loads only what it needs (hitboxes, item stats, recipe logic).
 * The client loads everything including render properties.
 */

// ---- material ----

/** Numeric material ID as stored in terrain MaterialGrid and VoxelNode. */
export type MaterialId = number;

/**
 * Mechanical properties of a material — drive stat derivation for crafted items.
 * All values are normalised 0–1.
 *
 *   hardness    → damage output, damage resistance
 *   density     → weight contribution
 *   flexibility → arc width (weapons), draw strength (bows), comfort (grips)
 *   flammability→ fire interaction, fuel value
 *   toughness   → armor reduction, durability loss rate
 */
export interface MaterialProperties {
  hardness: number;
  density: number;
  flexibility: number;
  flammability: number;
  toughness: number;
}

export interface MaterialDef {
  id: MaterialId;
  name: string;        // unique string key used by the craft system
  // render properties (client only)
  color: number;       // 0xRRGGBB
  roughness: number;   // 0–1
  metallic: number;    // 0–1
  emissive: number;    // 0–1
  // physics properties (server + client)
  solid: boolean;
  walkable: boolean;
  // mechanical properties (server + client) — drive item stat derivation
  properties: MaterialProperties;
}

// ---- voxel model ----

export interface VoxelNode {
  x: number;
  y: number;
  z: number;
  materialId: MaterialId;
}

export interface SubObjectRef {
  /**
   * Fixed model — always use this exact model at this attachment point.
   * Mutually exclusive with `pool`; if both are set, `pool` takes precedence.
   */
  modelId?: string;
  /**
   * Variant pool — pick one entry at random (seeded by ModelRef.seed) each
   * time this entity is spawned.  Enables procedural model variation without
   * pre-baking every combination.  All entries are prefetched by the client.
   */
  pool?: string[];
  /**
   * 0–1 probability that this attachment point is populated at all.
   * Omit or set to 1.0 for an always-present sub-object.
   * Useful for optional details: sparse branches, decorative debris, etc.
   */
  probability?: number;
  transform: {
    x: number; y: number; z: number;
    rotX: number; rotY: number; rotZ: number;
    scaleX: number; scaleY: number; scaleZ: number;
  };
  /**
   * When set, this sub-object is driven by the named bone of the parent
   * model's skeleton rather than by the static transform above.
   * The transform is applied as a LOCAL offset on top of the bone's world pose.
   */
  boneId?: string;
  /**
   * When set, this sub-object's material is driven by the parent entity's
   * ModelRef.materialBindings[materialSlot] at render time.
   */
  materialSlot?: string;
}

/**
 * A SubObjectRef with the model selection already resolved to a single modelId.
 * Produced by resolveSubObjects() — passed to the renderer instead of the raw
 * SubObjectRef array so that pool selection happens exactly once per spawn.
 */
export interface ResolvedSubObject {
  modelId: string;
  transform: SubObjectRef["transform"];
  boneId?: string;
  materialSlot?: string;
}

export interface Hitbox {
  minX: number; minY: number; minZ: number;
  maxX: number; maxY: number; maxZ: number;
}

export interface ModelDefinition {
  id: string;
  version: number;
  hitbox: Hitbox;
  nodes: VoxelNode[];
  subObjects: SubObjectRef[];
  materials: MaterialId[];
  /** Which skeleton archetype drives this model's bone sub-objects (if any). */
  skeletonId?: string;
}

export interface ModelRefData {
  modelId: string;
  scaleX: number;
  scaleY: number;
  scaleZ: number;
  /**
   * Seed for resolving procedural model variation (pool sub-objects, probability
   * attachment points).  0 = deterministic "variant 0" — still valid, just
   * happens to always pick the first pool entry.  Roll a non-zero seed at spawn
   * time when the model definition uses pools so entities look distinct.
   */
  seed: number;
  /**
   * Maps named material slots in the model definition to actual material names.
   * Resolved by the client to obtain render properties per sub-object.
   * Example: { "blade": "iron", "grip": "oak" }
   */
  materialBindings?: Record<string, string>;
}

// ---- item system ----

/**
 * A single part of a crafted item — one slot filled with a specific material.
 * Carried on InventorySlot and ItemData for crafted items.
 */
export interface ItemPart {
  /** Matches ItemSlotDef.id on the item's template. */
  slot: string;
  /** Matches MaterialDef.name. Drives stat derivation and model rendering. */
  materialName: string;
}

/**
 * Declares how a material property contributes to one item stat.
 * Applied as: stat += material.properties[property] * multiplier
 */
export interface StatContribution {
  /** Which derived stat this contribution feeds into. */
  stat: keyof DerivedItemStats;
  /** Which mechanical property of the material drives it. */
  property: keyof MaterialProperties;
  multiplier: number;
}

/**
 * A named material slot on an item template.
 * Each part filled in at crafting time contributes to the item's derived stats.
 */
export interface ItemSlotDef {
  id: string;
  /** Named categories of materials accepted in this slot (e.g. "metal", "wood"). */
  materialCategories: string[];
  statContributions: StatContribution[];
  /** Maps to SubObjectRef.materialSlot in the model template for visual binding. */
  modelSlotId?: string;
}

/**
 * Computed stat block for a specific item instance.
 * Derived at runtime from the item template's baseStats + material contributions.
 * Never stored — always calculated from template + parts.
 */
export interface DerivedItemStats {
  weight: number;
  // weapon / tool
  damage?: number;
  attackRange?: number;
  attackArcHalf?: number;        // radians — half-width of the attack arc
  staminaCostPerSwing?: number;
  toolType?: string;
  harvestPower?: number;
  /** ID of the WeaponActionDef that drives this weapon's swing phases and hitbox. */
  weaponAction?: string;
  // armor
  armorReduction?: number;       // 0–1 fraction of incoming damage blocked
  staminaRegenPenalty?: number;  // 0–1 fraction of stamina regen suppressed while worn
  // consumable
  foodValue?: number;
  waterValue?: number;
}

/**
 * Template for all items of a given type.
 * Defines slots (for crafted multi-part items), base stats, model reference,
 * and what material this item contributes when used as a crafting input.
 *
 * Simple resources and consumables use slots: [] with hardcoded baseStats.
 * Crafted items (swords, armor) declare slots whose material contributions
 * accumulate on top of baseStats at crafting time.
 */
export interface ItemTemplate {
  id: string;
  category: "weapon" | "armor" | "tool" | "consumable" | "resource" | "component";
  /** Resources and consumables stack; crafted items (with parts) do not. */
  stackable: boolean;
  /** Base weight before material density contributions. */
  weight: number;
  /** Named material slots — empty for simple items. */
  slots: ItemSlotDef[];
  /** Stat values applied before slot contributions. */
  baseStats: Partial<DerivedItemStats>;
  /** References a ModelDefinition for client-side rendering and server hitbox lookup. */
  modelTemplateId?: string;
  /**
   * The material name this item contributes when placed in a recipe's output slot.
   * Example: "iron_ingot" → materialName "iron"; "oak_plank" → materialName "wood".
   * Undefined for items that aren't material sources (consumables, complex tools).
   */
  materialName?: string;
  /**
   * Tool classification — used by gathering system to check tool compatibility.
   * Mirrors DerivedItemStats.toolType; kept top-level for readability in JSON.
   */
  toolType?: string;
  /**
   * Which WeaponActionDef drives this weapon's swing phases, hitbox, and animation.
   * Absent on non-weapons and non-tools. Propagated into DerivedItemStats.weaponAction.
   */
  weaponAction?: string;
}

// ---- recipes ----

export interface RecipeInput {
  itemType: string;
  quantity: number;
  /**
   * When set, this input's material (from the item template's materialName)
   * is bound to the named slot on the output item.
   * Only relevant when the output ItemTemplate has matching slots.
   */
  outputSlot?: string;
}

/**
 * A crafting recipe.  Inputs are consumed from the crafter's inventory;
 * output is added or dropped as a world item if inventory is full.
 * ticks: construction time at 20 Hz.
 */
export interface Recipe {
  id: string;
  inputs: RecipeInput[];
  outputType: string;
  outputQuantity: number;
  ticks: number;
}

// ---- structures ----

export interface StructureMaterial {
  itemType: string;
  quantity: number;
}

/**
 * A buildable terrain element.
 * heightDelta: height added to the terrain cell on completion (0 for floor-only).
 * materialId:  material ID written to MaterialGrid on completion.
 * totalTicks:  construction time at 20 Hz.
 */
export interface StructureDef {
  id: string;
  materialCost: StructureMaterial[];
  heightDelta: number;
  materialId: number;
  totalTicks: number;
}

// ---- weapon actions ----

/** Hitbox geometry for the active phase of a weapon swing. */
export interface WeaponHitbox {
  /** "arc" = radial sector; future shapes (e.g. "line") extend this union. */
  shape: "arc";
  /** Reach in world units from the attacker's position. */
  range: number;
  /** Half-angle of the arc in radians. PI/2 = quarter-circle sweep. */
  arcHalf: number;
}

/**
 * Physics definition for one melee weapon archetype.
 * Drives the three-phase swing (windup → active → winddown), hitbox geometry,
 * animation style tag, and base stamina cost.
 * Weapons reference this by id via ItemTemplate.weaponAction.
 */
export interface WeaponActionDef {
  id: string;
  /** Ticks the attacker is committed before the hitbox goes live. Telegraphs to defenders. */
  windupTicks: number;
  /** Ticks the hitbox is live. Each target can be hit at most once per swing. */
  activeTicks: number;
  /** Ticks of recovery after the active phase before the action is complete. */
  winddownTicks: number;
  /** Tag read by the skeleton evaluator to select the correct pose function. */
  animationStyle: string;
  /** Flat stamina deducted when the action is initiated (before skill costs). */
  staminaCost: number;
  hitbox: WeaponHitbox;
}

/**
 * Per-verb balance constant for the skill system.
 * baseMagnitude feeds the balance formula:
 *   effectPower = f1.magnitude + verb.baseMagnitude
 *   ratio       = f2.magnitude / effectPower
 */
export interface VerbDef {
  id: SkillVerb;
  baseMagnitude: number;
}

// ---- NPC templates ----

/**
 * Archetype definition for an NPC type.
 * Drives health, behavior, and AI tuning — actual job logic lives in NpcAiSystem.
 * All optional fields fall back to GameConfig.npcAiDefaults when absent.
 */
export interface NpcTemplate {
  id: string;
  displayName: string;
  maxHealth: number;
  /**
   * Flee when current health falls below this fraction of max.
   * 0 means never flee (e.g. mindless beast that fights to the death).
   */
  fleeHealthRatio: number;
  /**
   * passive  — never initiates combat; flees when threatened.
   * neutral  — attacks only when attacked (or when defending allies).
   * hostile  — attacks any player on sight within aggroRange.
   */
  behavior: "passive" | "neutral" | "hostile";
  /**
   * Euclidean range (world units) within which a hostile NPC spots players.
   * Ignored for passive and neutral types.
   */
  aggroRange?: number;
  /** Max wander distance per job step (world units). */
  wanderRadius?: number;
  /** Ticks each wander job lasts before reevaluating. */
  wanderTicks?: number;
  /** Ticks each idle job lasts. */
  idleTicks?: number;
  /** Hunger value (0–100) above which seek-food overrides the current job. */
  hungerEmergency?: number;
  /** Thirst value (0–100) above which seek-water overrides the current job. */
  thirstEmergency?: number;
  /** Max ticks spent on a seek-food or seek-water job before giving up. */
  seekFoodTicks?: number;
  /** Ticks to run a flee job before reevaluating. */
  fleeTicks?: number;
  /** Ticks before reevaluating the current attack target. */
  attackTicks?: number;
  /** Hunger reduction when eating a food item. */
  foodHungerRestore?: number;
  /** Thirst reduction when drinking a water item. */
  waterThirstRestore?: number;
  modelTemplateId?: string;
  /** Movement speed multiplier applied at spawn (default 1.0). */
  speedMultiplier?: number;
  /** Item type to equip as weapon at spawn (e.g. "wolf_bite"). Null/absent = unarmed. */
  weaponItemType?: string;
  /**
   * Which WeaponActionDef drives this NPC's melee swing.
   * Absent = falls back to unarmedWeaponAction in GameConfig.
   */
  weaponAction?: string;
  /**
   * Initial skill loadout spawned onto this NPC.
   * References fragment IDs from lore_fragments.json.
   * null slots are unequipped. NPCs are also given learnedFragmentIds for each referenced fragment.
   */
  skillLoadout?: (SkillSlot | null)[];
}

// ---- resource nodes ----

export interface ResourceNodeYield {
  itemType: string;
  quantity: number;
  /**
   * Extra quantity added per point of harvestPower above 1.
   * Undefined means harvestPower has no effect on quantity.
   */
  quantityPerHarvestPower?: number;
}

/**
 * A harvestable world object — tree, ore vein, stone deposit, etc.
 * Hit by the player's equipped tool each swing (same cooldown as combat).
 * On depletion, yields items and optionally schedules respawn.
 */
export interface ResourceNodeTemplate {
  id: string;
  /**
   * The tool type required to harvest this node efficiently.
   * Swings with the wrong tool type deal 1 hit-point (always harvestable but slow).
   */
  requiredToolType: string;
  /** Total hit points before depletion. */
  hitPoints: number;
  /** Items dropped on depletion. */
  yields: ResourceNodeYield[];
  /**
   * Ticks until the node respawns after depletion.
   * Null means it never respawns (one-time deposit).
   */
  respawnTicks: number | null;
  /** References a ModelDefinition for client-side rendering. */
  modelTemplateId?: string;
}

// ---- concept verb matrix ----

/**
 * The action that triggers a skill.
 *   strike  — melee-range activation, targets the entity in front
 *   invoke  — ranged/area activation (no weapon contact needed)
 *   ward    — self-targeted defensive activation
 *   step    — movement-linked activation (fires on dodge/move input)
 */
export type SkillVerb = "strike" | "invoke" | "ward" | "step";

/**
 * One configured skill slot — the atomic unit of a character's skill loadout.
 * A skill = verb + outward fragment (what it does) + inward fragment (what it costs).
 * The concept-verb matrix resolves the (verb, f1.concept, f2.concept) triple to an effect.
 */
export interface SkillSlot {
  verb: SkillVerb;
  outwardFragmentId: string;
  inwardFragmentId: string;
}

/**
 * What the skill does in the world (outward concept determines this,
 * modified by the inward concept's cost shape).
 */
export type SkillEffectType =
  | "damage_boost"   // next attack(s) deal extra damage
  | "area_damage"    // instant damage to all entities within range
  | "heal"           // restore caster health
  | "speed_boost"    // temporary movement speed increase
  | "shield"         // absorb a fixed amount of incoming damage
  | "fear_aura"      // nearby NPCs immediately flee
  | "drain_life"     // steal health from the nearest entity in range
  | "poison_aura";   // periodic damage to entities within range for duration

/**
 * Which entity stat this effect targets at runtime.
 * Drives generic dispatch in SkillSystem and BuffSystem — no switch statements.
 *
 *   health       — health pool: used for damage, heal, drain, and DoT
 *   speed        — movement speed: applied as a multiplier bonus via SpeedModifier
 *   damage_boost — stored as ActiveEffect, consumed by ActionSystem on next attack
 *   shield       — damage absorb pool, stored as ActiveEffect, consumed by ActionSystem
 *   flee         — forces NPC job queues into flee state (not a numeric stat)
 */
export type SkillEffectStat = "health" | "speed" | "damage_boost" | "shield" | "flee";

/**
 * One cell in the concept-verb matrix.
 * The triple (verb, outwardConcept, inwardConcept) uniquely identifies a skill.
 * outwardConcept determines WHAT the skill does.
 * inwardConcept determines HOW IT COSTS (stamina shape, health cost, etc.).
 */
export interface ConceptVerbEntry {
  verb: SkillVerb;
  outwardConcept: LoreConcept;
  inwardConcept: LoreConcept;
  effectType: SkillEffectType;
  /**
   * Which stat this effect targets at runtime.
   * Drives generic dispatch — SkillSystem and BuffSystem branch on this,
   * not on effectType strings. New effectTypes only need a new JSON row; no code change.
   */
  effectStat: SkillEffectStat;
  /**
   * When true, health stolen from the target is also restored to the caster.
   * Used for drain_life effects. Default false.
   */
  drainToCaster?: boolean;
  /** Effect strength added per point of Fragment1 magnitude. */
  outwardScale: number;
  /** Stamina cost added per point of Fragment2 magnitude. */
  inwardScale: number;
  /** Flat stamina cost (before inward scaling). */
  staminaCostBase: number;
  /** Flat health cost (high-power skills; 0 for stamina-only). */
  healthCostBase: number;
  /** Ticks before this skill can be used again. */
  cooldownTicks: number;
  /** Ticks the effect lasts. 0 = instant. */
  durationTicks: number;
  /** How the skill finds its target. */
  targeting: "self" | "entity" | "area";
  /** Activation range in world units (for entity/area targeting). */
  range: number;
}

// ---- lore ----

/**
 * Broad categories of knowledge — each concept produces a different effect
 * when applied through a verb.  Fragments are neutral; position determines role.
 */
export type LoreConcept =
  | "DRAIN"
  | "KEEN"
  | "FIRE"
  | "FEAR"
  | "SWIFT"
  | "SHIELD"
  | "MEND"
  | "VENOM";

/**
 * The tradition that flavours a fragment's name and social reception.
 * Mechanics are identical across domains; only naming and NPC reaction differ.
 */
export type LoreDomain = "SUPERNATURAL" | "RELIGIOUS" | "ALCHEMICAL";

/**
 * A single Lore fragment — the atomic unit of the skill system.
 *
 * A skill = action + Fragment1 (outward effect) + Fragment2 (cost/fuel).
 * Same fragments in reversed order = a genuinely different skill.
 *
 * Fragments exist in two states: internal (learned, usable, lost on death)
 * and external (written as a tome, persists, inheritable).
 */
export interface LoreFragment {
  id: string;
  name: string;
  concept: LoreConcept;
  domain: LoreDomain;
  /** Strength 1–5; upgradeable via crafting. */
  magnitude: number;
  /** Template: what the skill does to the world when this fragment is in position 1. */
  outward: string;
  /** Template: what it costs the caster when this fragment is in position 2. */
  inward: string;
}

// ---- game config ----

/**
 * Global game balance configuration loaded from game_config.json.
 * Accessed via ContentStore.getGameConfig().
 * All tuning constants that would otherwise be hardcoded in system files live here.
 */
export interface GameConfig {
  survival: {
    hungerRatePerSec: number;
    thirstRatePerSec: number;
    hungerCritical: number;
    thirstCritical: number;
    starvationDps: number;
    dehydrationDps: number;
  };
  combat: {
    counterDamageMultiplier: number;
    blockDamageMultiplier: number;
    blockArcHalfRadians: number;
    knockbackImpulseXY: number;
    knockbackImpulseZ: number;
    /** WeaponActionDef id used when no weapon is equipped. */
    unarmedWeaponAction: string;
    /** Base damage dealt by an unarmed swing's active phase. */
    unarmedDamage: number;
    unarmed: DerivedItemStats;
  };
  dodge: {
    staminaCost: number;
    iFrameTicks: number;
    cooldownTicks: number;
    speed: number;
    parryWindowTicks: number;
    staggerTicks: number;
  };
  corruption: {
    nightGainRatePerTick: number;
    dayDecayRatePerTick: number;
    exposureGainRatePerTick: number;
    exposureDecayRatePerTick: number;
    staminaPenaltyThreshold: number;
    staminaPenaltyFraction: number;
    healthDamageThreshold: number;
    healthDps: number;
  };
  encumbrance: {
    maxCarryWeight: number;
    penaltyThresholdRatio: number;
    minSpeedMultiplier: number;
  };
  dayNight: {
    dawnStart: number;
    noonStart: number;
    duskStart: number;
    dayLengthTicks: number;
  };
  physics: {
    gravity: number;
    maxGroundSpeed: number;
    groundAccel: number;
    airControlMult: number;
    dragRetainPerSec: number;
    jumpImpulse: number;
    stepHeight: number;
  };
  trade: {
    rangeWorldUnits: number;
    cooldownTicks: number;
    currencyItemType: string;
  };
  lore: {
    externaliseConsumeTicks: number;
    blankTomeItemType: string;
    tomeItemType: string;
  };
  player: {
    defaultSpawnX: number;
    defaultSpawnY: number;
    maxHealth: number;
    maxStamina: number;
    staminaRegenPerSec: number;
    inventoryCapacity: number;
  };
  /** Global fallback defaults for NPC AI tuning. Per-type overrides live on NpcTemplate. */
  npcAiDefaults: {
    wanderRadius: number;
    wanderTicks: number;
    idleTicks: number;
    hungerEmergency: number;
    thirstEmergency: number;
    seekFoodTicks: number;
    fleeTicks: number;
    attackTicks: number;
    foodHungerRestore: number;
    waterThirstRestore: number;
    foodPickupRangeSq: number;
    arrivalThreshold: number;
    attackRangeSq: number;
    defaultAggroRangeSq: number;
  };
}

// ---- tile layout ----

/** A resource node placement for initial world spawn. */
export interface TileNodeConfig {
  nodeTypeId: string;
  x: number;
  y: number;
}

/** A trader listing within a TileNpcConfig. */
export interface TileTraderListing {
  itemType: string;
  buyPrice: number;
  sellPrice: number;
  stock: number;
}

/** An NPC spawn entry for initial world population. */
export interface TileNpcConfig {
  npcType: string;
  name: string;
  x: number;
  y: number;
  /** When present, this NPC is a trader and will receive a TraderInventory component. */
  traderListings?: TileTraderListing[];
}

/**
 * Declarative tile population config loaded from tile_layout.json.
 * Defines initial node and NPC spawns — replaces hardcoded spawn lists in TileServer.
 */
export interface TileLayout {
  tileId: string;
  nodes: TileNodeConfig[];
  npcs: TileNpcConfig[];
}

// ---- skeleton system ----

/**
 * One bone in a skeleton hierarchy.
 * restX/Y/Z are the bone's rest-pose position in LOCAL parent space
 * (model coordinate units — same scale as VoxelNode positions).
 */
export interface BoneDef {
  id: string;
  parent: string | null;
  restX: number;
  restY: number;
  restZ: number;
}

/**
 * Skeleton archetype — defines the bone hierarchy shared across all visual
 * variants of a character type.  Animations reference bones by id.
 * One archetype per character type (human, dwarf, spider, …).
 */
export interface SkeletonDef {
  id: string;
  bones: BoneDef[];
}

// ---- animation state ----

export type AnimationMode = "idle" | "walk" | "attack" | "death";

/**
 * Written by AnimationSystem each tick.  The client skeleton evaluator reads
 * this to select the correct animation pose and compute clip progress.
 *
 * For idle/walk/death: attackStyle is "" and all tick fields are 0.
 * For attack: attackStyle names the pose function; the three tick fields give
 * the phase boundaries so the evaluator can compute t ∈ [0,1] without any
 * hardcoded constants.  ticksIntoAction counts upward from 0 each tick the
 * action is in progress.
 */
export interface AnimationStateData {
  mode: AnimationMode;
  /** Pose function tag for attack mode: "slash"|"overhead"|"thrust"|"unarmed"|"bite"|"" */
  attackStyle: string;
  /** Ticks the windup phase lasts (0 for non-attack modes). */
  windupTicks: number;
  /** Ticks the active phase lasts (0 for non-attack modes). */
  activeTicks: number;
  /** Ticks the winddown phase lasts (0 for non-attack modes). */
  winddownTicks: number;
  /** Elapsed ticks since the action started (0 for non-attack modes). */
  ticksIntoAction: number;
}
