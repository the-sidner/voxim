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
  hunger:             7,
  thirst:             8,
  stamina:            9,
  // 10 is retired (was attackCooldown) — do not reuse
  combatState:        11,
  lifetime:           12,
  modelRef:           13,
  animationState:     14,
  equipment:          15,
  heritage:           16,
  itemData:           17,
  inventory:          18,
  craftingQueue:      19,
  interactCooldown:   20,
  blueprint:          21,
  resource_node:      22,
  worldClock:         23,
  tileCorruption:     24,
  corruptionExposure: 25,
  traderInventory:    26,
  loreLoadout:        27,
  activeEffects:      28,
  hitbox:             29,
} as const;

/** Map from component name (ComponentDef.name) → wire u8 type ID. */
export const COMPONENT_NAME_TO_TYPE: ReadonlyMap<string, number> = new Map(
  Object.entries(ComponentType) as [string, number][],
);

/** Map from wire u8 type ID → component name. */
export const COMPONENT_TYPE_TO_NAME: ReadonlyMap<number, string> = new Map(
  (Object.entries(ComponentType) as [string, number][]).map(([k, v]) => [v, k]),
);
