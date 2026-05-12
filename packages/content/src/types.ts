/**
 * Core content type definitions.
 *
 * These are the schemas for all data-driven game content: materials, models,
 * recipes, prefabs, lore, item templates. Actual data lives in
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
  /** Categorical tags. Indexed by ContentRegistry.byTag() (T-174). */
  tags?: readonly string[];
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
  /**
   * Per-instance morph param overrides (T-180). Set at spawn from
   * `prefab.morphValues`; takes precedence over the seed-randomized values
   * computed by `resolveMorphParams`. Lets a single canonical skeleton
   * (the biped archetype) carry many distinct creatures by varying
   * proportions: drowner gets longer arms, rotten knight gets a giant
   * right arm, human gets defaults. Networked so server and client morph
   * identically.
   */
  morphValues?: Record<string, number>;
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
 * Which equipment slot an item occupies when equipped.
 * Matches the field names on EquipmentData in @voxim/codecs.
 */
export type EquipSlot = "weapon" | "offHand" | "head" | "chest" | "legs" | "feet" | "back";

// ---- item behaviour data interfaces ----
// These are the data shapes for the server-only template components declared in
// packages/tile-server/src/components/item_behaviours.ts. They live here so
// both @voxim/content (store accessor) and @voxim/tile-server (defineComponent)
// can share the types without creating a circular dependency.

export interface EquippableData { slot: EquipSlot; }

/**
 * One step in a weapon's combo chain — Vermintide-style. A press of the
 * attack button advances the chain by one step and fires either the
 * `light` or `heavy` action depending on how long the windup was held.
 *
 * Holding past `SwingableData.heavyChargeMs` flips the release into the
 * heavy variant; a quick tap takes the light variant. Each weapon
 * authors its own chain — sword: horizontal → diagonal → thrust →
 * heavy_overhead, axe: chop → cleave, etc.
 */
export interface SwingChainEntry {
  /** WeaponActionDef id played for a tap-release at this chain step. */
  light: string;
  /** WeaponActionDef id played for a hold-past-threshold release. */
  heavy: string;
}

export interface SwingableData {
  /**
   * Combo chain. Each press advances index by 1 (mod length). Chain
   * resets when the actor reaches idle without a queued press, on
   * block, on stagger, on death, or when a maneuver starts.
   */
  chain: SwingChainEntry[];
  /**
   * Windup elapsed in ms above which release fires the entry's heavy
   * variant. Below threshold → light. Per-weapon: a heavy axe wants a
   * long charge (~600 ms) to feel committed; a quick dagger wants a
   * short one (~150 ms).
   */
  heavyChargeMs: number;
  /**
   * Base damage per hit when the weapon connects. Optional to keep
   * non-damaging swingables (placeholders, debug items) representable.
   * `deriveItemStats` exposes this as `DerivedItemStats.damage`,
   * scaled by the per-instance quality multiplier.
   */
  damage?: number;
}
export interface ToolData { toolType: string; }
export interface DeployableData { prefabId: string; }
export interface PlaceableData {
  /**
   * How the placed entity's position is derived.
   *   "forward-facing" — spawn in front of the placer along their facing,
   *                      offset by GameConfig.crafting.deployOffsetWorldUnits.
   *                      Used for workstations and freestanding deployables.
   *   "cell-aligned"   — snap the target worldX/worldY to integer cell center.
   *                      Used for blueprints that must occupy a grid cell.
   */
  alignment: "forward-facing" | "cell-aligned";
  /**
   * When set, the placer must have a weapon whose derived toolType matches.
   * Blueprints require "hammer". Deployables typically require nothing.
   */
  requiresToolType?: string;
  /**
   * Override the placement reach (world units). Falls back to
   * GameConfig.building.maxReachWorldUnits when omitted.
   */
  reach?: number;
  /**
   * When true, reject placement if another Blueprint entity already occupies
   * the target cell. Only meaningful with alignment="cell-aligned".
   */
  cellMustBeEmpty?: boolean;
  /**
   * Client-side build-mode tool used for this blueprint:
   *   "single"   — LMB places one instance at the cursor cell. Default.
   *   "polyline" — LMB sets corner anchors; segments commit immediately
   *                 along the line between the previous anchor and the new
   *                 one. RMB pops the last anchor, ESC clears the chain.
   *
   * The server doesn't read this field — placement is one Place command per
   * cell either way. The client renders ghost previews accordingly.
   */
  tool?: "single" | "polyline";
}
export interface EdibleData { food: number; water: number; health: number; stamina: number; }
export interface IlluminatorData { radius: number; color: number; intensity: number; flicker: number; }
export interface ArmorData { reduction: number; staminaPenalty: number; }
export interface MaterialSourceData { materialName: string; }
export interface ComposedData { slots: ItemSlotDef[]; }
export type StackableData = Record<never, never>;
export interface WeightData { baseWeight: number; }

