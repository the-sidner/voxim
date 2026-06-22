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
  /** Max durability for a unique item entity (T-086) — the per-instance Durability ceiling.
   *  Explicit `durability` on swingable/tool/armor wins; else a default for any equippable item. */
  maxDurability?: number;
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

/**
 * Equip-slot candidates for an item, in priority order (T-187). The equip flow
 * lands the item in the first listed slot that is currently empty — so a weapon
 * declaring `["weapon", "offHand"]` fills the off-hand when the main hand is
 * taken, enabling dual-wield from the inventory. Single-element for everything
 * that lives in exactly one slot (armour: `["chest"]`).
 */
export interface EquippableData { slots: EquipSlot[]; }

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
   * The universal swing ActionDef this weapon triggers on attack (T-227).
   * Carries timing/cancel/movement/stamina; this weapon's `chain[0]`
   * still supplies blade geometry via its WeaponActionDef. Absent →
   * `swing_light`. (The combo `chain` below is retired into cancel-into
   * rules in a later refinement.)
   */
  swingActionId?: string;
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
/**
 * One entry in an item's effect payload (T-240). `id` names an action
 * effect resolver registered in the tile-server (`adjust_resource`, …);
 * `params` is that resolver's typed payload. The vocabulary that
 * procedural item generation targets — the same registry the action
 * substrate fires from. Lives on the prefab (stackable items) or an
 * `ItemEffects` instance component (unique items).
 */
export interface EffectSpec { id: string; params?: Record<string, unknown>; }
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
export type RecipeStepType = "attack" | "time" | "assembly" | "repair" | "treat";

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
  /**
   * Durability points restored to the repaired item per resolve, for
   * `stepType: "repair"` recipes (T-088). The recipe's `inputs` are the repair
   * materials (consumed); the item being repaired is the unique Durability-
   * bearing item in the buffer (kept, not consumed). Capped at the item's max,
   * so repeated repairs compound the material cost without ever overfilling.
   */
  repairAmount?: number;
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
   * Suppressed proportionally by `effective(moveSpeed)` so slows /
   * encumbrance reduce the carry. Absent / null → no push, swing is in-place.
   */
  rootMotion?: {
    forwardImpulse: number;
    phase: "windup" | "active" | "winddown";
  };
}

// ---- actions (T-225) ------------------------------------------------------
//
// The single primitive every character behavior instantiates — combat,
// movement, blocking, dodging, interacting, throwing, consuming, praying,
// being hit. Each ActionDef declares phases (windup/active/winddown for
// active actions; arbitrary names for others), per-phase cancel rules,
// per-phase movement lock, resource costs, priority, and an effect list
// dispatched on phase transitions.
//
// At T-225 this is content plumbing only — loader scans data/actions/, the
// type is exposed on ContentService, validation enforces internal
// consistency, the bootstrap blob carries actions to the client. No runtime
// use yet; ActiveAction + ActionDispatcher land in T-226.
//
// See ACTION_PRIMITIVE_PLAN.md for the full design.

/**
 * Movement permission during a phase. The runtime physics layer (T-232)
 * consults the current action's per-phase value to throttle locomotion:
 *   "free"   — full intent passes through
 *   "slowed" — multiplied by a global slow factor
 *   "locked" — zero
 */
export type ActionMovement = "free" | "slowed" | "locked";

/**
 * One phase of an Action. Iteration order follows declared key order in
 * `phases`. `ticks === -1` marks a perpetual phase (ambient actions only;
 * the dispatcher never advances past it).
 */
export interface ActionPhase {
  ticks: number;
}

/**
 * Cancel rule for a phase. `into` lists action ids the actor's intent may
 * interrupt this phase with. Glob prefixes are allowed (`"dodge_*"`) and
 * the literal token `"any"` opts in to anything. An empty list means the
 * phase is committed — only event-initiated reactions with higher
 * `interruptPriority` can break it (resolved at the dispatcher).
 */
