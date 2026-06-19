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
  // 8 (SkillActivated) retired — SkillSystem deleted (T-260b); the event was never
  // EventRouter-translated, so it was wire-dead. Never reuse.
  TradeCompleted:    9,
  LoreExternalised:  10,
  LoreInternalised:  11,
  HitSpark:                    12,
  BuildingMaterialsConsumed:   13,
  BuildingMissingMaterials:    14,
  GateCrossing:                15,
  ZoneEntered:                 16,
  Healed:                      17,
} as const;
