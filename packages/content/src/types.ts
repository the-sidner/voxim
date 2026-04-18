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
  /**
   * When explicitly set to false, this sub-object is excluded from automatic
   * hitbox capsule derivation. Use for purely visual attachments (leaves,
   * decorative detail) that should not be hittable.
   * Absent (default) means include in hitbox derivation.
   */
  hitbox?: false;
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
  /**
   * Bounding box — derived at registration time from VoxelNode positions by
   * StaticContentStore.registerModel().  No longer needs to be authored by hand
   * or stored in JSON.  Still accepted if present (ignored — derived value wins).
   */
  hitbox?: Hitbox;
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
  /** Reduces blueprint ticksRemaining by this amount per hammer swing. */
  buildPower?: number;
  /** Height units removed per shovel swing. Multiplied by terrain.digStep in config. */
  digPower?: number;
  /** ID of the WeaponActionDef that drives this weapon's swing phases and blade path. */
  weaponAction?: string;
  // armor
  armorReduction?: number;       // 0–1 fraction of incoming damage blocked
  staminaRegenPenalty?: number;  // 0–1 fraction of stamina regen suppressed while worn
  // consumable
  foodValue?: number;
  waterValue?: number;
  // light emission — for held torches / lanterns
  /** Packed RGB color (0xRRGGBB) emitted while equipped. */
  lightColor?: number;
  /** Light intensity 0–1 while equipped. */
  lightIntensity?: number;
  /** Light radius in world units while equipped. */
  lightRadius?: number;
  /** Flicker amplitude 0–1. 0 = steady, 1 = heavy flicker. */
  lightFlicker?: number;
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
/**
 * Which equipment slot an item occupies when equipped.
 * Matches the field names on EquipmentData in @voxim/codecs.
 * Absent on items that cannot be equipped (resources, consumables, components).
 */
export type EquipSlot = "weapon" | "offHand" | "head" | "chest" | "legs" | "feet" | "back";

export interface ItemTemplate {
  id: string;
  category: "weapon" | "armor" | "tool" | "consumable" | "resource" | "component" | "deployable";
  /** Resources and consumables stack; crafted items (with parts) do not. */
  stackable: boolean;
  /** Base weight before material density contributions. */
  weight: number;
  /**
   * Which equipment slot this item occupies when equipped.
   * Absent on items that cannot be equipped (resources, consumables, components).
   * Note: `slots` below refers to crafting material slots — a separate concept.
   */
  equipSlot?: EquipSlot;
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
  /**
   * ID of the EntityTemplate to spawn when this item is deployed into the world.
   * Any item category can carry this field — it is independent of `category`.
   * When present, the item is deployable regardless of its category value.
   * When absent, the deploy system falls back to checking category === "deployable"
   * and using the item ID as the template ID (backward-compat for existing workstations).
   */
  deployTemplateId?: string;
}

// ---- recipes ----

export interface RecipeInput {
  /** Primary acceptable item type. */
  itemType: string;
  /** Quantity required (sum across primary + alternates per input slot). */
  quantity: number;
  /**
   * Other item types accepted in place of `itemType`. The recipe matches
   * when the primary OR any alternate has at least `quantity` in the buffer.
   * Consumption picks the first acceptable type with sufficient quantity.
   */
  alternates?: string[];
  /**
   * When set, this input's material (from the item template's materialName)
   * is bound to the named slot on the output item.
   * Only relevant when the output ItemTemplate has matching slots.
   */
  outputSlot?: string;
}

export interface RecipeOutput {
  itemType: string;
  quantity: number;
}

/**
 * How a recipe step is resolved.
 *   "attack"   — player attacks the workstation with a requiredTool; instant output.
 *   "time"     — timer starts when inputs are placed; output when ticks reach 0.
 *   "assembly" — player selects a recipe explicitly, then attacks with a requiredTool.
 */
export type RecipeStepType = "attack" | "time" | "assembly";

/**
 * A crafting recipe.
 *
 * Physical model: inputs are placed on a WorkstationBuffer entity; the step
 * type determines how resolution is triggered.
 */