export interface ActionCancelRule {
  into: string[];
  /**
   * Extra gates evaluated when an intent attempts this cancel. The cancel
   * fires only if the target action's `preconditions` AND these gates all
   * pass. Empty / absent → cancel governed by `into` + target preconditions
   * alone. (T-226)
   */
  gates?: ActionGate[];
}

/**
 * A typed predicate from the closed gate vocabulary (T-226). `gate` keys
 * into the gate registry installed by the runtime; `params` is the gate's
 * typed payload. There is no expression DSL and no boolean composition —
 * a condition the vocabulary can't express is a new registered gate, not
 * inline logic. Used in `ActionDef.preconditions` and `ActionCancelRule.gates`.
 */
export interface ActionGate {
  gate: string;
  params?: Record<string, unknown>;
}

/**
 * One effect dispatched on a phase transition. `phase` is
 * `"<phaseName>:<edge>"` where edge is `enter` / `exit` / `tick`. `kind`
 * keys into the effect resolver registry installed by the runtime (T-227).
 * `params` is the resolver's payload; content load does not interpret it.
 */
export interface ActionEffect {
  phase: string;
  kind: string;
  params?: Record<string, unknown>;
}

/**
 * Per-phase animation projection (T-226c). What the animation system needs
 * to emit one `AnimationLayer` for the phase, mirroring the fields the
 * retired CSM animation states carried:
 *
 *   - `clipId`     — clip ref; `$slot` resolves via the actor's
 *                    animationSlots, bare ids pass through.
 *   - `crouchClipId` — variant played while the `Crouched` tag is present.
 *                    Replaces the CSM's `csm.posture == crouched`
 *                    paramOverride (now an animation-side rule).
 *   - `loop`       — loop the clip (locomotion idle/walk/strafe) vs one-shot
 *                    (jump/landing/sidestep).
 *   - `speedScale` — `"velocity"` ties playback to ground speed (walk /
 *                    strafe); a number is clip-cycles/sec; absent on a
 *                    one-shot auto-fits 1/phase-duration (matches the old
 *                    `resolveSpeedScale`).
 *   - `mask`       — bone mask; absent = full body (locomotion had none).
 */
export interface ActionAnimation {
  clipId: string;
  crouchClipId?: string;
  loop?: boolean;
  speedScale?: number | "velocity";
  mask?: string;
}

/**
 * Action definition — the central content type for character behavior.
 *
 *   kind:
 *     "active"   — intent-driven, has a beginning and an end (swing,
 *                  dodge, consume, interact, pray)
 *     "reaction" — event-driven, carries `interruptPriority` so it can
 *                  break committed phases (hit-react flinch / stagger /
 *                  knockdown)
 *     "ambient"  — always running at low priority, never completes
 *                  (walk, idle, sprint). A perpetual phase uses
 *                  `ticks: -1` as the sentinel.
 *
 * Adding a new action is a file drop in `data/actions/{id}.json`. The
 * dispatcher walks the declared shape every time; no per-action code
 * branches exist below the dispatcher.
 */