// ---- recipes ----

/**
 * One input slot of a recipe. Exactly one of `itemType` (exact prefab id) or
 * `category` (loose filter, optionally narrowed by `tags`) must be set.
 *
 * `role` distinguishes multiple inputs in the recipe so its formula can refer
 * to one specifically (e.g. `stave.flexibility`, `string.tensile`). Roles are
 * unique within a recipe.
 */
export type RecipeInput =
  | {
    itemType: string;
    category?: never;
    tags?:    never;
    role:     string;
    quantity: number;
  }
  | {
    itemType?: never;
    category:  string;
    tags?:     string[];
    role:      string;
    quantity:  number;
  };

/**
 * One output of a recipe. `stats` declares the per-output stat formulas —
 * each value is a string parsed by the formula DSL (see `formula.ts`). At
 * craft completion the formulas are evaluated against a scope built from
 * input role stats, tool stats, workstation stats, and player skill levels;
 * the resulting numbers are written onto the output item entity's `Stats`
 * instance component, making the output non-stackable when present.
 */
export interface RecipeOutput {
  itemType: string;
  quantity: number;
  stats?:   Record<string, string>;
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

// ---- weapon actions ----

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
  /**
   * Where the projectile originates in entity-local (fwd, right, up) coordinates.
   * Lets each weapon declare its own muzzle (e.g. bow string, spear tip, wand tip).
   * Absent = combat.projectileDefaults.spawnOffset is the fallback.
   */
  spawnOffset?: { fwd: number; right: number; up: number };
}

/**
 * Blade endpoints in hand-bone-local solver space. Hit detection (server)
 * transforms these by the holding-hand's world matrix at the swing's curr
 * and prev tick clip times, then sweeps a capsule between the four points.
 *
 * Solver space: x=right, y=up, z=-fwd. baseLocal is typically near (0,0,0)
 * — where the blade meets the hand — and tipLocal extends along the
 * blade-axis direction the rest pose's hand "points" in.
 */
export interface WeaponBladeDef {
  /** Hand-local point where the blade meets the hand. */
  baseLocal: [number, number, number];
  /** Hand-local point at the blade tip. */
  tipLocal: [number, number, number];
  /** Capsule radius in world units. */
  radius: number;
}

/**
 * Physics definition for one weapon archetype (melee or ranged).
 * Drives the three-phase swing (windup → active → winddown), the swing
 * animation clip, and the blade-capsule geometry attached to the holding
 * hand.
 *
 * For melee: the SM combat layer plays `clipId`; on each active tick,
 * ActionSystem evaluates the clip on the attacker's skeleton, reads the
 * holding hand's world transform, and sweeps a capsule between
 * `blade.baseLocal` → `blade.tipLocal` at this tick and last tick. Same
 * lag-comp rewind mechanism as before — just with a clip-driven blade
 * path instead of a parametric swingPath.
 *
 * For ranged: `projectile` config drives spawn on first active tick; no
 * blade sweep.
 *
 * Weapons reference this by id via the Swingable component (`weaponActionId` field).
 */
