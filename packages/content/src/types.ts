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

/**
 * Per-material RENDER look block (T-311 Phase 0a). The shape is FROZEN here in
 * one commit (VISUAL_DATAMODEL_PLAN.md invariant I2) so the visual axes that
 * extend it — texture / tint / relief / wetness / reflect / moss / glow — never
 * re-break the schema. Every field here now has a live client consumer
 * (textureStyle, tintJitter, relief, wetness, reflect, mossBlend); the shape
 * stays frozen (I2) so future visual axes extend it without another schema
 * break. Every field optional; absent = engine default (so adding the block
 * to a material is a pure file-drop, no code edit).
 */
export interface MaterialRenderDef {
  /** Surface-texture style id → client TextureStyle registry (grammar G4,
   *  Phase 0a). Absent = flat colour. */
  textureStyle?: string;
  /** Per-voxel colour mottle (G6, Phase 0a pt.2): brightness range + warm/cool
   *  tilt. Absent = engine-default jitter. */
  tintJitter?: { brightness: [number, number]; warmCool: number };
  /** Relief/displacement detail knobs (T-311 P4; additive, all optional).
   *  `warp` — the stacked-voxel amplitude for CLIFF stacks: stones jitter
   *  their exposed faces ±warp/2, warp their corners independently (own
   *  dispSeed) and oversize into known-solid, so cliffs read hand-stacked.
   *  `surfaceWarp` — the same per-voxel decorrelated warp on the walkable
   *  floor slabs: rough, clod-like ground.
   *  `disturbanceField` — THE per-cell disturbance axis (FieldExpr over the
   *  server render fields, boot-cross-checked): 1 = wild, 0 = civilized.
   *  It scales EVERY disturbance channel — surfaceWarp, the cliff-stack
   *  warp, and the per-voxel tint mottle — so worked/trodden cells read
   *  orderly (flat, uniform, crisp) and wilderness reads rough and mottled.
   *  Absent ⇒ constant full disturbance. */
  relief?: {
    resolution?: number;
    detail?: number;
    /** Per-corner displacement magnitude override, world units (T-311 P4,
     *  generalised T-326). THE one "how warped is this" amplitude knob every
     *  voxel-baked class reads through the shared `bakeVoxels`/`bakeSubModel`
     *  `mag` parameter — terrain (`renderer.ts`, replacing the shared
     *  TERRAIN_DISP_MAG default), scatter (`scatter_renderer.ts`), static
     *  props/built structures (`entity_mesh_registry.ts`→`buildSubModelGeo`),
     *  and characters/equipment/dynamic props (`entity_mesh.ts`) all resolve
     *  this SAME field for their material — one authoritative home, one
     *  application point, no second warp path. Materials sharing a
     *  cliff-edge corner with a DIFFERENT resolved dispMag will show a
     *  visible seam — the no-crack guarantee only holds within one
     *  material's own atoms, which always share the same resolved value.
     *  Absent ⇒ each call site's own engine default (terrain: the shared
     *  TERRAIN_DISP_MAG constant; every other class: bakeDisplacedVoxel's
     *  10%-of-voxel-size per-voxel default) — current behaviour for every
     *  material that hasn't authored one. */
    dispMag?: number;
    warp?: number;
    surfaceWarp?: number;
    disturbanceField?: import("./field_expr.ts").FieldExpr;
  };
  /** Wetness/gloss response, driven by SurfaceStateGrid (Phase 4). */
  wetness?: { gloss: number; darken: number; reflectGain: number };
  /** Reflection treatment, shared with water via the SurfaceTreatment registry
   *  (Phase 5). */
  reflect?: { strength: number; tint: number; blur: number; glint: number };
  /** Moss-creep blend, driven by the OvergrowthGrid (Phase 4): material to blend
   *  toward + per-orientation bias + crack-joint boost + tint shift. */
  mossBlend?: {
    material: string;
    floorBias: number;
    wallBias: number;
    jointBoost: number;
    tintShift: [number, number, number];
  };
  /** Emissive family for flame/rune tinting — 'warm' | 'corruption' | 'cold'
   *  (Phase 2). */
  glowFamily?: string;
}

/**
 * Material STATE-LADDER variant (T-311 Phase 2, grammar G3). One ordered ladder
 * models BOTH two-state (sacred↔corrupted) and N-state decay
 * (fresh→weathered→decayed) + settlement upgrade-stages. Selected by a
 * SERVER-authoritative index resolved by STABLE string `id`→index at boot (never
 * raw array position — invariant I3c). Resolved via `materialVariantIds()` (the
 * alphabetical stable-index table, same discipline `CliffGrid.profileId`
 * established, T-318/T-319); the atlas `fields` stage writes the resolved index
 * into `SurfaceStateGrid.variantIndex`.
 */
export interface MaterialVariant {
  id: string;
  colorOverride?: number;
  colorShift?: { h: number; s: number; l: number };
  emissiveCracks?: number;
  addsTags?: readonly string[];
}

/**
 * Generator-facing authoring hints (T-301, `DESIGN_LANGUAGE.md` §5) — an
 * additive, fully-optional block a ProcModel generator MAY read for a
 * material-appropriate default instead of a hardcoded literal. Absence is
 * valid; populated only on materials with an obvious value (existing content
 * is byte-unchanged unless a value is authored). Never required for a
 * material to be usable — this is a hint, not a schema the loader enforces
 * presence of.
 */
export interface MaterialGeneratorPreferences {
  /** Suggested per-cell/per-instance placement density [min,max] (0-1),
   *  DESIGN_LANGUAGE.md §4's semantic density bands per tag. */
  density_range?: [number, number];
  /** Suggested SHELL/SCATTER-FLECK thickness in world units (bark rind,
   *  armor plate, fur tuft length) — NOT a SOLID/LIMB bulk dimension. */
  thickness_range?: [number, number];
  /** Whether this material suits G3 MaterialStateLadder layering (blended/
   *  stacked as a SHELL over another material — moss over stone, rot over
   *  flesh) rather than only appearing as solid bulk. */
  layerable?: boolean;
  /** Suggested emissive intensity [0,1] for generator-driven glow accents
   *  (embers, runes, eyes) — a HINT for "if a generator adds a glowing
   *  accent voxel using this material, here's a reasonable value";
   *  independent of the material's own authored `emissive` field. */
  emission?: number;
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
  /** Render look block (T-311 Phase 0a; shape frozen per invariant I2). */
  render?: MaterialRenderDef;
  /** State-ladder variants (T-311 Phase 2, grammar G3) — selected by a
   *  server-authoritative index. Reserved; consumer lands in Phase 2. */
  variants?: readonly MaterialVariant[];
  /** Generator-facing authoring hints (T-301) — see `MaterialGeneratorPreferences`
   *  and `DESIGN_LANGUAGE.md` §5. Absent = no hint authored (generators fall
   *  back to their own defaults). */
  generatorPreferences?: MaterialGeneratorPreferences;
}

/**
 * Colour-grade definition (T-311 Phase 2, grammar G7 · AuthoredEnvParamSet). The
 * full set of EdgePass grade constants lifted VERBATIM out of the shader into
 * content (`data/grades/*.json`) — shader maths unchanged, only the source of the
 * numbers moves. The client selects a grade and lerps the EdgePass uniforms from
 * it; per-biome/phase selection by a networked context key lands later. Most
 * fields map 1:1 to a `u*` EdgePass uniform; six (T-315 D2) are consumed by other
 * render-pipeline owners instead — see each field's comment.
 */