export interface ActionDef {
  id: string;
  kind: "active" | "reaction" | "ambient";
  /**
   * Which actor slot this action occupies (`"locomotion"`, `"primary"`,
   * `"posture"`, …). The slot set is declared per actor template
   * (`Prefab.actorSlots`); the dispatcher rejects an action whose slot the
   * actor does not declare. Each slot holds ≤ 1 ActiveAction at a time. (T-226)
   */
  slot: string;
  /**
   * Animation metadata — which limbs this action drives, for the animation
   * system's bone routing. Slot ownership is unaffected: a `primary`-slot
   * action targeting `["right_hand"]` still excludes any other primary
   * action. Absent → the slot's conventional limb set. (T-226)
   */
  limbs?: string[];
  phases: Record<string, ActionPhase>;
  cancel: Record<string, ActionCancelRule>;
  movement: Record<string, ActionMovement>;
  costs?: Record<string, number>;
  /**
   * Per-action cooldown (T-260): ticks after a start before the same
   * action can start again on that actor. Checked by the dispatcher's
   * `canStart`, stamped on `start` (server-only `ActionCooldowns`
   * component). 0 / absent = none.
   */
  cooldownTicks?: number;
  /**
   * Whether starting this action raises the actor's global cooldown
   * (`game_config.lore.globalCooldownTicks`) — and is itself blocked while
   * the GCD is running. The WoW-style skill-bar lockout: skill actions set
   * this; swings/dodges don't. (T-260)
   */
  triggersGcd?: boolean;
  /** Default initiation priority (active/ambient actions). */
  priority?: number;
  /** Threshold for non-consent interruption (reactions). */
  interruptPriority?: number;
  /**
   * Gates evaluated at initiation. The action starts only if every gate
   * passes (plus resource `costs` are affordable). Closed-vocabulary typed
   * predicates — see `ActionGate`. (T-226)
   */
  preconditions?: ActionGate[];
  effects: ActionEffect[];
  animation?: Record<string, ActionAnimation>;
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



// ---- resources (T-238) ----

/**
 * A tick-scalar primitive: a bounded `value` that changes each tick by a
 * signed `rate` (regen +, decay/timer −), the rate optionally modulated by
 * a closed vocabulary of external `rateModifiers`, crossing named
 * `thresholds` that fire an effect through the shared EffectRegistry.
 * Collapses StaminaSystem / HungerSystem / PoiseSystem / the crafting
 * time-step timer into one system + data. See
 * RESOURCE_PRIMITIVE_PLAN.md.
 */
export interface ResourceDef {
  /** Unique id. Filename without `.json` (e.g. "stamina"). */
  id: string;
  /** Whose entity carries the value: an actor ("entity") or a per-tile singleton ("tile"). */
  scope: "entity" | "tile";
  bounds: { min: number; max: number };
  /** Signed per-SECOND base delta before modifiers (regen +, decay/timer −). */
  rate: number;
  /**
   * Closed-vocabulary rate modifiers, applied in order — each transforms
   * the running rate (scale / replace / offset). `kind` is a registered
   * `ResourceRateModifier` id, never inline logic (registry doctrine).
   */
  rateModifiers?: ResourceRateModifierRef[];
  /** Named edges that dispatch an effect through the shared EffectRegistry. */
  thresholds?: ResourceThreshold[];
}

export interface ResourceRateModifierRef {
  kind: string;
  params?: Record<string, unknown>;
}

export interface ResourceThreshold {
  /** The boundary value. */
  at: number;
  /** Which side of `at` the threshold's zone is. */
  dir: "above" | "below";
  /**
   * `cross` fires the effect once when the value enters the zone this tick;
   * `sustained` fires every tick the value is in the zone.
   */
  edge: "cross" | "sustained";
  /** Registered EffectResolver id (the same registry the action arc uses). */
  effect: string;
  params?: Record<string, unknown>;
}

// ---- triggers (T-259 — the fourth primitive) ----

/** One effect a trigger fires — `kind` is a registered action-effect
 * resolver id (the one T-246 registry). */
export interface TriggerEffect {
  kind: string;
  params?: Record<string, unknown>;
}

/**
 * A content-defined reactive coupling (`data/triggers/{id}.json`,
 * TRIGGER_PRIMITIVE_PLAN.md): when event `on` occurs and the trigger's
 * owner fills role `as`, and every `conditions` gate passes against the
 * owner, fire `effects` with the event's other party bound as target.
 * Attached to owners via sources (a weapon/armor prefab's `triggers[]`,
 * later inscriptions / zones / buffs).
 */
export interface TriggerDef {
  id: string;
  /** Event kind from the closed catalog (hit_landed / damage_taken /
   * entity_died, …) — boot-cross-checked. */
  on: string;
  /** Which event role binds to the owner (e.g. "attacker" | "target" |
   * "killer" | "victim"). */
  as: string;
  /** Gate refs tested against the owner (the action arc's gate registry). */
  conditions?: ActionGate[];
  /** Internal cooldown (ICD): ticks this trigger stays dormant after
   * firing. 0 / absent = none. */
  internalCooldownTicks?: number;
  effects: TriggerEffect[];
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
  /**
   * When true the biome never participates in overworld classification —
   * `classifyBiome` skips it regardless of `classifyRules`. Such a biome
   * is only ever reached by an explicit by-id lookup that FORCES it, e.g.
   * an instance tile (a cave) generating its enclosed terrain from a
   * single biome rather than the noise-driven overworld cascade (T-063).
   */
  instanceOnly?: boolean;
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
   * Stamina pool (T-255). Falls back to npcAiDefaults.maxStamina. NPCs pay
   * the same action costs players do (swings, dodges, skill actions) — an
   * NPC that runs dry pauses attacking until regen catches up.
   */
  maxStamina?: number;
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
  /** Sleep/tiredness value (0–100) above which seek-bed overrides the current job (T-039). */
  sleepEmergency?: number;
  /** Max ticks spent on a seek-food or seek-water job before giving up. */
  seekFoodTicks?: number;
  /** Max ticks spent on a seek-bed job before giving up (T-039). */
  seekBedTicks?: number;
  /** Ticks to run a flee job before reevaluating. */
  fleeTicks?: number;
  /** Ticks before reevaluating the current attack target. */
  attackTicks?: number;
  /** Hunger reduction when eating a food item. */
  foodHungerRestore?: number;
  /** Thirst reduction when drinking a water item. */
  waterThirstRestore?: number;
  /** Sleep restored per tick while resting at a bed (T-039). */
  bedSleepRestore?: number;
  /** Movement speed multiplier applied at spawn (default 1.0). */
  speedMultiplier?: number;
  /** Item type to equip as weapon at spawn (e.g. "wolf_bite"). Null/absent = unarmed. */
  weaponItemType?: string;
  /**
   * Trigger ids this archetype carries innately (T-259c) — the
   * `npc_template` TriggerSource reads them live via NpcTag.npcType.
   * Signature procs (a cornered wolf's frenzy) without any item. Each id
   * must resolve in `ContentService.triggers` (boot-cross-checked).
   */
  triggers?: string[];
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
   * Action slots this actor declares (T-226). Each slot holds ≤ 1
   * ActiveAction at a time; the ActionDispatcher rejects any action whose
   * `slot` isn't listed here. Grows as CSM layers migrate to the action
   * runtime — at T-226b only `["posture"]`. Inherited from parent prefab
   * via `extends` (replaced wholesale, not merged). Absent for non-actor
   * prefabs.
   */
  actorSlots?: string[];
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
   * Item effect payload (T-240) — what "using" this item does. A list of
   * `EffectSpec`s fanned through the shared action-effect registry by the
   * `use_item` action. Top-level, not a `components` entry: effects are
   * item data (like `stats`), not an ECS component installed on a world
   * entity, so the spawn walk never tries to resolve an `effects`
   * component. Stackable items carry their payload here; unique items
   * carry a per-instance `ItemEffects` component instead (procedural
   * generation writes it at spawn). Absent ⇒ the item is not usable.
   */
  effects?: EffectSpec[];
  /**
   * Trigger ids this item grants its holder while equipped (T-259):
   * the `equipment` TriggerSource walks worn prefabs' `triggers[]` live —
   * a vampiric weapon's on-hit drain, an armor's when-hit proc. Each id
   * must resolve in `ContentService.triggers` (boot-cross-checked). Like
   * `effects`, item data — not an ECS component.
   */
  triggers?: string[];
  /**
   * Open-set component dictionary. Each key is either a `ComponentDef.name`
   * registered in the tile-server component registry (written directly at
   * spawn) or a known compound-archetype key consumed by `spawnPrefab`'s
   * installer chain (`player`, `npc`, `resourceNode`, etc.). The loader
   * validates the shape of each entry against the matching component's
   * schema — unknown keys and schema violations both fail at content-load.
   */
  components: Record<string, unknown>;
  /**
   * Child prefabs spawned as scene-graph descendants of this entity (T-217).
   * Spawning this prefab spawns the root, then recursively spawns each child
   * and wires `world.setParent(child, root)`; each child's `local` transform
   * is its offset relative to the parent. Recurses arbitrarily deep — a
   * child may itself declare `children`. Absent = a flat single entity.
   * Loader rejects refs to unknown or abstract (`_`-prefixed) prefab ids.
   */
  children?: ChildPrefabRef[];
}

/**
 * A child entry in `Prefab.children` (T-217). `prefabId` must resolve to a
 * concrete (non-abstract) prefab. `local` is the child's transform relative
 * to the parent entity; omitted fields default to identity (0 / scale 1).
 * Structurally `Partial<Transform>` so the engine consumes it without a
 * dependency on this package.
 */
export interface ChildPrefabRef {
  prefabId: string;
  local?: { x?: number; y?: number; z?: number; scale?: number };
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
/**
 * A playable species' passive trait (T-084): a list of stat modifiers applied
 * to its members. `op` mirrors the Status/Modifier primitive's fold
 * (`(base + Σadd) × Πmul`); `stat` must be a stat the server queries through
 * `effective()` (currently `moveSpeed`, `armorReduction`) for the trait to bite.
 */
export interface SpeciesDef {
  modifiers: Array<{ stat: string; op: "add" | "mul"; value: number }>;
}

/**
 * A persistent injury's debuff (T-008): stat modifiers applied to an injured
 * actor through the Status/Modifier fold. Additive penalties scale with the
 * injury's `severity`. Same shape as SpeciesDef — both are named StatModifier
 * bundles keyed by id in game_config.
 */
export interface InjuryDef {
  modifiers: Array<{ stat: string; op: "add" | "mul"; value: number }>;
}

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
    /** Ticks an unconsumed counter window survives before clear_counter_ready expires it. */
    counterWindowTicks: number;
    /** A single hit dealing ≥ this much damage can roll an injury (T-008). */
    injuryThreshold: number;
    /** Probability (0..1) a qualifying hit actually inflicts an injury. */
    injuryChance: number;
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
  encumbrance: {
    maxCarryWeight: number;
    penaltyThresholdRatio: number;
    minSpeedMultiplier: number;
  };
  crouch: {
    speedMultiplier: number;
  };
  /** Stealth tuning (T-014+): how movement state maps to perceptibility. */
  stealth: {
    /** Multiplier applied to an actor's noise level while the Crouched tag is
     * set — crouch-moving is much quieter than walking the same speed. */
    crouchNoiseMultiplier: number;
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
    /** Global cooldown: ticks any active skill use locks out all slots. */
    globalCooldownTicks: number;
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
    /** Number of LoreLoadout skill slots (T-023, config-driven; codec is length-prefixed). Default 4. */
    skillSlots?: number;
    /** Skill ActionDef ids seeded into a fresh player's LoreLoadout slots
     * (T-260b); null = empty slot. Cross-checked against content.actions
     * at boot. */
    startingSkills?: (string | null)[];
    /** Species a fresh player spawns as until character creation picks one (T-084/T-071).
     * Must be a key of `species`. Defaults to "human". */
    species?: string;
  };
  /**
   * Playable species (T-084), keyed by id. Each contributes a small passive
   * trait as `StatModifier`s applied through the Status/Modifier `effective()`
   * query — so a species id on the server-only `Species` component composes
   * with equipment / encumbrance / buffs through one path.
   */
  species: Record<string, SpeciesDef>;
  /** Persistent injuries (T-008), keyed by id. A severe hit can roll one of
   * these onto the victim; its debuff applies via the `injury` ModifierSource
   * until treated (T-009). */
  injuries: Record<string, InjuryDef>;
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
    /** Upper clamp on a single RTT sample (ms) — the sample derives from a
     * client-supplied timestamp, so it is hostile input (T-253). */
    rttMaxMs: number;
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
    /** Default NPC stamina pool when the template doesn't override (T-255). */
    maxStamina: number;
    wanderRadius: number;
    wanderTicks: number;
    idleTicks: number;
    hungerEmergency: number;
    thirstEmergency: number;
    /** Sleep (tiredness) value at/above which an NPC drops everything to seek a bed (T-039). */
    sleepEmergency: number;
    seekFoodTicks: number;
    /** Ticks before a seek-bed plan expires and is rebuilt (T-039). */
    seekBedTicks: number;
    fleeTicks: number;
    attackTicks: number;
    foodHungerRestore: number;
    waterThirstRestore: number;
    /** Sleep restored per tick while resting at a bed (T-039). */
    bedSleepRestore: number;
    /** Distance² within which a bed counts as reached, so resting begins (T-039). */
    bedRangeSq: number;
    foodPickupRangeSq: number;
    arrivalThreshold: number;
    attackRangeSq: number;
    defaultAggroRangeSq: number;
    /** Half-angle (radians) of the forward cone in which an NPC detects threats
     * at full `aggroRangeSq` (T-016). Outside the cone, detection falls back to
     * the short rear range below — so flanking an unaware NPC is viable. */
    aggroConeHalfAngle: number;
    /** Rear/flank detection range as a fraction of `aggroRangeSq` (T-016).
     * A target outside the forward cone is only seen within this much shorter
     * radius. e.g. 0.08 → rear sight ≈ 28% of frontal range. */
    aggroRearRangeRatio: number;
    /** Hearing threshold (T-015): a target is heard when `noise × (1 − dist/range)`
     * meets this. Lower = sharper ears. e.g. 0.15 → a sprinter (noise 1) is heard
     * out to ~85% of range, a croucher (0.3) only when quite close. */
    aggroAuditoryThreshold: number;
    /** How much darkness shrinks an NPC's detection range (T-017). The effective
     * range factor is `1 − (1 − lightLevel) × this`, applied to both the aggro
     * and rear ranges. lightLevel 1 (full day) → no change; lightLevel 0 (pitch
     * dark) → range × (1 − this). e.g. 0.5 → an NPC in total darkness sees/feels
     * threats at half range. */
    nightDetectionRangeMultiplier: number;
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
    /** Chance (0..1) that an idle NPC drifts toward a nearby fellow instead of
     * wandering at random, so idle NPCs cluster and read as socialising (T-043). */
    socialIdleChance: number;
    /** Radius (world units) within which an idle NPC looks for a fellow to
     * gather near (T-043). Small — only close neighbours socialise. */
    socialScanRadius: number;
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

// =============================================================================
// POIs (T-206) — Points of Interest
//
// A POI is a self-contained interactive activity on a tile (bossfight, wave
// survival, puzzle, encounter, action prompt, exploration moment). Authored
// in isolation as one JSON file per POI; the Tier-6 generator weaves them
// into a dependency-DAG per tile, with the "questline" emerging from the
// graph topology. See packages/content/data/pois/SCHEMA.md for the full
// design rationale.
// =============================================================================

/** Closed set — adding a new POI type requires a runtime POI runner. */
export type PoiType =
  | "encounter"
  | "bossfight"
  | "wave"
  | "puzzle"
  | "action"
  | "exploration";

/**
 * Topology role each zone in the AnnotatedZoneGraph (T-208) carries.
 *
 * Two traversal classes (T-210):
 *
 *   PATH roles — the default-walkable corridor/chamber network.
 *     Players reach these through normal exploration.
 *
 *   WILDERNESS roles — elevated plateaus enclosed by paths. Players
 *     reach these only by ascending a stair (T-210), which is gated
 *     by a trinket from an upstream POI. Closed-pixel blobs.
 *     The dominant boundary kind drives the specific role:
 *       stone        → crag    (rocky outcrop)
 *       forest large → grove
 *       forest small → thicket
 *       grass large  → hollow  (grassy bowl)
 *       grass small  → outcrop
 *       water        → morass  (reserved for v2; water blobs are not
 *                                yet wilderness zones — bridge mechanic
 *                                doesn't exist)
 *
 * A POI's `fit.traversal` field declares which class it occupies.
 * Default = `"path"` for back-compat with the original 7 roles.
 */
export type ZoneRole =
  // path roles
  | "plaza"
  | "pocket"
  | "deadend"
  | "corridor"
  | "crossroads"
  | "lobby"
  | "arena"
  // wilderness roles
  | "crag"
  | "grove"
  | "thicket"
  | "hollow"
  | "outcrop"
  | "morass";

/** Where in the dependency DAG a POI may legally sit. */
export type PoiRole = "entry" | "midchain" | "terminal" | "optional";

// ---- activity (discriminated union on `type`) ----

export interface PoiActivityEncounter {
  spawnTable: string;
  /** World-units. Player entering this radius triggers the spawn. */
  spawnTriggerRadius: number;
  /** "all" = clear every spawned enemy; number = clear that many. */
  minClearKills: "all" | number;
  /** Ticks before respawn; null = persistent until tile lifecycle reset. */
  regenAfterTicks: number | null;
}

export interface PoiActivityBossfight {
  bossNpcId: string;
  arenaRules: {
    /** Collapse entry on engage so the boss can't be skipped past. */
    lockEntry: boolean;
    /** HP fractions at which phase transitions fire (e.g. [0.66, 0.33]). */
    phaseTriggers: number[];
    /** Optional spawn table for adds during the fight. */
    addsTable: string | null;
  };
}

export interface PoiActivityWaveEntry {
  spawn: string;
  count: number;
  /** Seconds after wave start; the first entry usually has interval 0. */
  interval: number;
}

export interface PoiActivityWave {
  waves: PoiActivityWaveEntry[];
  interWaveSeconds: number;
  /** Optional safe-zone radius in world-units; 0 = no safe zone. */
  playerSafeZoneRadius: number;
}

export interface PoiActivityPuzzle {
  puzzleId: string;
  params: Record<string, unknown>;
  failurePenalty: "reset" | "damage" | "none";
}

export interface PoiActivityAction {
  interactionPrefab: string;
  verb: string;
  /** If true the POI completes on first use and does not respawn. */
  consumable: boolean;
  preconditionTags: string[];
}

export interface PoiActivityExploration {
  triggerKind: "proximity" | "look-at" | "destroy-prop";
  triggerRadius: number;
  loreId: string;
}

/**
 * Untagged union of activity shapes. The discriminator is the sibling
 * `type` field on `PoiDef` itself (the JSON authoring shape doesn't repeat
 * the tag inside `activity`); `PoiDef` is therefore a discriminated union
 * on `type` that narrows `activity` accordingly.
 */
export type PoiActivity =
  | PoiActivityEncounter
  | PoiActivityBossfight
  | PoiActivityWave
  | PoiActivityPuzzle
  | PoiActivityAction
  | PoiActivityExploration;

// ---- fit (spatial constraints) ----

export interface PoiFit {
  preferredTopology: ZoneRole[];
  minArea: number;
  maxArea: number;
  enclosure?: { min?: number; max?: number };
  /**
   * If set, the chosen zone's kind histogram must include at least one of
   * these kind tags (e.g. "stone", "forest"). Empty intersection = reject.
   */
  requiredKind?: string[];
  /** If set, restrict matching to cells of these biomes. */
  requiredBiome?: string[];
  /**
   * Which zone-class this POI must occupy (T-210):
   *   "path"       — default-walkable corridor / chamber zones
   *   "wilderness" — elevated plateaus; require a stair-gated ascent
   *                  (the matcher materializes a Stair when wiring)
   *   "either"     — both legal
   *
   * Default `"path"` when absent. Wilderness POIs are typically destinations
   * (bossfights, hidden shrines, secret encounters) — the "what the
   * trinket unlocks", not the "where you find the trinket".
   */
  traversal?: "path" | "wilderness" | "either";
}

// ---- gate (discriminated union on `kind`) ----

export interface PoiGateOpen { kind: "open" }
export interface PoiGateItem {
  kind: "item";
  /**
   * Filled in by the Tier-6 generator at tile-bake time. Authored value
   * MUST be null — the POI definition does not bind to a specific
   * upstream trinket; the generator wires that based on flavorAccept.
   */
  trinketRef: null;
  /** Themes this gate accepts. Source POI must have at least one in common. */
  flavorAccept: string[];
}
export interface PoiGateMulti {
  kind: "multi";
  /** Number of distinct upstream trinkets required. Each must theme-match. */
  count: number;
  flavorAccept: string[];
}
export interface PoiGateChoice {
  kind: "choice";
  /** Number of upstream trinkets required (typically 1; any subset accepted). */
  count: number;
  flavorAccept: string[];
}
export type PoiGate = PoiGateOpen | PoiGateItem | PoiGateMulti | PoiGateChoice;

// ---- reward + trinket theming ----

export interface TrinketTheme {
  /** Theme nouns used for matching (e.g. "bone", "primal") + naming. */
  themes: string[];
  /** Adjectives for procedural display-name building. */
  flavorTags: string[];
  /** Material/colour hint for visual prefab generation. */
  visualHint?: string;
}

export interface PoiExtraDrop {
  kind: "lore" | "stack" | "unique";
  /** Lore fragment id, prefab id, etc. — meaning depends on `kind`. */
  id: string;
  /** For stack drops; ignored for lore/unique. */
  qty?: number;
  /** 0..1 drop probability. Default 1.0 if absent. */
  chance?: number;
}

export interface PoiReward {
  trinketTheme: TrinketTheme;
  extras: PoiExtraDrop[];
}

// ---- top-level (discriminated on `type`) ----

interface PoiBase {
  id: string;
  /** Schema version. v1 currently; reject unknown future versions at load. */
  schema: 1;
  displayName: string;