export interface WeaponActionDef {
  id: string;
  /** Ticks the attacker is committed before the blade becomes active. Telegraphs to defenders. */
  windupTicks: number;
  /** Ticks the blade is active. Each target body part can be hit at most once per swing. */
  activeTicks: number;
  /** Ticks of recovery after the active phase before the action is complete. */
  winddownTicks: number;
  /**
   * Animation clip id played by the CSM combat layer during this swing.
   * Looked up in the entity's skeleton archetype's animation library.
   * Optional for now — actions without a clipId fall back to the
   * actor-prefab `weapon.swing_clip` slot during the transition window.
   */
  clipId?: string;
  /**
   * Blade geometry in hand-bone-local solver space. Required for melee
   * actions; absent for ranged. Hit detection transforms these endpoints
   * by the holding hand's world matrix each active tick.
   */
  blade?: WeaponBladeDef;
  /**
   * Bone the weapon (or attack-anchor for bites/claws) is attached to.
   * Hit detection reads this bone's world transform each active tick.
   * Default "hand_r". Use any bone id from the actor's skeleton; e.g.
   * "head" for a biter, "foot_r" for a kicker.
   */
  holdHand?: string;
  /** Flat stamina deducted when the action is initiated (before skill costs). */
  staminaCost: number;
  /** "melee" (default when absent) or "ranged". */
  actionType?: "melee" | "ranged";
  /** Projectile spawn parameters. Required for ranged, absent for melee. */
  projectile?: ProjectileActionConfig;
  /**
   * Root-motion forward impulse applied while the named phase is active
   * (T-199). The character is pushed forward along its facing direction at
   * `forwardImpulse` world units / sec for the full duration of the phase.
   * Suppressed proportionally by SpeedModifier so slows / encumbrance reduce
   * the carry. Absent / null → no push, swing is in-place.
   */
  rootMotion?: {
    forwardImpulse: number;
    phase: "windup" | "active" | "winddown";
  };
}

// ---- maneuvers (T-185) ----------------------------------------------------
//
// A *maneuver* is an authored, scheduled sequence of events spanning the
// per-hand SM layers, locomotion, and on-hit effects. Generalisation of
// WeaponActionDef: weapon swings are degenerate single-track maneuvers.
//
// A maneuver definition is a fixed-length timeline (`duration` seconds)
// with several track types. The runtime ManeuverScheduler advances elapsed
// each tick and emits whatever each track schedules at the current time:
//
//   tracks.right_hand[]  — { t, clip }      changes the SM's right_hand
//                                            in_maneuver clip at time t.
//   tracks.left_hand[]   — { t, clip }      same, left_hand layer.
//   tracks.locomotion[]  — { t, kind, ... } applies a locomotion impulse
//                                            (currently only "dash" forward).
//   tracks.hitEffects[]  — { tag, fromT, toT?, magnitude } stamps a tag
//                                            onto the entity's active hit
//                                            tag list while elapsed is in
//                                            range; hit handlers iterate
//                                            and apply the effect.
//
// `interruptWindows[]` declares time ranges during which specific input
// actions cancel the maneuver early (typed by name: "dodge", "block", …).
// An empty array means committed-through.

export interface ManeuverHandTrack {
  /** Time (s) into the maneuver this clip begins on the per-hand layer. */
  t: number;
  /** Clip id (or "$slot" reference) to play. Empty string clears the layer. */
  clip: string;
}

export interface ManeuverLocomotionTrack {
  t: number;
  /** "dash" — instantaneous forward impulse held for `duration` seconds. */
  kind: "dash";
  /** Forward distance covered over `duration` (m). */
  forward: number;
  duration: number;
}

export interface ManeuverHitEffect {
  /** Tag passed to hit handlers; the effect resolver maps tags to outcomes. */
  tag: string;
  fromT: number;
  toT?: number;          // omitted = active until maneuver ends
  magnitude: number;
}

export interface ManeuverInterruptWindow {
  fromT: number;
  toT: number;
  /** Action names that cancel: "dodge", "block", "jump", … */
  by: string[];
}

export interface ManeuverRequirements {
  /** Stamina deducted on initiation. */
  stamina?: number;
  /** True ⇒ entity must have a weapon equipped in the main hand. */
  rightWeapon?: boolean;
  /** True ⇒ entity must have an off-hand item equipped. */
  leftWeapon?: boolean;
}

