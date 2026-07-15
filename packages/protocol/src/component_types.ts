/**
 * Component type IDs for the binary state protocol.
 * Each networked component has a stable u8 ID.
 *
 * RULE: IDs are wire format — never reassign or reuse an ID.
 * To retire a component, leave its slot reserved but remove it from the enum.
 */

import { SCENE_PARENT_WIRE_ID } from "@voxim/engine";

export const ComponentType = {
  heightmap:          0,
  materialGrid:       1,
  position:           2,
  velocity:           3,
  facing:             4,
  inputState:         5,
  health:             6,
  // 7 is retired (was hunger) — server-only Resource now (T-238c); do not reuse
  // 8 is retired (was thirst) — server-only Resource now (T-238c); do not reuse
  // 9 is retired (was stamina) — server-only Resource now (T-238b); do not reuse
  // 10 is retired (was attackCooldown) — do not reuse
  // 11 is retired (was combatState) — split into staggered (36) + counterReady (37)
  //    plus the server-only iFrameActive / blockHeld / dodgeCooldown
  // 12 is retired (was lifetime) — server-only Resource now
  //    (data/resources/lifetime.json, cross@0 → destroy_self); do not reuse (T-241)
  modelRef:           13,
  animationState:     14,
  equipment:          15,
  heritage:           16,
  itemData:           17,
  inventory:          18,
  // 19 is retired (was craftingQueue) — written once at player spawn, read by
  //    nobody; crafting is entirely WorkstationBuffer-based (T-350); do not reuse
  // 20 (interactCooldown) retired — server-only rate limiter, never needed on client
  blueprint:          21,
  resource_node:      22,
  worldClock:         23,
  // 24 (tileCorruption) retired — corruption mechanic removed (T-238e),
  //    to be reintroduced later at a different scale; do not reuse
  // 25 (corruptionExposure) retired — same; do not reuse
  traderInventory:    26,
  loreLoadout:        27,
  // 28 (activeEffects) retired — buffs are scene-graph children (T-239); do not reuse
  hitbox:             29,
  workstationBuffer:  30,
  lightEmitter:       31,
  darknessModifier:   32,
  durability:         33,
  // 34 is retired (was inscribed) — server-only now (T-349): no client
  //    consumer ever read it off the wire; do not reuse
  // 35 is retired (was qualityStamped) — server-only now (T-349), same
  //    reason; do not reuse
  // 36 (staggered) retired — stagger is a reaction action + `staggered`
  //    tag now; rendered from AnimationState. Never reuse.
  counterReady:       37,
  workstationTag:     38,
  stats:              39,
  provenance:         40,
  gateLink:           41,
  openMask:           42,
  kindGrid:           43,
  name:               44,
  // 45 (characterStateMachine) retired — CSM deleted (T-228)
  // 46 (swingChain) retired — swing chain folded into actions (T-227)
  // 47 is retired (was actorSlots) — server-only now (T-349): the "client
  //    runs slot dispatch for prediction" justification was never realized
  //    (the predictor is position-only); do not reuse
  activeActions: 48,
  resource:           50,  // T-262: vitals (stamina/hunger/thirst/poise) on the wire for the HUD
  actionCooldowns:    51,  // T-265: per-action cooldowns + GCD for the skill bar sweep
  jobBoard:           52,  // T-076: hiring board's pending jobs on the wire for the job-board panel
  container:          53,  // T-077/T-078: family library/treasury slot store, on the wire for the chest deposit/withdraw panel
  vegFieldGrid:       54,  // T-311 P3: per-cell canopyLight/corruption/fertility (render fields, never collision)
  surfaceStateGrid:   55,  // T-311 P3: per-cell wetness/overgrowth/wear/variantIndex/ruinAge/traffic
  waterGrid:          56,  // T-311 P3: per-cell water surface level (f32, NaN = no water)
  poiInteractable:    57,  // T-212 v2: `action`/`puzzle` POI world-prop marker — client's hover/click
                           //   detects it the same way it detects workstationBuffer/container/traderInventory
  cliffGrid:          58,  // T-311 P6: per-cell profileId/erosion/tier/edge for the terraced-cliff voxeliser
  bone:               59,  // T-219: one entity per skeleton bone; boneId only — restPose/parentBoneId
                           //   are content data (SkeletonDef.bones), motion is derived client-side, never wired
  // 49 (parent) — defined in @voxim/engine/src/scene.ts; engine owns the
  //    scene-graph primitive (co-equal with World), so the numeric constant
  //    lives there (SCENE_PARENT_WIRE_ID). Mirrored into this enum so the
  //    client decode registry (codec_registry.ts) and COMPONENT_TYPE_TO_NAME
  //    can resolve it like any other component. Never reuse.
  parent: SCENE_PARENT_WIRE_ID,
} as const;

/** Map from component name (ComponentDef.name) → wire u8 type ID. */
export const COMPONENT_NAME_TO_TYPE: ReadonlyMap<string, number> = new Map(
  Object.entries(ComponentType) as [string, number][],
);

/** Map from wire u8 type ID → component name. */
export const COMPONENT_TYPE_TO_NAME: ReadonlyMap<number, string> = new Map(
  (Object.entries(ComponentType) as [string, number][]).map(([k, v]) => [v, k]),
);