export interface GradeDef {
  id: string;
  exposure: number;          // uExposure — pre-tonemap radiance lift
  saturation: number;        // uSaturation — post-tonemap chroma gain
  vignetteStart: number;     // uVignetteStart
  vignetteStrength: number;  // uVignetteStrength
  splitTone: number;         // uSplitTone — cool shadow ↔ warm light
  grimGain: [number, number, number];   // uGrimGain — highlight tint
  grimGamma: [number, number, number];  // uGrimGamma — midtone power
  grimLift: [number, number, number];   // uGrimLift — raised cool blacks
  grimDesat: number;         // uGrimDesat — warm pixels spared
  warmGain: number;          // uWarmGain — warm-pixel desat exemption
  grimCast: [number, number, number];   // uGrimCast — cool weathered cast
  grainStrength: number;     // uGrainStrength — film grain
  grainShadowFloor: number;  // uGrainShadowFloor
  /** BloomPass uThreshold — HDR bright-pass cutoff (NOT an EdgePass uniform). */
  bloomThreshold: number;
  /** BloomPass uKnee — bright-pass rolloff softness (NOT an EdgePass uniform). */
  bloomKnee: number;
  /** EdgePass uBloomStrength — glow amount composited back before tonemap. */
  bloomStrength: number;
  /** Renderer-side world-Y sample range below the player, recomputed into
   *  uHeightMin each frame (NOT a uniform itself — no direct `u*` counterpart). */
  heightShadeBelow: number;
  /** Renderer-side world-Y sample range above the player, recomputed into
   *  uHeightMax each frame (NOT a uniform itself — no direct `u*` counterpart). */
  heightShadeAbove: number;
  /** Scene-wide multiplier pushing a material's authored `emissive` (0-1) past
   *  1.0 into HDR/bloom range — a per-material build-time multiplier in
   *  voxel_material.ts (NOT an EdgePass uniform). */
  emissiveHdrScale: number;
}

/**
 * Atmosphere definition (T-311 Phase 5a, grammar G7). Selected by
 * `WorldClock.biomeTag` (the tile's single closed biome-tag, resolved through
 * ContentService with a `default.json` fallback — the tile-wide render-context
 * selector this phase introduces). Deliberately does NOT re-carry day/night
 * sky/fog/sun/ambient colour ramps — those already live on `Palette.phases`,
 * keyed by the same four phase names `sunArc`'s dawn/noon/dusk boundaries
 * match (0.25/0.5/0.75); AtmosphereDef owns only the axes palette.phases
 * doesn't: the sun's geometric path, ground mist, and god-rays.
 */
export interface AtmosphereDef {
  id: string;
  /** Sun path — altitude/azimuth as a function of time-of-day (sun_arc.ts). */
  sunArc: {
    dawnAzimuthDeg: number;
    duskAzimuthDeg: number;
    maxAltitudeDeg: number;
    nightDepthDeg: number;
  };
  /** Ground-hugging mist band (GroundMistLayer, an EdgePass composite term —
   *  not a separate render pass). Height band is world-Y, relative to sea
   *  level (not player-relative — a fog-of-war-style world reconstruction). */
  mist: {
    heightMin: number;
    heightMax: number;
    /** Density multiplier per named day phase (same 4 names as Palette.phases;
     *  falls back to 0 for an unlisted phase — mist is opt-in per phase). */
    densityByPhase: Record<string, number>;
    /** sRGB hex mist tint. */
    color: string;
  };
  /**
   * God-ray (light-shaft) params for the existing screen-space radial-scatter
   * pass (god_ray_pass.ts) — NOT a shadow-map volumetric march. v1 is
   * deliberately NEAR-FIELD ONLY: the march samples the half-res bloom
   * bright-target within a fixed UV radius, which in practice stays inside
   * the sun shadow camera's ±60u frustum at the current camera framing —
   * widening/cascading the frustum for a true long-range shaft is explicitly
   * out of scope this phase (VISUAL_DATAMODEL_PLAN.md Phase 5 caveat).
   */
  godRay: {
    /** Per-step contribution (GodRayPass uWeight). */
    intensity: number;
    /** How far toward the sun UV the march reaches (GodRayPass uDensity).
     *  Near-field-only ceiling: keep this small enough that SAMPLES=24 steps
     *  never reach past the shadow frustum's on-screen projection at the
     *  default camera framing (empirically ~0.85 today; do not widen without
     *  re-verifying against the frustum via testplay). */
    nearFieldRange: number;
    /** Per-step brightness falloff (GodRayPass uDecay). */
    decay: number;
    /** Composite strength added into the HDR scene (EdgePass uGodRayStrength). */
    strength: number;
    /** sRGB hex shaft tint (EdgePass uGodRayColor). */
    color: string;
  };
}

/**
 * Water style definition (T-311 Phase 5b, grammar G7 water axis). Selected
 * per-tile via the SAME `WorldClock.biomeTag` render-context key P5a's
 * AtmosphereDef uses, same boot cross-check pattern, same `"default"`
 * fallback. Freezes today's water_renderer.ts shader constants verbatim as
 * the default style's JSON values (zero look-change) — a biome-specific
 * style can diverge later since these are self-contained hex colours, not a
 * palette-token indirection (palette tokens are a separate single-source-of-
 * truth axis; a WaterStyleDef needs to be complete on its own).
 *
 * `waves` mirrors the FRAG shader's `h`/`dhdx`/`dhdz` computation 1:1 — three
 * additive sine terms, each `amplitude * sin(freqX*x + freqZ*z + speed*t)`
 * (a term with `freqX=0` or `freqZ=0` is effectively single-axis; the third
 * "cross" term today has both non-zero). `normalScale` is the dhdx/dhdz ->
 * surface-normal perturbation strength; `lumDivisor` remaps the raw height
 * field into the shallow<->deep mix (`clamp(0.5 + 0.5*(h/lumDivisor), 0, 1)`).
 */
export interface WaterStyleDef {
  id: string;
  /** Base shallow/deep tint (sRGB hex) — the water_renderer FRAG's uShallow/uDeep. */
  shallowColor: string;
  deepColor: string;
  /** Base alpha before the fresnel-rim boost (uOpacity). */
  opacity: number;
  waves: {
    amplitude: [number, number, number];
    frequencyX: [number, number, number];
    frequencyZ: [number, number, number];
    /** Signed — a negative speed runs the term's phase backward. */
    speed: [number, number, number];
    normalScale: number;
    lumDivisor: number;
  };
  /** Fresnel rim: exponent + how much it lightens toward shallow + how much
   *  it boosts alpha at grazing angles. */
  fresnel: {
    exponent: number;
    tintStrength: number;
    opacityBoost: number;
  };
  /** Blinn specular sun-glint exponent + colour gain. */
  specular: {
    exponent: number;
    gain: [number, number, number];
  };
}

/**
 * Light definition (T-311 Phase 2). "A light" is content: a warm/corruption/cold
 * family, a base colour + radius + intensity, whether it is eligible to cast a
 * real PointLight (`castsPool` — vs glowing through its emissive flame voxels
 * only), and an optional `flickerCurveId` into the client flicker registry.
 * Referenced by an entity's `lightDefId` (placed-emitter prefabs / Illuminator);
 * the server resolves the numbers into the networked LightEmitter, the client
 * derives the presentation-only fields (flicker/family/castsPool) from this def.
 */
export interface LightDef {
  id: string;
  /** Grouping / future selection key. Informational this phase (no consumer yet). */
  family: "warm" | "corruption" | "cold";
  baseColor: number;   // 0xRRGGBB
  radius: number;      // world units
  intensity: number;
  /** Eligible for a real THREE.PointLight via the client LightBudget; false =
   *  emissive-flame glow only (always-on, free). */
  castsPool: boolean;
  /** → client flicker registry; absent = 'steady'. */
  flickerCurveId?: string;
}

