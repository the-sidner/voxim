/**
 * Event type IDs for the binary state protocol.
 * Each GameEvent variant has a stable u8 ID.
 *
 * RULE: IDs are wire format — never reassign or reuse an ID.
 */

export const EventType = {
  DamageDealt:       0,
  EntityDied:        1,
  CraftingCompleted: 2,
  BuildingCompleted: 3,
  HungerCritical:    4,
  GateApproached:    5,
  NodeDepleted:      6,
  DayPhaseChanged:   7,
  SkillActivated:    8,
  TradeCompleted:    9,
  LoreExternalised:  10,
  LoreInternalised:  11,
  HitSpark:          12,
} as const;