export interface ManeuverDef {
  id: string;
  duration: number;
  interruptWindows: ManeuverInterruptWindow[];
  tracks: {
    right_hand: ManeuverHandTrack[];
    left_hand:  ManeuverHandTrack[];
    locomotion: ManeuverLocomotionTrack[];
    hitEffects: ManeuverHitEffect[];
  };
  requirements: ManeuverRequirements;
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

// ---- character state machine ----

/**
 * What a layer's nodes project to.
 *
 *   "animation" — contributes one bone-masked clip slot to AnimationLayer[].
 *   "flag"      — exposes the current node as a queryable enum for other
 *                 systems (read via csm.<layer> in DSL or via runtime API).
 *   "mode"      — internal-only; visible to other layers' transitions but
 *                 produces no external output.
 */
export type SMLayerOutput = "animation" | "flag" | "mode";

/**
 * Semantic role a layer plays in the actor's behaviour. Orthogonal to
 * `SMLayerOutput` (which describes the projection target).
 *
 *   "base-locomotion" — the default body motion (idle / walk / strafe / jump).
 *                       At most one per SM.
 *   "action"          — a committed action sequence: swings, casts, channels,
 *                       throws. Action layers are the natural host of payload
 *                       components (SwingContext etc.) and are gated by
 *                       ActionSystem for input admissibility.
 *   "reaction"        — overlays driven by external events: stagger, hit
 *                       react, death. Highest authority over the body.
 *   "posture"         — slow-changing body mode (upright / crouched / prone).
 *   "flag"            — pure cross-layer signalling; no external semantics.
 *
 * Used by validation (T-194) and by systems that act on layer category
 * rather than layer id.
 */
export type SMLayerKind =
  | "base-locomotion"
  | "action"
  | "reaction"
  | "posture"
  | "flag";

/**
 * One state in a CSM layer.
 *
 * `clip` and `loop` are only meaningful for layers with output: "animation".
 * `duration` (in seconds) exposes itself as `state.duration` to transition
 * expressions on this layer; useful for "play-out" semantics like
 * `state.elapsed >= state.duration` triggering the next transition.
 */
export interface SMState {
  /**
   * Clip slot reference. Use "$slotName" to reference a slot resolved via
   * `prefab.animationSlots`. A bare clip id is also accepted. Null or absent
   * means no animation contribution. Ignored for non-animation layers.
   */
  clip?: string | null;
  /** Loop the clip when the time reaches 1. Default false. */
  loop?: boolean;
  /**
   * Optional duration in seconds, exposed as `state.duration` in transition
   * expressions. 0 / absent = unlimited (state never auto-exits). When a
   * string (e.g. `"$action.windup_seconds"`), the value is looked up in the
   * SM scope at tick time — lets swing-phase durations come from the
   * equipped weapon's WeaponActionDef rather than being hardcoded in JSON.
   */
  duration?: number | string;
  /** Realign root bone on state-enter. Used by "roll" to face the dodge dir. */
  rotateRoot?: "velocity.dir";
  /**
   * Override the parent layer's bone mask for this state.
   *   undefined = inherit `SMLayer.mask`
   *   ""        = full body (no mask), even if the layer carries one
   *   "<id>"    = override with the named mask
   *
   * Lets a single layer mix masked and unmasked states — e.g. the combat
   * layer's `block` state overrides only the upper body via the layer's
   * upper_body mask, while its `swing.*` states override the whole body
   * (since a swing's hip twist + leg drive are part of the motion).
   */
  mask?: string;
  /**
   * Clip playback rate. A number is a fixed multiplier (1 = one full clip
   * cycle per second). "velocity" scales by entity speed / speedReference,
   * letting walk/run cycles match foot-plant cadence. Default 1.
   */
  speedScale?: number | "velocity";
  /** Reference speed for "velocity" speedScale (world units / sec). */
  speedReference?: number;
  /**
   * Conditional partial overrides applied to this state when the condition
   * matches. Key is a DSL condition; value is a partial of SMState replacing
   * the listed fields while the condition holds. Multiple matching overrides
   * apply in JSON declaration order; later ones win on conflicts.
   *
   * Example: `{ "csm.posture == crouched": { "clip": "$crouch_idle" } }`
   * swaps the clip when crouched without authoring a separate state.
   */
  paramOverrides?: Record<string, Partial<SMState>>;
  /**
   * Author-declared tags that expose state semantics to gameplay systems.
   * Replaces string-prefix matching on state names ("swing.windup",
   * "swing.active", ...) with declared categories.
   *
   * Standard vocabulary:
   *   - "action"               — state is part of a committed action; payload
   *                              components are bound to this category
   *   - "carries_swing_context"— SwingContext payload exists while in this state
   *   - "active_hitbox"        — hit-detection systems should run this tick
   *   - "chain_queueable"      — holding the action input during this state
   *                              queues the next chain step (post-windup phases)
   *   - "locks_input"          — PhysicsSystem zeros movement input here
   *                              (stunned, frozen, sleeping, dead)
   *   - "locks_facing"         — facing input ignored (committed swings)
   *   - "i_frame"              — hit handlers skip this entity as a target
   *
   * Tag identifiers are snake_case (no hyphens) so they tokenise as valid
   * DSL identifiers — transitions can read e.g. `csm.right_hand.action`,
   * `csm.right_hand.active_hitbox` as booleans.
   *
   * The set of distinct tags used by any state in a layer is exposed as
   * scope booleans on every tick: `csm.<layer>.<tag>` is true iff the
   * current node carries that tag.
   */
  tags?: string[];
}

/**
 * One transition rule in a layer.
 * Evaluated each tick; the first matching transition (highest priority,
 * declaration order on tie) is taken.
 */
export interface SMTransition {
  /**
   * Source state(s). String or array of strings. Omit (or "*") for "any
   * state" (still constrained by transitions only firing if the from differs
   * from the to, to avoid no-op cycling).
   */
  from?: string | string[] | "*";
  to: string;
  /** DSL expression — see sm_expression.ts. */
  when: string;
  /** Higher priority wins when multiple transitions match in one tick. Default 0. */
  priority?: number;
}

/**
 * One layer of a CSM.
 * Layers are independent axes of state; their nodes compose without exploding
 * into N×M states.
 */
export interface SMLayer {
  /** Unique within the SM. e.g. "locomotion", "combat", "reaction", "posture". */
  id: string;
  /** Semantic role — see {@link SMLayerKind}. Required. */
  kind: SMLayerKind;
  output: SMLayerOutput;
  /** BoneMask id for animation layers. Empty / absent = full body. Ignored for flag/mode. */
  mask?: string;
  /** Animation layer override priority (higher = on top). Ignored for flag/mode. Default 0. */
  priority?: number;
  /** Initial state id. Must be a key of `states`. */
  initial: string;
  /** All states in this layer, keyed by state id. */
  states: Record<string, SMState>;
  /** Transition rules. */
  transitions: SMTransition[];
}

/**
 * A Character State Machine definition.
 *
 * Authored as JSON in `data/state_machines/{id}.json` and registered on
 * ContentService.stateMachines. Each actor prefab references one via
 * `stateMachineId`; the runtime maintains per-actor layer state and projects
 * animation-typed layers into AnimationLayer[] for rendering.
 *
 * The CSM is the shared mode-tracking layer for every actor (player, NPC,
 * mob, critter, animal). Animation is one consumer; gameplay systems also
 * read CSM nodes to gate behavior (block mitigation, swing admissibility,
 * crouch-speed scaling, etc.).
 */
export interface StateMachineDef {
  id: string;
  layers: SMLayer[];
}

// ---- buffs (T-196) ----

/**
 * Declarative buff definition. Loaded from `data/buffs/{id}.json`.
 *
 * Bridges the existing `EffectApplyHandler` registry with a content-driven
 * authoring shape: a buff is named, durations + magnitudes live in JSON,
 * and the apply path is dispatched by `effectStat` to the same handlers
 * the lore matrix uses. Adding a new simple status effect is now a file
 * drop — no code if it reuses an existing effectStat.
 *
 * The discrete-event channel (`onApplyEvent`) lets a buff push a one-tick
 * event into the CSM scope at apply time. That's how a stun buff triggers
 * the reaction layer's `event.stunned` transition while also slowing the
 * actor via the speed effectStat.
 */
export interface BuffDef {
  /** Unique id. Filename without `.json`. */
  id: string;
  /** Display name for UI / debug. */
  displayName: string;
  /**
   * Effect handler dispatched by `applyBuffById`. Must be a registered
   * `EffectApplyHandler` id at server boot — validated, fails fast on
   * mismatch. Common values today: "speed", "health", "shield".
   */
  effectStat: string;
  /** Effect strength passed to the handler as `ctx.magnitude`. */
  magnitude: number;
  /** Duration in seconds — converted to ticks at apply time. */
  durationSeconds: number;
  /**
   * One-tick event fired on the target's TickEventBuffer when the buff is
   * applied. Lets the CSM react discretely (e.g. `event.stunned` driving
   * a reaction-layer transition) in addition to the continuous modifier
   * channel. Absent / null = no event.
   */
  onApplyEvent?: string;
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
  /** Movement speed multiplier applied at spawn (default 1.0). */
  speedMultiplier?: number;
  /** Item type to equip as weapon at spawn (e.g. "wolf_bite"). Null/absent = unarmed. */
  weaponItemType?: string;
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

/** Harvest/resource-node behaviour data. Lives inside Prefab.components.resourceNode. */
export interface PrefabResourceNodeData {
  hitPoints: number;
  yields: ResourceNodeYield[];
  requiredToolType: string | null;
  respawnTicks: number | null;
}

/**
 * NPC component — links a prefab to an NPC archetype.
 * All AI tuning lives in the referenced NpcTemplate; this just says "spawn one of these".
 */
export interface PrefabNpcData {
  /** ID of the entry in npc_templates.json that drives this NPC's behaviour. */
  npcType: string;
}

/**
 * Player archetype component — flags a prefab as the player character type and
 * declares the starter loadout written at spawn. Read by the `player` installer
 * in spawnPrefab; the actual character identity (id, heritage, spawn position)
 * is supplied as spawn-time overrides, not declared in the prefab.
 */
export interface PrefabPlayerData {
  /** Prefab ids written to each slot of Inventory at spawn. */
  startingInventory: Array<{ itemType: string; quantity: number }>;
  /** Items written to Equipment at spawn. Keys match EquipSlot. */
  startingEquipment?: Partial<Record<"weapon" | "offHand" | "head" | "chest" | "legs" | "feet" | "back", string>>;
}


/**
 * Prefab — declarative definition of a spawnable world entity.
 *
 * One prefab file per id in `data/prefabs/*.json`. Referenced by
 * `tile_layout.json`, by recipe outputs, by item `deploysTo`, and by any
 * caller of `spawnPrefab`. The prefab IS the archetype — looked up at
 * runtime (e.g. during harvest for yields) as well as at spawn.
 *
 * `components` is deliberately an open-set dictionary: the loader
 * validates each entry against `@voxim/tile-server`'s component registry
 * (see `DEF_BY_NAME`). Unknown keys fail at content-load, not at runtime.
 * A handful of well-known "archetype" keys (resourceNode, npc,
 * workstation) carry shapes that aren't directly runtime components —
 * `spawnPrefab` interprets them. The rest are component data, written
 * to the entity as-is.
 *
 * Prefab inheritance (`extends`) is honoured by the loader — the chain is
 * resolved root-to-leaf and `components` (plus top-level `modelId` /
 * `modelScale`) are deep-merged so child prefabs can override specific keys
 * without re-declaring the whole tree.
 */
export interface Prefab {
  id: string;
  /**
   * Parent prefab id. The loader resolves the chain root-to-leaf and
   * deep-merges `components` (and top-level `modelId` / `modelScale`) so a
   * child overrides only the fields it declares. Cycles fail loud at load.
   *
   * Prefabs whose id begins with `_` are *abstract* — they participate in
   * inheritance but cannot be spawned directly. `spawnPrefab("_foo")` throws.
   */
  extends?: string;
  /**
   * Model to render this entity with. Optional — absent means no visual
   * representation (placeholder/invisible entity).
   */
  modelId?: string;
  /** Multiplier applied on top of the base entity scale at spawn. Defaults to 1. */
  modelScale?: number;
  /**
   * Per-prefab animation slot map: AnimationSystem slot name → clipId on the
   * entity's skeleton.  Lets two prefabs sharing the same skeleton play
   * different clips for the same gameplay state — e.g. `walk_zombie` for a
   * zombie prefab versus `walk_normal` for the player.  Slots not present
   * here fall through to the slot name itself as the clip id (back-compat).
   */
  animationSlots?: Record<string, string>;
  /**
   * Character State Machine driving this actor's mode (locomotion, combat,
   * posture, reaction). References a `StateMachineDef.id` on
   * ContentService.stateMachines. Inherited from parent prefab via `extends`
   * unless overridden. Absent for non-actor prefabs (props, items, blueprints).
   */
  stateMachineId?: string;
  /**
   * Per-prefab morph param overrides (T-180). At spawn, the spawner copies
   * these values onto `ModelRefData.morphValues` so server and client both
   * see the same morphs over the wire. Keys must match
   * `SkeletonDef.morphParams[].id`; unknown keys are ignored. Lets one
   * canonical skeleton (e.g. the biped archetype) drive every humanoid:
   * drowner sets `armLength: 1.4`, rotten knight sets `rightArmScale: 1.5`,
   * human leaves defaults.
   */
  morphValues?: Record<string, number>;
  /**
   * Per-prefab morph variation ranges (T-190). At spawn, the spawner
   * samples a value from each `[min, max]` window using a per-entity
   * deterministic RNG and writes the result onto `ModelRefData.morphValues`
   * — so every PC instance of a prefab has slightly different proportions,
   * but a given entity respawns/reloads with the same body. Per-prefab
   * `morphValues` (above) still wins per-key (those are explicit overrides;
   * a value AND a range on the same key uses the value).
   *
   * Keys must match `SkeletonDef.morphParams[].id`. Inherited from parent
   * prefab via `extends`, shallow-merged per key.
   */
  morphRanges?: Record<string, { min: number; max: number }>;
  /**
   * Generic category. Recipes match inputs by category (e.g. "wood",
   * "cordage", "ingot"). Loose filter — no central schema, just convention.
   */
  category?: string;
  /**
   * Set-of-strings refinement on top of `category`. Recipes can require
   * tags within a category ("organic", "elastic", "fire-resistant"). Order
   * is irrelevant; duplicates are ignored at load.
   */
  tags?: string[];
  /**
   * Per-instance numeric stats. For raw-material prefabs (logs, ingots,
   * fibres) these values are copied onto the entity at spawn as the
   * authoritative defaults. Crafted intermediates leave this absent —
   * their stats are computed by the originating recipe's formula. The
   * recipe-graph validator (T-124) catches references to stats that no
   * upstream producer (prefab default OR recipe formula output) emits.
   */
  stats?: Record<string, number>;
  /**
   * Open-set component dictionary. Each key is either a `ComponentDef.name`
   * registered in the tile-server component registry (written directly at
   * spawn) or a known compound-archetype key consumed by `spawnPrefab`'s
   * installer chain (`player`, `npc`, `resourceNode`, etc.). The loader
   * validates the shape of each entry against the matching component's
   * schema — unknown keys and schema violations both fail at content-load.
   */
  components: Record<string, unknown>;
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
 * Accessed via ContentService.getGameConfig().
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
    /**
     * Fallback projectile spawn parameters used only when a ranged weapon
     * action has no explicit ProjectileActionConfig.spawnOffset. Values are
     * entity-local (fwd, right, up) coordinates applied via localToWorld
     * from the shooter's facing — i.e. approximately "from the shoulder, forward".
     */
    projectileDefaults: {
      spawnOffset: { fwd: number; right: number; up: number };
      /** For projectiles with gravity, multiplies speed to seed an upward arc. */
      arcFactor: number;
    };
    /**
     * Poise — the staggering resource (T-197). Damage reduces poise; when
     * poise hits zero the actor staggers (CSM reaction layer transitions to
     * `stagger.light` or `stagger.heavy` based on how much the breaking hit
     * overshot remaining poise) and poise resets to max with a brief
     * regen-disabled window before recovery starts.
     */
    poise: {
      /** Max poise — also the starting value. */
      max: number;
      /** Regen per second, applied while regen isn't suppressed. */
      regenPerSec: number;
      /** No-regen window in seconds after a stagger break, so the actor can't
       * immediately recover and avoid follow-up staggers. */
      regenDisabledSecondsAfterBreak: number;
      /** Damage overshoot (damage − remaining_poise) at break time that
       * separates `stagger.light` from `stagger.heavy`. >= this → heavy. */
      heavyTierDamageOvershoot: number;
    };
    /**
     * Per-part damage multipliers (T-198). The hit handler multiplies the
     * base damage by attacker.{tip|mid|haft} × victim.{partId}. Unknown
     * part names fall back to 1.0 so authoring new hitbox parts doesn't
     * silently break existing damage math.
     */
    partMultipliers: {
      attacker: { tip: number; mid: number; haft: number };
      victim:   Record<string, number>;
    };
  };
  dodge: {
    staminaCost: number;
    iFrameTicks: number;
    sidestepTicks: number;
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
    /**
     * XY radius of the soft-collision capsule applied to every moving entity
     * (players + NPCs). Pairs whose centres come within (rA + rB) get pushed
     * apart along the connecting axis after `stepPhysics` runs. Z is ignored —
     * collision is purely horizontal so jumping over another entity still works.
     */
    entityCollisionRadius: number;
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
    /** Clip speedScale for the death animation (plays once, clamps at 1.0). */
    deathSpeedScale: number;
    /** Clip speedScale for the stationary idle loop. */
    idleSpeedScale: number;
    /** Clip speedScale for the stationary crouch loop. */
    crouchSpeedScale: number;
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
  /** Server-side persistence tuning — autosave cadence and future knobs. */
  persistence: {
    /** Autosave cadence in server ticks. 0 disables autosave (save on shutdown only). */
    saveIntervalTicks: number;
  };
  /** World / rendering scale defaults shared by server and client. */
  world: {
    /** Default entity model scale when no per-template override is set. */
    defaultEntityScale: number;
  };
  /** Per-client network tuning. */
  network: {
    /** Exponential moving average alpha for per-session RTT estimation (0–1). Lower = smoother. */
    rttEmaAlpha: number;
    /** Radius in world units within which entities are visible to a client. */
    aoiRadius: number;
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
  /** Matches a Prefab id — determines which components are written. */
  prefabId: string;
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
 *
 * restX/Y/Z are the bone's rest-pose position in LOCAL parent space
 * (model coordinate units — same scale as VoxelNode positions).
 *
 * restRotX/Y/Z are the bone's rest-pose orientation in parent-local frame,
 * Euler XYZ in radians. Default 0/0/0 means identity (bone's local axes
 * align with parent's). Non-zero values let an imported source rig's bind
 * pose be encoded directly — e.g. a UAL2 thigh bone whose local Y points
 * along the bone gets its bind rotation here, so animation frames sampled
 * from glTF play 1:1 against our solver without retargeting.
 */
export interface BoneDef {
  id: string;
  parent: string | null;
  restX: number;
  restY: number;
  restZ: number;
  restRotX?: number;
  restRotY?: number;
  restRotZ?: number;
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
  /**
   * Animation archetype — names the AnimationLibrary this skeleton draws
   * clips from (T-178). Skeletons sharing an archetype share clips by
   * reference; e.g. drowner / rotten_knight / human all declare
   * `archetype: "biped"` and pull from `data/anim_library/biped/`.
   * Required.
   */
  archetype: string;
  bones: BoneDef[];
  /** Named bone subsets for animation layer masking. Empty = all bones. */
  boneMasks?: BoneMask[];
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

/**
 * Animation library — the catalog of clips for one skeleton archetype.
 * Multiple skeletons sharing the same archetype share the same library by
 * reference (T-178). Replaces the old per-skeleton `clips` field.
 *
 * Built once at content load by scanning `data/anim_library/{archetype}/`.
 * Compound clip recipes (additive / crossfade / phase_shift) bake into
 * plain clips at load; the runtime only sees plain clips.
 */
export interface AnimationLibrary {
  /** Archetype id, also serves as the registry key. */
  id: string;
  /** All plain clips in this archetype, keyed by clip id. */
  clips: Record<string, AnimationClip>;
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
   * WeaponActionDef id driving the current attack (e.g. "unarmed", "slash").
   * Empty string when not attacking. The client reads this to look up the
   * weapon's blade definition for trail / debug overlay rendering; hit
   * detection uses the same lookup server-side.
   */
  weaponActionId: string;
  /** Elapsed ticks since the current attack started. 0 when not attacking. */
  ticksIntoAction: number;
}