/**
 * Cliff profile (T-311 Phase 6). Resolved by the atlas `cliffStage` for stone
 * wilderness-perimeter cells (`CliffGrid.profileId`, a stable alphabetical
 * id→index — see `bootstrap_codec.ts`'s cliffProfiles encode order) and
 * dispatched client-side through the `cliffVoxeliser` registry keyed by this
 * `id`. `erosionStates` replaces the retired client-side CLIFF_MIN/STONE_H/
 * STACK_MAX/EXPOSE_MIN constants — the same numbers, now per-profile content
 * instead of one hardcoded stacking heuristic. `tierCount` is the course
 * count for the per-cell vertical stack (v1 terracing is vertical coursing,
 * NOT a horizontal multi-ring staircase — see T-318); `jitterAmp` feeds the
 * stack's warp (`render.relief.warp`'s per-profile analogue) and
 * `edgeChinkiness` the sub-lip corner-displacement extra.
 */
export interface CliffProfileDef {
  id: string;
  wallKind: "stone";
  erosionStates: {
    crisp: CliffErosionState;
    weathered: CliffErosionState;
    broken: CliffErosionState;
  };
}

export interface CliffErosionState {
  /** Course count for the per-cell vertical stack (was STACK_MAX's Math.round(depth/STONE_H)). */
  tierCount: number;
  /** Exposed-face + course-seam jitter amplitude (was the terrain-voxeliser's warp input). */
  jitterAmp: number;
  /** Sub-lip stone corner-displacement extra, scaled by jitterAmp (was CHINK_DISP_SCALE's fixed constant). */
  edgeChinkiness: number;
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
  /**
   * T-302 — names the `ProcModelDef` (client procmodel registry) whose
   * `class: "character"` generator produces this model's body, marking it
   * `generated: true` rather than authored. Boot-cross-checked (loader.ts)
   * against `store.procModels` membership; the client's
   * `crossCheckDesignLanguage` additionally verifies the referenced
   * ProcModelDef is `class: "character"` and its `params.skeletonId` matches
   * this model's own `skeletonId` (both sides must agree on which skeleton
   * they're describing). Absent ⇒ the model's body comes from the skeleton's
   * `bodyRecipe` directly (unchanged, e.g. every existing `biped_skeletal`
   * humanoid) or from authored sub-object voxels — this field only marks
   * "this specific model's body is generator-sourced, not authored."
   */
  procModelId?: string;
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
  /** Content LightDef id (T-311 P2) — drives the client presentation (flicker
   *  curve / family / castsPool) of the equipped light. */
  lightDefId?: string;
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
  /**
   * T-306 — names a `ProcModelDef` (generator: "blade_grammar") whose blade
   * is THIS weapon's own geometry rather than an authored `model_sword_*`.
   * Boot-cross-checked (loader.ts) against `store.procModels` membership,
   * same discipline as `ModelDefinition.procModelId` (T-302). When present:
   *   - the client bakes the weapon's held-model voxels from
   *     `bladeGrammarAtoms(seed, procModel.params, resolveMaterial)` instead
   *     of the prefab's static `ModelDefinition.nodes` (entity_mesh_registry.ts
   *     syncHandSlot).
   *   - the server's `weapon_trace` resolver overrides the equipped weapon
   *     action's `swingPath.length`/`radius` with
   *     `deriveBladeGeometry(seed, procModel.params)` before sweeping the
   *     hit capsule — same seed, same pure function, so the visible blade
   *     and the hitbox can never diverge (the T-186 hitbox-parity class of
   *     bug this ticket explicitly guards against).
   * `seed` in both cases is `hash32(weaponEntityId)` — the SAME derivation
   * `installVisualShell` uses for every other entity's ModelRef.seed,
   * computed independently client/server from the already-networked
   * EquipmentSlot.entityId (zero wire cost — no new field). Absent → this
   * weapon's blade geometry is whatever its WeaponActionDef's authored
   * `swingPath`/`blade` already provides (no regression for authored
   * weapons like `iron_sword`).
   */
  bladeGrammar?: string;
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
   *   "single" — LMB places one voxel at the cursor cell (stacking on the
   *              column top). Default.
   *   "line"   — LMB sets an anchor, then commits a Bresenham line of voxels
   *              from the anchor to the cursor cell (spacing-controlled). RMB
   *              clears the anchor, ESC exits build mode.
   *
   * The server doesn't read this field — placement is one Place command per
   * cell either way. The client renders ghost previews + the brush from it.
   */
  tool?: "single" | "line";
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
export interface IlluminatorData { radius: number; color: number; intensity: number; lightDefId: string; }
export interface ArmorData {
  reduction: number;
  staminaPenalty: number;
  /**
   * T-306 — names a `ProcModelDef` (generator: "armor_grammar") whose SHELL
   * plates are THIS armor piece's geometry, merged per-bone into the wearer's
   * baked mesh (entity_mesh_registry.ts syncArmorSlot → armorGrammarByBone,
   * the same per-bone THREE.Group mechanism humanoid_grammar bodies ride).
   * Boot-cross-checked against `store.procModels` membership. Purely visual
   * (armorReduction is a scalar, not geometry) — no server consumer. Seed is
   * `hash32(armorItemEntityId)` so each NPC's plate is seed-unique. Absent →
   * the piece renders its authored `modelId` model (unchanged path).
   */
  armorGrammar?: string;
  /**
   * T-223 — bones this piece's `armorGrammar` should fan out onto when the
   * client can't derive a single attach bone from the scene graph (legs/feet:
   * T-220 excludes them from `EQUIP_SLOT_PRIMARY_BONE` because a scene-graph
   * `Parent` edge is 1:1 and those slots cover multiple bones, e.g. both
   * upper legs). A shared `armorGrammar` procModel may author plates for MORE
   * bones than any one piece should render (e.g. `plate_armor_iron` covers
   * torso_upper/head/upper_leg_l/upper_leg_r for three different items) — this
   * is the per-item subset, content data rather than a client code table.
   * Boot-cross-checked: required whenever `equippable.slots` includes `legs`
   * or `feet`; only meaningful alongside `armorGrammar`. Ignored for
   * single-bone slots (head/chest/back/weapon/offHand), which resolve their
   * one bone straight from the graph.
   */
  coversBones?: string[];
}
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
 * One keyframe of an authored swing arc, in **actor-local** space:
 *   fwd   = the direction the character faces
 *   right = to the character's right
 *   up    = world up (height above the feet origin)
 *
 * `hilt` is where the grip (and so the weapon arm's wrist) sits; `blade` is the
 * direction the blade points (need not be unit — it is normalised on use). The
 * tip is always `hilt + normalize(blade) * SwingPathDef.length`, so a whole
 * swing is described by where the hand is and which way the blade points over
 * normalised swing time.
 */
export interface SwingKeyframe {
  /** Normalised swing time. 0 = first windup tick, 1 = last winddown tick. Ascending. */
  t: number;
  /** Grip position, actor-local fwd/right/up, world units. */
  hilt: { fwd: number; right: number; up: number };
  /** Blade pointing direction, actor-local fwd/right/up (normalised on use). */
  blade: { fwd: number; right: number; up: number };
}

/**
 * An **authored** swing — the hilt-centric primitive that replaces a borrowed
 * full-body clip with a designed blade motion. Hit detection (server), the
 * weapon-arm IK (client), and the trail all read this one path, so the blade
 * you see is exactly the blade that hits.
 *
 * When a WeaponActionDef carries a `swingPath`, it is the source of truth for
 * the swing and the `clipId`/`blade` clip-sampling fallback is unused.
 */
export interface SwingPathDef {
  /** Blade length, world units. Tip = hilt + normalize(blade) * length. */
  length: number;
  /** Swept-capsule radius, world units. */
  radius: number;
  /** Keyframes over normalised swing time, t ascending in [0,1]. */
  keyframes: SwingKeyframe[];
  /**
   * Which hands grip the weapon and where — lets ONE authored arc serve a 1H
   * sword (right hand only, left free) or a 2H weapon (both hands on the same
   * haft). Absent ⇒ the default 1H grip (right hand on the hilt, driving the
   * blade; the off hand counter-poses). The same IK primitive aims every
   * gripping arm; only each hand's target differs.
   */
  grips?: GripDef[];
}

/** One hand's grip on the weapon during a swing (see SwingPathDef.grips). */
export interface GripDef {
  /** Hand bone that grips (e.g. "hand_r" / "hand_l"). Its arm chain is the
   *  bone's parent (lower arm) + grandparent (upper arm). */
  bone: string;
  /** Signed offset along the blade axis, in blade-LENGTH units, from the hilt.
   *  0 = on the hilt; negative = toward the pommel (where a 2H off hand grips).
   *  target = hilt + normalize(bladeDir) * (along * length). */
  along: number;
  /** This hand rolls its wrist so the blade points along the authored
   *  direction. At most one grip per swing should set it. Default false. */
  drivesBlade?: boolean;
  /** Elbow pole hint, actor-local {fwd,right,up}. Defaults per side. */
  poleHint?: { fwd: number; right: number; up: number };
}

/**
 * One sample of a gait direction's foot-trajectory (T-308) — a single foot's
 * target OFFSET from its own rest position, actor-local {fwd,right,up}
 * (same convention as SwingKeyframe), at a normalised point in that foot's
 * OWN full stride cycle. `phase` ascends 0→1; phase 0 and phase 1 should
 * describe the same pose so the track loops cleanly. The other foot samples
 * the same track at `phase + 0.5` (contralateral gait) — no separate
 * per-foot authoring needed.
 */
export interface GaitKeyframe {
  /** Normalised position in this foot's stride cycle. 0 = contact. Ascending. */
  phase: number;
  fwd: number;
  right: number;
  up: number;
}

/**
 * Procedural walk-cycle catalogue (T-308) — Overgrowth-style: a SMALL set of
 * authored key poses (contact / low-pass / push-off, ~3-4 keyframes),
 * interpolated, rather than a baked clip. `forward` is the single
 * authoritative track; `backward` and `strafe` are DERIVED from it by
 * default (mirror the fore/aft sweep for backward; swap fore/aft onto the
 * lateral axis for a rightward strafe, sign-flipped for leftward) — the same
 * "author one source, derive the rest" doctrine `deriveTip()` uses for
 * blade tips. A gait may override either with an explicit authored track.
 *
 * The gait's phase is driven by GROUND DISTANCE TRAVELLED, not time:
 * `phase = (distanceTravelled / strideLength) % 1`. This is what keeps foot
 * speed matched to ground speed at any movement speed — see
 * `applyGaitPose()` in swing_pose.ts.
 */
export interface GaitDef {
  id: string;
  /** World units of ground travel per full 2-step cycle (phase 0..1). */
  strideLength: number;
  /** Foot bones to place. Default ["foot_l","foot_r"]. */
  feetBones?: [string, string];
  /** Knee pole hint, actor-local {fwd,right,up}. */
  kneePole?: { fwd: number; right: number; up: number };
  /** One foot's forward-walk trajectory over its own phase 0..1. */
  forward: GaitKeyframe[];
  /** Overrides the derived backward track (see class doc). */
  backward?: GaitKeyframe[];
  /** Overrides the derived rightward-strafe track (see class doc). */
  strafe?: GaitKeyframe[];
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
   * Blade geometry in hand-bone-local solver space. The clip-sampling
   * fallback for melee actions without an authored `swingPath`: hit
   * detection transforms these endpoints by the holding hand's world matrix
   * each active tick. Absent for ranged.
   */
  blade?: WeaponBladeDef;
  /**
   * Authored swing arc (hilt-centric). When present this is the source of
   * truth for both the hit sweep and the weapon-arm pose, and the
   * `clipId`/`blade` clip-sampling above is unused. This is how a swing is
   * meant to be authored — a clean designed arc, not a borrowed full-body clip.
   */
  swingPath?: SwingPathDef;
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
   * Commitment (T-295): once started, the action cannot be player-cancelled —
   * its `cancel` matrix is honored ONLY during the micro-cancel grace (the
   * first windup tick, ~50ms, so a pure mis-press can still abort). After that,
   * only a reaction interrupt (stagger/hit/death via `interruptPriority`) can
   * displace it. Default false = the cancel matrix applies as written.
   */
  committed?: boolean;
  /**
   * Hitstop (T-296): ticks to freeze attacker + target movement on a landed
   * `weapon_trace` hit — a brief, readable "thump" on contact. 0/absent =
   * no freeze (default). Consumed by `WeaponTraceResolver` (writes the
   * freeze window into its resolver-local scratch, no new component) and
   * `PhysicsSystem` (holds position/velocity for any entity in that set).
   */
  hitStopTicks?: number;
  /**
   * Telegraph lead clip (T-297): an optional tell played for `ticks` at the
   * START of the action's first phase (windup), before crossfading to that
   * phase's normal `animation` clip. Client-only projection — the server
   * sends no extra field; the client derives the lead purely from the
   * already-networked `ActiveActions.phase` + `ticksInPhase` plus this
   * content id. `ticks` must be < the first phase's own `ticks` so there is
   * room left for the real windup motion after the tell.
   */
  preWindup?: { clipId: string; ticks: number };
  /**
   * Gates evaluated at initiation. The action starts only if every gate
   * passes (plus resource `costs` are affordable). Closed-vocabulary typed
   * predicates — see `ActionGate`. (T-226)
   */
  preconditions?: ActionGate[];
  /**
   * Hold-to-aim pairing (T-337): names the action id `PrimaryIntentResolver`
   * requests when the triggering input (ACTION_USE_SKILL) drops while this
   * action's CURRENT phase is perpetual (`ticks: -1`). Only meaningful on a
   * `kind: "ambient"` def that reaches a perpetual phase — the dispatcher's
   * existing "hold" idiom (see `block`) — since `ticks: -1` is otherwise
   * illegal (`validateActionDef` requires `kind === "ambient"` for it).
   * Absent → releasing just lets intent re-resolve normally (nothing special
   * happens on release; this is what every non-hold action does today).
   *
   * The windup phase(s) leading up to the perpetual phase are ordinary
   * finite phases — "the action winds up and HOLDS at full charge" is one
   * ActionDef with a finite phase followed by a `ticks: -1` phase, not two
   * actions. Releasing during the finite windup is NOT gated by this field —
   * it's an ordinary cancel-into (`cancel.<phase>.into`), same as any
   * mid-swing interrupt.
   */
  releaseActionId?: string;
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

// ---- puzzles (T-212 v2) ----

/**
 * A puzzle TEMPLATE — the shared mechanics of one puzzle `kind`
 * (`data/puzzles/{id}.json`). A `puzzle` POI's `activity.puzzleId`
 * references one of these; per-instance tuning (lever count, hints) lives
 * on the POI's own `activity.params`, not here — the template names the
 * MECHANISM (dispatched through `puzzle_kinds/mod.ts`'s registry), the POI
 * instance supplies the PARAMS, same split `ActionDef`/per-use params use.
 */
export interface PuzzleDef {
  id: string;
  /** Registry key dispatched in `poi/puzzle_kinds/mod.ts`. v1 ships exactly
   * one: "lever_sequence". */
  kind: string;
}

// ---- procedural models (T-285) ----

/**
 * A recipe for a *family* of procedural voxel models (the fifth content-driven
 * primitive — the visual one). The `generator` id dispatches to a registered
 * client generator (`packages/client/src/render/procmodel/`); `params` is that
 * generator's closed, opaque parameter object (the loader never inspects it —
 * the generator interprets its own shape and resolves any material names).
 * Consumed only by the client (visual-only); the server ships it in the
 * bootstrap blob and otherwise ignores it. See PROCMODEL_PRIMITIVE_PLAN.md.
 */
export interface ProcModelDef {
  id: string;
  /** Generator id → client generator registry; boot-cross-checked (client). */
  generator: string;
  /** Generator-specific parameter object — opaque to the loader. */
  // deno-lint-ignore no-explicit-any
  params: any;
  /**
   * Corruption-morph tiers (T-311 P4): up to THREE param-override objects,
   * deep-merged over `params` (tier 0 = base `params`, tier i = merge of
   * `morphTiers[i-1]`) — so a fern's corrupted form is DATA (darker material,
   * fewer blades, more droop), not generator code. A ScatterDef's `morphField`
   * buckets the server field into `1 + morphTiers.length` tiers (≤ 4).
   */
  // deno-lint-ignore no-explicit-any
  morphTiers?: ReadonlyArray<Record<string, any>>;
  /**
   * Design-language class marker (T-301, DESIGN_LANGUAGE.md §6 item 4).
   * `"character"` opts this generator into the boot coherence check's
   * ground-plane invariant: its emitted atoms must root at model-space
   * `z ≈ 0` (ADR: a generated body always anchors at its placement point).
   * Absent = an environment-scale generator (tree/boulder/foliage today),
   * not checked against the ground-plane invariant. First real consumer is
   * T-302's `humanoid_grammar`.
   */
  class?: "character";
}

/**
 * Where a `ProcModelDef` scatters per tile and how big its variant pool is.
 * This is the file that replaces every `FOREST_*` hardcode (model id / stride /
 * scale / the forest boundary-kind literal). A per-tile VariantPool rolls
 * `pool` deterministic sub-seeds → runs the generator that many times → bakes K
 * geometries; each cell picks `variantIndex = hash(worldPos) % pool`, and the
 * subtle per-instance scale/rotation jitter rides the instance matrix (so scale
 * stays out of the archetype key — the resolution of the T-281 explosion).
 */
export interface ScatterDef {
  id: string;
  /** KindGrid boundary kind that drives the cell walk (e.g. forest = 2).
   *  Required when `material` is absent; ignored (may be omitted) when
   *  `material` is present — the two are mutually exclusive dispatch keys,
   *  never both consumed. */
  kind?: number;
  /** Optional: match the per-cell GROUND material NAME(s) instead of the KindGrid
   *  kind, so plants/rocks scatter on the walkable floor (dirt forest-floor, grass,
   *  moss, …) which is KindGrid=OPEN(0). A list matches any of the named materials.
   *  Resolved to material ids at decoration time. */
  material?: string | string[];
  /** Optional placement probability [0,1] per candidate cell (default 1). A
   *  per-cell hash gate so floor scatter reads natural/sparse, not lock-step.
   *  Superseded by `densityField` when present. */
  density?: number;
  /** Per-cell DENSITY as a FieldExpr over the VegFieldGrid/SurfaceStateGrid planes
   *  (T-311 P4). When present it REPLACES `density` — placement keep-probability
   *  VARIES per cell (dense in fertile/shade, sparse on dry rock / worn paths),
   *  the organic-vs-uniform-carpet lever. Boot-cross-checked against FIELD_NAMES.
   *  A hash still only decorrelates the keep ROLL, never decides density. */
  densityField?: import("./field_expr.ts").FieldExpr;
  /** ProcModelDef id → boot-cross-checked. */
  procModel: string;
  /** Variant pool size K — the tile-declared "I need K variants". */
  pool: number;
  /** One prop per stride×stride cell block. */
  stride: number;
  /** Base uniform scale applied to every instance. */
  baseScale: number;
  /** [min,max] per-instance scale jitter, multiplied onto baseScale. */
  scaleJitter: [number, number];
  /** Whether each instance gets a random Y rotation. */
  rotate: boolean;
  /** Optional CLUMP behaviour (T-311 P4 — the density lever). When present, a
   *  matching cell seeds a clump of instances scattered in a disk of `radius`
   *  (world units) rather than a single prop; the count LERPS `count[0]→count[1]`
   *  by the cell's field density (so fertile/shaded cells read DENSE and dry rock
   *  thins to nothing — "combine primitives into a dense scene"). Absent = the
   *  classic single-per-cell keep-probability placement. */
  cluster?: { count: [number, number]; radius: number };
  /** Corruption-morph selector (T-311 P4): a FieldExpr over the render fields
   *  whose value buckets the cell into one of the procModel's morph tiers
   *  (`1 + morphTiers.length`, ≤ 4) — corrupted ground grows the corrupted
   *  form. The SERVER field decides the tier, never a hash (the doctrine's
   *  hash-only-dithers rule). Requires the procModel to author `morphTiers`. */
  morphField?: import("./field_expr.ts").FieldExpr;
}

// ---- decals ----

/**
 * An EPHEMERAL combat decal (T-311 P4 — designer decision: in-memory + decay,
 * never saved, no wire component). The client's decal-source registry maps a
 * wire GameEvent (closed catalog: "damage" | "death") to a spawn point +
 * intensity; the DecalDef says what grows there: a splat of thin voxel slabs
 * in the splat material, scattered in a disk, decaying slab-by-slab after
 * `ttlSeconds`. The WHERE/WHAT traces to the server event + this content —
 * only the sub-splat scatter is random (transient presentation).
 */
export interface DecalDef {
  id: string;
  /** Decal-source id → client decal-source registry (closed event catalog);
   *  boot-cross-checked. */
  source: string;
  /** Splat material NAME (palette colour + render look via buildVoxelMaterial). */
  material: string;
  /** Slab count [min,max] — lerped by the source's intensity. */
  count: [number, number];
  /** Scatter disk radius (world units). */
  radius: number;
  /** Slab edge length [min,max] (world units). */
  sizeRange: [number, number];
  /** Full-strength lifetime; after this the splat decays slab-by-slab. */
  ttlSeconds: number;
  /** Decay window — slabs vanish one by one across this span. */
  fadeSeconds: number;
  /** damage source only: a hit at/above this amount → intensity 1 (splat
   *  count maxes out). Absent → the damageSource default (30). Ignored by
   *  every other source (e.g. death). */
  fullIntensityAt?: number;
}

/**
 * DissolveProfileDef (T-311 P5c, grammar G6 + I3b) — how a corrupted
 * creature frays and sheds voxels as it dissolves on death. Referenced by
 * `NpcTemplate.dissolveProfileId`, boot-cross-checked.
 *
 * Rendering is fully in-shader: static per-voxel attributes (which voxels
 * are "loose", their drift seed) are baked once at model build from each
 * voxel's bone-relative extremity distance, gated by `frayBandWidth`; the
 * ONE networked scalar (`AnimationStateData.dissolutionPhase`) plus these
 * uniforms drive a per-vertex position offset in the vertex shader. NO
 * per-frame geometry rewrite, NO CPU re-bake.
 *
 * `maxSeparatedVoxels` / `maxSeparationDistance` are the I3b hard caps —
 * content fields (not client constants) so the Studio devtool can display
 * them and an author can tune per-archetype without a code change. Drifting
 * voxels are individually outlined by the Sobel/SSAO EdgePass, so these caps
 * are the whole cost-control story; see VISUAL_DATAMODEL_PLAN.md §I3b.
 */
export interface DissolveProfileDef {
  id: string;
  /** Fraction (0..1) of the model's extent, measured from each voxel's bone
   *  outward to the skeleton's root, counted as "loose" (frayed). 0 = only
   *  the very extremities (fingertips/toes) fray; 1 = the whole body. */
  frayBandWidth: number;
  /** Drift speed in world units/second at dissolutionPhase=1 (scales
   *  linearly with phase below that). */
  driftSpeed: number;
  /** I3b hard cap: at most this many voxels (by loose01 descending) ever
   *  get a nonzero drift offset, regardless of model voxel count. */
  maxSeparatedVoxels: number;
  /** I3b hard cap: no drifting voxel may translate further than this many
   *  world units from its rest position. */
  maxSeparationDistance: number;
  /** Ticks the death-dissolve takes end to end — seeds the `dissolve_timer`
   *  Resource's max (and starting value) on the shed_dissolve DeathHook. */
  durationTicks: number;
  /** Easing applied to the raw linear timer fraction before it becomes
   *  dissolutionPhase. Default "linear" when absent. */
  phaseCurve?: "linear" | "smoothstep";
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
   * Armor item prefabs to equip at spawn, keyed by EquipmentData slot name
   * (T-306; mirrors the player's `startingEquipment`, which is per-instance
   * data on PrefabPlayerData — NPCs have no per-spawn override for this, so
   * it lives on the archetype template instead). Each entry spawns its own
   * item entity (spawnEquipEntity) with its own EntityId, so an armor piece
   * naming a `generatorPreferences`/`armor_grammar`-backed model renders a
   * seed-unique plate per NPC instance even when many NPCs share one
   * NpcTemplate. Absent/omitted slots stay unequipped.
   */
  armorItemTypes?: Partial<Record<"head" | "chest" | "legs" | "feet" | "back", string>>;
  /**
   * Trigger ids this archetype carries innately (T-259c) — the
   * `npc_template` TriggerSource reads them live via NpcTag.npcType.
   * Signature procs (a cornered wolf's frenzy) without any item. Each id
   * must resolve in `ContentService.triggers` (boot-cross-checked).
   */
  triggers?: string[];
  /**
   * Corrupted-creature dissolve/fray profile (T-311 P5c, grammar G6) —
   * `data/dissolve_profiles/{id}.json`. Absent = this archetype never frays
   * or dissolves on death (a corpse just vanishes, the pre-existing
   * behaviour). Must resolve in `ContentService.dissolveProfiles`
   * (boot-cross-checked). Read by the `shed_dissolve` DeathHook to seed the
   * `dissolve_timer` Resource, and by the client bake path to derive
   * fray/coreness per voxel.
   */
  dissolveProfileId?: string;
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
   * T-302 — documents that `modelId` names a model whose body is procedurally
   * GENERATED (`ModelDefinition.procModelId` names a `class: "character"`
   * ProcModel generator) rather than authored. Purely declarative — spawning
   * and rendering read `modelId` exactly as before; this field exists so a
   * prefab's own JSON is self-describing (and greppable) about which path
   * its body takes, without needing to cross-reference the model file. Not
   * boot-cross-checked against the model's actual `procModelId` (the model
   * file is the single source of truth for the wiring; this is prefab-level
   * documentation of intent, same spirit as a `_comment` field but typed).
   */
  generated?: boolean;
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
   * Child prefabs spawned as scene-graph descendants of this entity (T-217;
   * seeded pool/probability selection T-334). Spawning this prefab spawns
   * the root, then recursively spawns each RESOLVED child (see
   * `ChildPrefabRef`) and wires `world.setParent(child, root)`; each child's
   * `local` transform is its offset relative to the parent. Recurses
   * arbitrarily deep — a child may itself declare `children`. Absent = a
   * flat single entity. Loader rejects refs to unknown or abstract
   * (`_`-prefixed) prefab ids — both the fixed `prefabId` form and every
   * `pool` entry.
   */
  children?: ChildPrefabRef[];
}

/**
 * A child entry in `Prefab.children` (T-217; seeded pool/probability
 * T-334). `local` is the child's transform relative to the parent entity;
 * omitted fields default to identity (0 / scale 1). Structurally
 * `Partial<Transform>` plus the engine's `SeededPoolEntry` so the engine
 * consumes it without a dependency on this package.
 *
 * `prefabId` and `pool`/`probability` mirror `SubObjectRef.modelId`/`.pool`/
 * `.probability` exactly — the same seeded-random vocabulary that already
 * resolves a model's sub-objects (`resolveSubObjects`) now resolves which
 * child prefabs get spawned:
 *   - `prefabId` — fixed single prefab, always spawned (unless `probability`
 *     excludes it). Mutually exclusive with `pool`; `pool` wins if both are set.
 *   - `pool` — variant pool; one entry is drawn at spawn time.
 *   - `probability` — 0–1 odds this entry is spawned at all. Omitted/1.0 =
 *     always spawned.
 * Resolution happens once per prefab spawn, off one seeded PRNG stream
 * shared across the whole `children` list, via `resolveSeededPick`
 * (`@voxim/engine`) — the engine's `spawnPrefab` subtree walk is the sole
 * consumer of the raw (unresolved) form.
 */
export interface ChildPrefabRef {
  prefabId?: string;
  /** Variant pool of prefab ids — one is picked at random when present. */
  pool?: string[];
  /** 0–1 probability this entry is spawned at all. Omit for always-spawned. */
  probability?: number;
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
 *
 * `morphValues` (T-085) is the species' visual archetype: since T-179/T-180
 * retired the per-creature skeleton files, every humanoid — species included —
 * shares the one `biped` skeleton and differentiates purely through
 * `SkeletonDef.morphParams`-keyed proportions (same mechanism drowner/
 * rotten_knight already use). A dwarf is "shorter and wider" as
 * `legLength`/`torsoHeight` down + `shoulderWidth`/`hipWidth` up on the same
 * bones and clips a human plays — no new skeleton, no new animations. Keys
 * must match the player model's skeleton `morphParams[].id`; boot-checked in
 * server.ts alongside the existing default-species check. Absent/omitted →
 * no species-driven proportion bias (human has none, the baseline body).
 */
export interface SpeciesDef {
  modifiers: Array<{ stat: string; op: "add" | "mul"; value: number }>;
  morphValues?: Record<string, number>;
}

/**
 * A persistent injury's debuff (T-008): stat modifiers applied to an injured
 * actor through the Status/Modifier fold. Additive penalties scale with the
 * injury's `severity`. Same shape as SpeciesDef — both are named StatModifier
 * bundles keyed by id in game_config.
 */
export interface InjuryDef {
  modifiers: Array<{ stat: string; op: "add" | "mul"; value: number }>;
  /**
   * Whether a severe combat hit may randomly roll this injury (T-008). Defaults
   * true. Set false for spawn/scripted-only states like the T-079 `displaced`
   * heir debuff, so they never appear from ordinary combat.
   */
  combatEligible?: boolean;
}

/** One day-night lighting phase (T-280). Colors are `#rrggbb` strings. */
export interface PalettePhase {
  sky: string;
  fog: string;
  sun: string;
  /** Hemisphere ground-fill color — the bounce tone on shadowed/downward faces.
   *  Palette-driven (T-288) so shadow ambient is warm earth, not a hardcoded
   *  desaturated green. Defaults to a darkened `sky` if omitted. */
  hemiGround?: string;
  sunIntensity: number;
  hemiIntensity: number;
  fogFar: number;
}

/**
 * The single color authority (T-280). `ramp` is the named swatch set every
 * material color snaps to at load; `tokens` alias render-literal roles to a ramp
 * swatch; `phases` is the day-night lighting. Ships in the bootstrap blob.
 */
export interface Palette {
  ramp: Record<string, string>;
  /** Swatch names reserved from material auto-snap (fire/corruption/vitals).
   * Ordinary materials never snap onto these; only explicit `materials`
   * overrides or `tokens` may reference them. */
  signal?: string[];
  /** Explicit material-name → swatch-name overrides (authored intent that
   * nearest-color can't infer, e.g. water → deep-water, torch → ember). */
  materials?: Record<string, string>;
  tokens: Record<string, string>;
  phases: Record<string, PalettePhase>;
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
    /**
     * Knockback emphasis (T-292): scales `knockbackImpulseXY`/`Z` by how hard
     * the hit landed relative to `referenceDamage` (clamped to
     * [minMult, maxMult]) — a heavy swing shoves harder than a light poke.
     */
    knockback: {
      /** Damage value that maps to multiplier 1.0. */
      referenceDamage: number;
      minMult: number;
      maxMult: number;
    };
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
     * Soft aim-assist (T-320): on an attack's active tick the combat resolver
     * orients the swing (+ the actor's Facing) toward the best enemy inside a
     * frontal cone — nearest by a distance-dominant cost with angular offset as
     * the tiebreak. No hard lock-on; if no enemy is in cone the swing goes
     * straight ahead. Server-authoritative (identical for mouse and pad).
     */
    aimAssist: {
      /** Max distance (world units) an enemy can be and still be snapped to. */
      rangeUnits: number;
      /** Half-angle (degrees) of the frontal cone about the actor's facing. */
      halfAngleDeg: number;
    };
    /**
     * Fallback projectile spawn parameters used only when a ranged weapon
     * action has no explicit ProjectileActionConfig.spawnOffset. Values are
     * entity-local (fwd, right, up) coordinates applied via localToWorld
     * from the shooter's facing — i.e. approximately "from the shoulder, forward".
     */
    projectileDefaults: {
      spawnOffset: { fwd: number; right: number; up: number };
    };
    /**
     * Hold-to-aim pitch → elevation mapping (T-337). `InputState.pitch`
     * (radians, accumulated client-side while a hold-to-aim cast is
     * charging) is clamped to [pitchMinDeg, pitchMaxDeg] (degrees) and fed
     * DIRECTLY as the elevation angle into `launchVelocity(facing, pitch,
     * speed)` — up = farther, down = nearer, monotonic for a fixed launch
     * speed as long as pitchMaxDeg stays <= 45deg (beyond 45deg more
     * elevation REDUCES range for a fixed speed, which would invert the
     * "up = farther" mapping the ticket requires — do not raise
     * pitchMaxDeg past 45 without re-deriving the monotonic bound).
     * Replaces the old flat `arcFactor` (a fixed seed-upward-velocity
     * fraction with no player control) outright — every ranged/thrown
     * weapon's launch direction is now pitch-driven, gravity or not (a
     * gravityScale:0 magic bolt still points along the aimed elevation in
     * a straight line; only its FLIGHT arc ignores gravity).
     */
    aim: {
      pitchMinDeg: number;
      pitchMaxDeg: number;
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
      /**
       * Global rear-hit multiplier (T-299, 1.25-1.5): damage is scaled by
       * this when the attacker struck from behind the target's facing (the
       * SAME front/back dot-product test the hit handler already computes
       * for hit_front/hit_back reaction selection, reused rather than
       * recomputed). Applies to every actor equally — a Shield-Knight's
       * frontal block arc already gives it a flanking weakness for free
       * (an attack outside `blockArcHalfRadians` disables `isBlocking`), so
       * this multiplier needs no archetype-specific override.
       */
      rearMultiplier: number;
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
    /** Build-brush default voxel edge size (world units; keep a 0.25 multiple to
     *  stay on the terrain lattice). The HUD adjusts the live brush from here. */
    defaultVoxelSize: number;
    /** Build-brush default line spacing (cells skipped between stamps; 0 = solid). */
    defaultSpacing: number;
    /** Base capture (T-082): deploying a workstation re-stamps owned ones nearby. */
    capture: {
      /** Radius around a deployed workstation that captures enemy-owned ones (world units). */
      radiusWorldUnits: number;
    };
    /** Client roof rendering (T-066): height above interior floor a roof
     *  quad sits at — matches atlas's WALL_HEIGHT so the roof reads as
     *  resting on top of the walls that seal the enclosure. */
    roofHeightAboveFloor: number;
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
    /** T-079: horizontal radius (world units) for the live-workstation check that
     * decides whether an heir's hearth still stands. Default 3. */
    hearthDetectRadius?: number;
    /** T-079: fraction of max health a displaced heir spawns at when the hearth
     * was destroyed (the weakened state). Default 0.5. */
    displacedHealthFraction?: number;
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
    /**
     * Terrain chunk load radius as a multiple of `network.aoiRadius` (T-064).
     * A chunk within `aoiRadius × this` of any active (Position-bearing) entity
     * stays loaded; one beyond it for `chunkUnloadGraceTicks` is unloaded.
     * Keep ≥ 1.0 so terrain is always present at least as far as a client sees.
     */
    chunkLoadRadiusMultiplier: number;
    /**
     * Ticks a chunk must stay outside every active entity's load radius before
     * it is unloaded (T-064). Its state is cached in memory first, so an entity
     * re-entering the radius reloads it verbatim. Large values keep the unload
     * far from live gameplay; 0 unloads the tick it falls out of range.
     */
    chunkUnloadGraceTicks: number;
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
    /** Radius (world units) within which an NPC perceives a combat / noise
     * event (T-040) and aggros toward its source, even outside its visual
     * cone. The event-driven aggro path that runs alongside the spatial
     * detection scan in `set_job_attack_nearest`. */
    perceptionRadius: number;
    /** NoiseLevel in [0,1] at or above which NoiseSystem publishes a
     * `LoudNoise` event (T-040) — a sprint is loud enough to be heard, a
     * crouch-walk is not. */
    loudNoiseThreshold: number;
  };
  /** Client render look-tuning that doesn't fit MaterialRenderDef/GradeDef
   *  (T-315 D3) — foliage wind + camera-occlusion fade-cylinder geometry, and
   *  the shared drawNoise `amount` coefficient for the organic/dirt/sand
   *  procedural texture styles. */
  render: {
    /** Foliage sway (canopy_fade.ts's wind uniforms). */
    canopyWind: {
      /** Horizontal wind direction (three-space XZ), roughly normalized. */
      dirX: number;
      dirY: number;
      /** World units of sway per unit of voxel height. */
      strength: number;
    };
    /** Camera-occlusion fade-cylinder geometry (canopy_fade.ts). Anything
     *  above the player inside this cylinder fades/discards so the camera
     *  isn't blocked by overhead canopy. */
    canopyFade: {
      /** Height above the player's feet where fade begins. */
      minHeight: number;
      /** Height above the player's feet where fade is fully complete. */
      maxHeight: number;
      /** Horizontal radius where fade is fully active. */
      innerRadius: number;
      /** Horizontal radius of the transition band outside innerRadius. */
      outerRadius: number;
      /** Discard threshold on (vertFade × horizFade). */
      cutoff: number;
    };
    /** Camera-occlusion fade extended to SIDE occluders (T-314) — tall
     *  walls/buildings/cliffs the rigid over-the-shoulder camera (T-328)
     *  ends up on the far side of. Same discard mechanism as canopyFade
     *  (shares its uFadeCutoff), but the horizontal test is the voxel's
     *  distance from the camera→player LINE SEGMENT (clamped to the
     *  segment, not a radial blob) so only the sliver of geometry actually
     *  between camera and player is affected, and the vertical test starts
     *  just above the player's feet (not the head) so a wall fades along
     *  its whole height while the floor the player stands on never does. */
    wallFade: {
      /** Height above the player's feet where fade begins — keep small and
       *  positive so ground/floor voxels at foot level are never eaten. */
      minHeight: number;
      /** Height above the player's feet where fade is fully complete. */
      maxHeight: number;
      /** Perpendicular distance from the camera-player segment where fade
       *  is fully active — deliberately tight (a wall's footprint), unlike
       *  canopyFade's wide canopy-dome radius. */
      innerRadius: number;
      /** Perpendicular distance of the transition band outside innerRadius. */
      outerRadius: number;
    };
    /** Per-style ±fraction fine-grain amount for the organic/dirt/sand
     *  procedural texture generators (material_textures.ts's drawNoise). */
    textureStyle: {
      organicAmount: number;
      dirtAmount: number;
      sandAmount: number;
    };
  };
  /** Free-look pointer-lock camera (T-320; rotation ownership inverted by
   *  T-328): rig geometry + look feel. Mouse-X drives the player's FACING
   *  directly (a pad right-stick would use the same seam) and camera yaw is
   *  rigidly DERIVED from it; mouse-Y still drives camera pitch directly —
   *  no follow controller, no deadzone/spring on either axis. Geometry knobs
   *  make the framing (top-down tactical vs. lower over-the-shoulder) pure
   *  content tuning. Pitch is clamped to a narrow band around the shipped
   *  rest gaze so the horizon never floods in (keeps the T-310 F telephoto
   *  property). Client-side presentation only (`mouseSensitivity` also
   *  drives the client-only facing accumulator — no wire change). */
  /**
   * Keyboard bindings (T-335). Action id → the `KeyboardEvent.code`s that
   * trigger it (several allowed, e.g. WASD + arrows). Content, not code, so a
   * rebind is a JSON edit.
   *
   * **A binding may never be a MODIFIER key** (`Control*`/`Alt*`/`Meta*`) — not
   * as a matter of taste but of physics: a browser cannot `preventDefault` its
   * own reserved chords, so the moment crouch sat on Ctrl, crouch-walking
   * forward (Ctrl+W) *closed the tab*. Binding a modifier turns every ordinary
   * movement key into a browser chord. `Tab` and the F-keys are out for the same
   * reason. `validateInputBindings` (loader.ts) enforces this at boot, so the
   * bug cannot come back by accident — which is the actual deliverable of T-335,
   * not the rebind itself.
   */
  input: {
    bindings: Record<string, string[]>;
  };
  camera: {
    /** Metres behind the player along the yaw direction (at rest pitch). */
    backDistance: number;
    /** Metres above the player's ground position (at rest pitch). Rest gaze
     *  angle below horizontal is atan2(heightAbove − lookAtBias, backDistance). */
    heightAbove: number;
    /** Look-at point this many metres above the player root (the "chest"). */
    lookAtBias: number;
    /** Vertical field of view in degrees (narrow telephoto at defaults). */
    fovDeg: number;
    /** Radians of yaw/pitch applied per look-delta pixel (mouse sensitivity). */
    mouseSensitivity: number;
    /** When true, moving the mouse up pitches the gaze down (flight invert). */
    invertY: boolean;
    /** Rest pitch (degrees below horizontal) — reproduces the T-317 gaze. */
    pitchRestDeg: number;
    /** Lower pitch clamp (degrees below horizontal) — smaller = flatter. */
    pitchMinDeg: number;
    /** Upper pitch clamp (degrees below horizontal) — larger = steeper. Keep
     *  the band narrow: a wide pitch floods the horizon in and reopens
     *  fog/draw-distance issues (T-310 F). */
    pitchMaxDeg: number;
  };
  /** Fog-of-war LOS gameplay tuning (T-315 D5) — moved out of
   *  `@voxim/protocol`'s fog.ts, which now keeps only wire-shape constants
   *  (grid size, cell packing). Server (FogOfWarSystem) and client
   *  (FogOfWar.updateLocalLOS) each run their own copy of the same LOS
   *  raycast against these same numbers — byte-parity between the two is
   *  load-bearing, same as the shared PRNG/noise primitives (T-315 C5). */
  fogOfWar: {
    /** Half-angle of the LOS cone in radians (≈55°, total ≈110°). */
    losHalfAngleRad: number;
    /** LOS radius in world units. */
    losRadius: number;
    /** Number of rays in the cone — 1 ray per degree gives 110 rays. */
    losRayCount: number;
    /** Ray walk step in world units. Smaller = fewer cell skips at oblique angles. */
    losStep: number;
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
  /** World-unit height. Omit to snap to the terrain surface at (x,y) — the
   *  default for structural props (they have no physics to settle them). Set
   *  explicitly only to deliberately pin a prop off the ground. */
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
 *            list, so they are never stale.
 */
export interface TileLayout {
  tileId: string;
  entities: TileEntityConfig[];
  npcs: TileEntityConfig[];
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
  /**
   * T-186 Layer 2 — recipe-driven body volumes. When present, `evaluateBodyRecipe()`
   * (body_recipe.ts) fills each part's shape from the resolved morphParams instead of
   * authored sub-object voxel positions. Replaces authored `bone_segment`-style voxels
   * for every bone this recipe covers — see entity_mesh.ts / hitbox_derive.ts call sites.
   */
  bodyRecipe?: BodyRecipeDef;
  /**
   * Procedural gait catalogue id (T-308) — names a GaitDef in
   * `data/gaits/`. The client's pose pipeline uses it to generate the
   * LOWER body + feet from interpolated key poses (phase driven by ground
   * distance, not time) instead of the locomotion clip's leg track; absent
   * = no procedural gait, the locomotion clip drives the legs as before
   * (e.g. the wolf archetype, which has no biped leg-bone naming).
   * Cross-checked against `content.gaits` at load (loader.ts).
   */
  gaitId?: string;
}

/**
 * One body part's volume, attached to a bone. Each numeric field is either a
 * constant or a formula.ts expression string evaluated against the skeleton's
 * resolved morphParams (e.g. "torsoHeight * 0.6") — see body_recipe.ts.
 *
 * Entity-local axes: x = right, y = forward, z = up. Volumes are authored
 * along local +Z (the same convention `bone_segment.json` used), centered on
 * the bone origin, so they slot into `upgradeToSkeletonModel`'s existing
 * per-bone Group exactly like the sub-objects they replace.
 */
export interface BodyPartRecipeDef {
  /** Bone this part attaches to — must exist in the owning SkeletonDef.bones. */
  boneId: string;
  shape: "capsule" | "tapered_box";
  /** Extent along local +Z (bone axis), in model units. */
  length: number | string;
  /** Radius (capsule) or half-width at the bone-origin end (tapered_box). */
  radiusOrWidthTop: number | string;
  /** tapered_box only — half-width at the far end. Ignored for capsule. */
  radiusOrWidthBot?: number | string;
  /** Material NAME (resolved via a resolveMaterial(name)->id callback, ProcModel-style). */
  material: string;
}

/**
 * T-186 Layer 2 recipe — one volume declaration per body part. A voxelizer
 * (`evaluateBodyRecipe`) fills each part at `voxelSize` grain from the
 * skeleton's resolved morph values, replacing authored body voxels.
 */
export interface BodyRecipeDef {
  /** Voxel edge length in model units — every part fills at this grain. */
  voxelSize: number;
  parts: BodyPartRecipeDef[];
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
  /**
   * Corrupted-creature death-dissolve phase (T-311 P5c). 0 = intact, 1 =
   * fully dissolved. DERIVED each tick by `AnimationSystem` from
   * `Resource.values["dissolve_timer"]` (see `systems/animation.ts`) — the
   * server writes it, the client drives ALL fray/drift presentation from
   * this one scalar + the entity's `DissolveProfileDef`. Stays 0 for every
   * entity that never carries a `dissolve_timer` Resource.
   */
  dissolutionPhase: number;
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