  fit: PoiFit;
  gate: PoiGate;
  reward: PoiReward;

  /** Loose tags for trinket-theme matching + macro-level quotas. */
  tags: string[];

  /** 1..5; informs DAG-layer placement (terminals are usually 4-5). */
  difficulty: number;
  /** Macro quota weight — how often this POI may appear world-wide. */
  quotaWeight: number;
  /**
   * Legal positions in the dependency DAG. `[]` disables the POI without
   * deleting its file. A typical POI lists 2-3 roles.
   */
  roles: PoiRole[];
  /**
   * Optional prefab spawned at the POI's host-region centroid at tile boot
   * (T-218). The prefab carries the `poiTrigger` component (its runtime
   * `poiInstanceId` / `poiDefId` are patched in post-spawn) and any
   * `children` props (altars, braziers, decals) that give the POI a
   * physical scene. Absent → the legacy bare trigger entity is created
   * instead. The loader rejects an unknown prefab id.
   */
  scenePrefabId?: string;
}

export type PoiDef =
  | (PoiBase & { type: "encounter";   activity: PoiActivityEncounter })
  | (PoiBase & { type: "bossfight";   activity: PoiActivityBossfight })
  | (PoiBase & { type: "wave";        activity: PoiActivityWave })
  | (PoiBase & { type: "puzzle";      activity: PoiActivityPuzzle })
  | (PoiBase & { type: "action";      activity: PoiActivityAction })
  | (PoiBase & { type: "exploration"; activity: PoiActivityExploration });
