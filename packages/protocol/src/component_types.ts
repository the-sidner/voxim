/**
 * Component type IDs for the binary state protocol.
 * Each networked component has a stable u8 ID.
 *
 * RULE: IDs are wire format — never reassign or reuse an ID.
 * To retire a component, leave its slot reserved but remove it from the enum.
 */

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
  craftingQueue:      19,
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
  inscribed:          34,
  qualityStamped:     35,
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
  actorSlots: 47,
  activeActions: 48,
  resource:           50,  // T-262: vitals (stamina/hunger/thirst/poise) on the wire for the HUD
  actionCooldowns:    51,  // T-265: per-action cooldowns + GCD for the skill bar sweep
  // 49 (parent) — defined in @voxim/engine/src/scene.ts; engine owns the
  //    scene-graph primitive (co-equal with World), so its wire id lives
  //    there. Reserved here so the numbering map stays visible. Never reuse.
} as const;

/** Map from component name (ComponentDef.name) → wire u8 type ID. */
export const COMPONENT_NAME_TO_TYPE: ReadonlyMap<string, number> = new Map(
  Object.entries(ComponentType) as [string, number][],
);

/** Map from wire u8 type ID → component name. */
export const COMPONENT_TYPE_TO_NAME: ReadonlyMap<number, string> = new Map(
  (Object.entries(ComponentType) as [string, number][]).map(([k, v]) => [v, k]),
);