export interface Recipe {
  id: string;
  /** Workstation stationType required (e.g. "chopping_block"). Absent = no station. */
  stationType?: string;
  /** How this recipe is resolved. Default "time" when absent. */
  stepType?: RecipeStepType;
  /**
   * Acceptable tool types for "attack"/"assembly" steps. Empty array = any
   * tool (or none). On match, any one of the listed tool types is acceptable.
   */
  requiredTools: string[];
  /**
   * LoreFragment ID the player must have in learnedFragmentIds to select this recipe.
   * Absent = freely available to any player.
   */
  requiredFragmentId?: string;
  inputs: RecipeInput[];
  outputs: RecipeOutput[];
  /**
   * When set, on completion the workstation's `activeRecipeId` is set to
   * this id (instead of cleared) so the next swing or tick continues the
   * chain. Step handlers honor `activeRecipeId` when present.
   */
  chainNextRecipeId?: string;
  /** Timer length at 20 Hz. 0 for instant "attack" steps. */
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

/**
 * One keyframe in a weapon swing path.
 * t is normalised 0..1 over the ENTIRE action (windup + active + winddown).
 *
 * Hilt position is in entity-local (fwd, right, up) space.
 * Blade direction is a unit vector pointing from hilt toward tip.
 * The tip is derived by callers: tip = hilt + bladeDir × bladeLength.
 */
export interface SwingKeyframe {
  /** Normalised time 0..1 over the entire action. */
  t: number;
  hiltFwd: number;
  hiltRight: number;
  hiltUp: number;
  /** Unit vector from hilt toward blade tip — forward component. */
  bladeFwd: number;
  /** Unit vector from hilt toward blade tip — rightward component. */
  bladeRight: number;
  /** Unit vector from hilt toward blade tip — upward component. */
  bladeUp: number;
}

/**
 * Time-series description of the weapon hilt's path through entity-local space.
 * Blade geometry (length and radius) is derived at runtime from the equipped
 * weapon's model AABB (model Z axis = blade axis, scale = entity voxel scale).
 * Unarmed swings use constants defined in ActionSystem.
 */
export interface WeaponSwingPath {
  /** Ordered keyframes; t values must be strictly increasing from 0 to 1. */
  keyframes: SwingKeyframe[];
}

/**
 * One IK chain defined on a skeleton.
 * The skeleton owns the anatomy (which bones, how the joint bends) and
 * which named drive source to track ("hilt", "grip_l", "ground_l", …).
 * Weapon actions and other systems activate chains by ID, not by bone name.
 */
export interface IKChainDef {
  /** Unique within the skeleton. e.g. "right_arm", "left_arm", "right_leg". */
  id: string;
  /** Two-bone chain: [root_bone, mid_bone]. End-effector = mid_bone's child in rest pose. */
  bones: [string, string];
  /** Named drive source this chain tracks when present in the DriveContext.
   *  e.g. "hilt" (weapon grip), "grip_l" (off-hand grip), "ground_l" (foot plant). */
  driveSource: string;
  /** Anatomical default: direction the middle joint (elbow/knee) bends toward.
   *  Entity-local (fwd, right, up) coordinates. */
  poleHint: { fwd: number; right: number; up: number };
}

/** Configuration for a ranged weapon action — projectile spawn parameters. */
export interface ProjectileActionConfig {
  /** World units per second. */
  speed: number;
  /** 0 = no gravity (magic bolt), 0.4 = arrow arc, 1.0 = thrown rock. */
  gravityScale: number;
  /** Collision sphere radius in world units. */
  radius: number;
  /** Max entities to pierce through. 1 = arrow (stops on first hit). 0 = unlimited. */
  maxHits: number;
  /** Auto-destroy after this many ticks (limits max range). */
  lifetimeTicks: number;
  /** Model ID for the in-flight projectile. Absent = invisible (e.g. magic bolt). */
  modelId?: string;
}

/**
 * Physics definition for one weapon archetype (melee or ranged).
 * Drives the three-phase swing (windup → active → winddown), swing path geometry,
 * animation style tag, and base stamina cost.
 *
 * For melee: swingPath hilt keyframes are the single source of truth:
 *   - Server: swept capsule hit detection (blade geometry derived from weapon model AABB)
 *   - Client: IK arm animation tracks hilt via skeleton ikChains
 *   - Client: trail ribbon from derived tip position
 *
 * For ranged: projectile config drives spawn on first active tick; no blade sweep.
 *
 * Weapons reference this by id via ItemTemplate.weaponAction.
 */
export interface WeaponActionDef {
  id: string;
  /** Ticks the attacker is committed before the blade becomes active. Telegraphs to defenders. */
  windupTicks: number;
  /** Ticks the blade is active. Each target body part can be hit at most once per swing. */
  activeTicks: number;
  /** Ticks of recovery after the active phase before the action is complete. */
  winddownTicks: number;
  /** Tag used by the client to look up this weapon action for animation + trail rendering. */
  animationStyle: string;
  /** Flat stamina deducted when the action is initiated (before skill costs). */
  staminaCost: number;
  /** "melee" (default when absent) or "ranged". */
  actionType?: "melee" | "ranged";
  /** Hilt path + blade direction through entity-local space. Required for melee, absent for ranged. */
  swingPath?: WeaponSwingPath;
  /** Projectile spawn parameters. Required for ranged, absent for melee. */
  projectile?: ProjectileActionConfig;
  /**
   * IK chain IDs (from the skeleton's ikChains) to activate during this action.
   * The skeleton owns bone names and pole hints; this list just selects which chains fire.
   * e.g. ["right_arm"] for a one-handed slash, ["right_arm", "left_arm"] for overhead.
   */
  ikChainIds?: string[];
}

// ---- body part volumes ----

/**
 * A named capsule in entity-local (fwd, right, up) space.
 * Used for hit detection: the blade capsule is tested against each body part capsule.
 */
export interface BodyPartVolume {
  /** Semantic name: "head", "torso", "abdomen", "legs", "body", "hindquarters", etc. */
  id: string;
  /** All coordinates are entity-local (right=X, fwd=Y, up=Z), derived by HitboxSystem. */
  fromFwd: number;
  fromRight: number;
  fromUp: number;
  toFwd: number;
  toRight: number;
  toUp: number;
  /** Capsule radius in world units. */
  radius: number;
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

// ---- biomes ----

/**
 * One rule in a biome's classification cascade. A biome matches a sample
 * when every listed range contains the sample's value. Ranges are inclusive
 * on both ends; absent bounds mean no limit on that side.
 */
export interface BiomeClassifyRule {
  altitude?: { min?: number; max?: number };
  temperature?: { min?: number; max?: number };
  moisture?: { min?: number; max?: number };
}

/**
 * One rule in a biome's material assignment cascade. First matching rule
 * wins. A rule with no conditions matches any sample (fallback).
 */
export interface BiomeMaterialRule {
  normalizedHeight?: { min?: number; max?: number };
  moisture?: { min?: number; max?: number };
  detailNoise?: { min?: number; max?: number };
  /** Material `name` from packages/content/data/materials/. */
  materialName: string;
}

export interface BiomeDef {
  id: string;
  /**
   * Classification priority. Lower number runs first. When a biome has
   * classifyRules and any rule matches, the biome wins. When classifyRules
   * is empty, the biome is the fallback — only wins if every other biome
   * of lower priority fails.
   */
  priority: number;
  classifyRules: BiomeClassifyRule[];
  /** Ordered material rules. First match wins; last should be a fallback. */
  materialRules: BiomeMaterialRule[];
  /** Height scale multiplier applied to combined base noise. */
  heightScale: number;
  /** Roughness multiplier applied to detail noise. */
  roughness: number;
}

// ---- zones ----

/**
 * One rule in a zone's classification cascade. Every listed condition must
 * pass for the rule to match. `spawnZoneOnly` matches when the cell is
 * within the configured spawn zone. `biomes` restricts to a set of biome
 * ids. `tectonicMin` / `altitudeMin` are numeric thresholds. `probability`
 * is a final random gate (runs after other conditions pass).
 */
export interface ZoneClassifyRule {
  spawnZoneOnly?: boolean;
  biomes?: string[];
  tectonicMin?: number;
  altitudeMin?: number;
  probability?: number;
}

export interface ZoneDef {
  id: string;
  /** Lower priority runs first during classification. */
  priority: number;
  classifyRules: ZoneClassifyRule[];
  dangerLevel: number;
  corruptionBaseline: number;
  /** Expected NPC spawns per zone cell; fractional values are probabilistic. */
  npcSpawnDensity: number;
  /** Expected resource-node spawns per zone cell. */
  nodeSpawnDensity: number;
  /** Expected decorative prop spawns per zone cell. */
  propSpawnDensity: number;
  npcWeights: Record<string, number>;
  entityWeights: Record<string, number>;
  propWeights: Record<string, number>;
}

// ---- behavior trees ----

/**
 * A named behavior tree definition loaded from
 * `data/behavior_trees/{id}.json`. `root` is the raw, untyped node spec;
 * tile-server builds it into a `BTNode` tree at startup using its BT node
 * registry. The content store only holds the JSON — it does not depend on
 * tile-server's runtime node types.
 */
export interface BehaviorTreeSpec {
  id: string;
  root: unknown;
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
   * Id of the behavior tree this NPC runs (matches a file in
   * `data/behavior_trees/{id}.json`). Validated at server startup —
   * unknown ids fail fast.
   */
  behaviorTreeId: string;
  /**
   * Euclidean range (world units) within which a hostile NPC spots players.
   * Ignored for passive and neutral types.
   */
  aggroRange?: number;
  /**
   * Euclidean range (world units) within which an NPC will stop advancing and attack.
   * Defaults to sqrt(npcAiDefaults.attackRangeSq) when absent (melee range ≈ 1.5).
   * Set larger values for archers and other ranged combatants.
   */
  attackRange?: number;
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

/** Harvest/resource-node behaviour data. Lives inside EntityTemplate.components. */
export interface EntityTemplateResourceNodeData {
  hitPoints: number;
  yields: ResourceNodeYield[];
  requiredToolType: string | null;
  respawnTicks: number | null;
}

/**
 * NPC component — links an entity template to an NPC archetype.
 * All AI tuning lives in the referenced NpcTemplate; this just says "spawn one of these".
 */
export interface EntityTemplateNpcData {
  /** ID of the entry in npc_templates.json that drives this NPC's behaviour. */
  npcType: string;
}

/** Component data declared by an entity template. Extend as new component types are added. */
export interface EntityTemplateComponents {
  resourceNode?: EntityTemplateResourceNodeData;
  /**
   * When present, spawnEntity() creates a full NPC entity (Health, AI, Equipment…)
   * using the referenced npc_template for all tuning values.
   */
  npc?: EntityTemplateNpcData;
  /**
   * When present, spawnEntity() creates a WorkstationTag + WorkstationBuffer entity.
   * stationType must match a recipe source key and a deployable item ID.
   */
  workstation?: {
    stationType: string;
    capacity?: number;
  };
  /**
   * When present, spawnEntity() writes a LightEmitter component at spawn.
   * Used for placed torches, campfires, hearths, and other static light sources.
   */
  lightEmitter?: {
    /** Packed RGB color (0xRRGGBB). */
    color: number;
    intensity: number;
    radius: number;
    flicker: number;
  };
}

/**
 * EntityTemplate — prefab-style definition of a spawnable world entity.
 *
 * Owns: which model to render (and derive hitbox from) and which optional
 * behavioural components are attached at spawn.
 *
 * Dispatch table in spawnEntity():
 *   components.npc         → full NPC entity
 *   components.workstation → WorkstationTag + WorkstationBuffer + Hitbox
 *   components.resourceNode → ModelRef + Hitbox + ResourceNode
 *   (no components)        → ModelRef + Hitbox only (decorative prop)
 */
export interface EntityTemplate {
  id: string;
  /**
   * Model to render this entity with. Optional — absent means no visual
   * representation yet (placeholder/invisible entity).
   */
  modelId?: string;
  /** Multiplier applied on top of the base ENTITY_SCALE at spawn. Defaults to 1. */
  modelScale?: number;
  components: EntityTemplateComponents;
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
   * Handler id in the effect registries (apply/tick/compose). Each value must
   * match a registered apply handler in the server at startup; validated then
   * and fail-fast on mismatch. New effect types are added as one handler file
   * plus a registration call — no code changes in SkillSystem/BuffSystem.
   */
  effectStat: string;
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
    /** Fist "blade" length for unarmed swing hitbox (world units). */
    unarmedBladeLength: number;
    /** Fist "blade" radius for unarmed swing hitbox (world units). */
    unarmedBladeRadius: number;
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
  crouch: {
    speedMultiplier: number;
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
  terrain: {
    /** Height removed per shovel swing, in world units. Multiples of HEIGHT_STEP (0.25). */
    digStep: number;
    /** Minimum terrain height — shovels cannot dig below this. */
    minDigHeight: number;
    /** Max distance (world units) from digger to target cell centre. */
    digReach: number;
    /** Maps material ID → item type dropped when a cell is dug. */
    materialDrops: Record<string, string>;
  };
  crafting: {
    /** How close a player must be to a workstation to interact (world units). */
    interactRange: number;
    /** Ticks between placement attempts; prevents button-hold spam. */
    interactCooldownTicks: number;
    /** How far ahead of the player to place a deployed workstation (world units). */
    deployOffsetWorldUnits: number;
  };
  consumption: {
    /** Ticks between consume actions; prevents button-hold spam. */
    cooldownTicks: number;
  };
  animation: {
    /** Minimum speed² (world units/s)² to trigger the walk clip instead of idle. */
    walkSpeedThresholdSq: number;
  };
  building: {
    /** Max distance from placer to blueprint cell centre (world units). */
    maxReachWorldUnits: number;
  };
  items: {
    /** Auto-pickup radius (world units) — ItemData entities within this range are collected. */
    pickupRadius: number;
  };
  player: {
    defaultSpawnX: number;
    defaultSpawnY: number;
    maxHealth: number;
    maxStamina: number;
    staminaRegenPerSec: number;
    inventoryCapacity: number;
  };
  /** Per-client network tuning. */
  network: {
    /** Exponential moving average alpha for per-session RTT estimation (0–1). Lower = smoother. */
    rttEmaAlpha: number;
  };
  /** Client-side prediction correction smoothing. */
  prediction: {
    /** Half-life of the render-offset correction in milliseconds. Lower = snappier. */
    correctionHalfLifeMs: number;
    /** Divergences above this (world units) snap immediately instead of smoothing. */
    hardSnapThresholdUnits: number;
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
    /** World units between consecutive waypoints in an NPC plan. */
    waypointSpacing: number;
    /** Distance² at which a waypoint is considered reached. */
    waypointArrivalDistSq: number;
    /** Ticks before a wander / flee / seek plan expires and is rebuilt. */
    planExpiryTicks: number;
    /** Ticks before an attack plan expires; shorter = more responsive tracking. */
    attackPlanExpiryTicks: number;
    /** If the attack target moves further than this² from lastKnown, replan. */
    attackReplanDistSq: number;
    /** Max NPC plans built per tick — prevents replan spikes. */
    replanBudgetPerTick: number;
    /** Radius (world units) used for food/water/target spatial scans. */
    seekScanRadius: number;
  };
}

// ---- tile layout ----

/** A trader listing attached to a TileEntityConfig. */
export interface TileTraderListing {
  itemType: string;
  buyPrice: number;
  sellPrice: number;
  stock: number;
}

/**
 * One entity placement in a tile layout.
 * Used for both persistent spawns (resource nodes, workstations) and
 * transient spawns (NPCs, re-spawned on every server start).
 */
export interface TileEntityConfig {
  /** Matches an EntityTemplate id — determines which components are written. */
  entityTemplateId: string;
  x: number;
  y: number;
  /** World-unit height. Defaults to 4.0 (slightly above ground). */
  z?: number;
  /** Display name override applied to NPC entities after spawn. */
  name?: string;
  /** When present, attaches a TraderInventory component to this entity. */
  traderListings?: TileTraderListing[];
}

/**
 * Declarative tile population config loaded from tile_layout.json.
 *
 * entities — persistent: resource nodes, workstations, static props.
 *            Only spawned when the tile has no saved world state.
 * npcs     — transient: NPCs are re-spawned on every server start from this
 *            list (or procedurally if absent/empty), so they are never stale.
 *
 * proceduralNodes — when true, procedural zone-based node scatter runs in
 *   addition to the explicit entities list (default false).
 * proceduralNpcs  — when true, procedural zone-based NPC scatter runs in
 *   addition to the explicit npcs list (default false).
 */
export interface TileLayout {
  tileId: string;
  entities: TileEntityConfig[];
  npcs: TileEntityConfig[];
  proceduralNodes?: boolean;
  proceduralNpcs?: boolean;
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
 * A named scalar parameter that scales one rest-axis of a set of bones,
 * producing procedural body proportion variation from a seed.
 *
 * Entity-local axes: x = right, y = forward, z = up.
 * The resolved value is sampled in [min, max] via resolveMorphParams().
 */
export interface MorphParamDef {
  /** Unique name referenced by resolveMorphParams() results. e.g. "armLength". */
  id: string;
  /** Bone IDs whose rest offset is multiplied along restAxis. */
  bones: string[];
  /** Which entity-local rest component to scale. */
  restAxis: "x" | "y" | "z";
  /** Minimum multiplier (e.g. 0.8 = 20% shorter). */
  min: number;
  /** Maximum multiplier (e.g. 1.25 = 25% longer). */
  max: number;
}

/**
 * Skeleton archetype — defines the bone hierarchy shared across all visual
 * variants of a character type.  Animations reference bones by id.
 * One archetype per character type (human, dwarf, spider, …).
 */
export interface SkeletonDef {
  id: string;
  bones: BoneDef[];
  /** Named bone subsets for animation layer masking. Empty = all bones. */
  boneMasks?: BoneMask[];
  /** Named animation clips that belong to this skeleton archetype. */
  clips?: AnimationClip[];
  /**
   * IK chains defined for this skeleton.
   * Weapon actions and other systems activate chains by ID via DriveContext.
   * The skeleton owns bone names and pole hints; activators only reference chain IDs.
   */
  ikChains?: IKChainDef[];
  /**
   * Procedural proportion parameters sampled from ModelRef.seed via resolveMorphParams().
   * Each param scales a named rest axis on a set of bones, enabling unique body shapes
   * without authoring separate skeleton files per variant.
   */
  morphParams?: MorphParamDef[];
}

// ---- animation clip system ----

/** One keyframe in an animation bone track. time is normalized [0, 1] over the clip. */
export interface AnimationKeyframe {
  /** Normalized position within the clip [0, 1]. */
  time: number;
  /** Euler rotation X (radians) — pitch. */
  rotX: number;
  /** Euler rotation Y (radians) — yaw. */
  rotY: number;
  /** Euler rotation Z (radians) — roll. */
  rotZ: number;
}

/** A named animation clip. Each entry in tracks animates one bone by ID. */
export interface AnimationClip {
  /** Unique within the skeleton. e.g. "idle", "walk", "death", "carry", "hit_front". */
  id: string;
  /** Locomotion and idle clips loop; death/hit/carry one-shots do not. */
  loop: boolean;
  /**
   * Real-time duration of one full cycle, in seconds.
   * The AnimationSystem uses this to advance normalized time [0,1] at the correct rate.
   * Omit or set to 1.0 for clips whose speed is driven by speedScale on the layer.
   */
  durationSeconds?: number;
  /**
   * Per-bone animation tracks. Key = BoneDef.id. Only bones that actually
   * move need entries — static bones can be omitted (rest pose assumed).
   */
  tracks: Record<string, AnimationKeyframe[]>;
}

/** A named subset of bone IDs for animation layer masking. */
export interface BoneMask {
  /** Referenced by AnimationLayer.maskId. e.g. "upper_body", "lower_body". */
  id: string;
  /** IDs of bones included in this mask. Children are NOT automatically included. */
  boneIds: string[];
}

/**
 * One layer in an entity's animation layer stack.
 * Layers are evaluated bottom→top.  Higher layers override lower layers for
 * their masked bones (override blend) or add rotations on top (additive blend).
 */
export interface AnimationLayer {
  /** References AnimationClip.id within the entity's skeleton's clips array. */
  clipId: string;
  /** References BoneMask.id. Empty string means full body (no masking). */
  maskId: string;
  /** Normalized time position within the clip [0, 1]. Advanced by AnimationSystem each tick. */
  time: number;
  /** Blend weight [0, 1]. 1.0 = fully replace lower layers on masked bones. */
  weight: number;
  /** override: lerp toward this layer's pose. additive: add rotations on top of lower layers. */
  blend: "override" | "additive";
  /**
   * Clip playback speed.
   * A number = fixed multiplier (1.0 = real time at 20 Hz).
   * "velocity" = plays proportional to entity speed / speedReference.
   */
  speedScale: number | "velocity";
  /**
   * Reference speed (world units/tick) for "velocity" speedScale.
   * The clip advances at 1.0 rate when entity speed equals speedReference.
   * Only used when speedScale === "velocity".
   */
  speedReference?: number;
}

// ---- animation state ----

/**
 * Written by AnimationSystem each tick. The client skeleton evaluator reads
 * this to evaluate the animation layer stack and compute the bone pose.
 *
 * layers: the full ordered animation layer stack (bottom→top).
 *   AnimationSystem manages time advancement and layer selection each tick.
 *   evaluateAnimationLayers() evaluates this on both server (HitboxSystem)
 *   and client (skeleton_evaluator.ts) to produce bone rotations.
 *
 * weaponActionId + ticksIntoAction: drive weapon arm IK and trail rendering.
 *   Both are "" / 0 when not attacking. These are kept outside the layer
 *   stack because they drive geometry (arm position, blade path), not clips.
 */
export interface AnimationStateData {
  /** Animation layer stack — evaluated bottom→top by evaluateAnimationLayers(). */
  layers: AnimationLayer[];
  /**
   * WeaponActionDef id driving the current attack (e.g. "unarmed", "slash_r").
   * Empty string when not attacking.
   * Used by HitboxSystem and the client to look up swingPath keyframes + ikTargets.
   */
  weaponActionId: string;
  /** Elapsed ticks since the current attack started. 0 when not attacking. */
  ticksIntoAction: number;
}
