/**
 * Wire message types for the client ↔ tile-server protocol.
 *
 * Three channels:
 *   - Unreliable datagrams type=1:  MovementDatagram  (client → server, ~60 Hz)
 *   - Unreliable datagrams type=2:  CommandDatagram   (client → server, event-driven)
 *   - Reliable stream:              StateMessage       (server → client, per tick)
 *
 * These are plain TypeScript interfaces — serialisation is handled by the
 * Serialiser implementations in @voxim/codecs.  The interfaces are the schema;
 * a schema change is a compile error on both ends simultaneously.
 */
import type { EntityId } from "@voxim/engine";

// ---- MovementDatagram (client → server, unreliable, ~60 Hz) ----

/**
 * Sent by the client on every render frame.
 * Loss-tolerant — latest value wins. seq is load-bearing for reconciliation.
 *
 * Carries only continuous movement state and stateless one-shot combat actions.
 * Slot-based commands (equip, trade, lore, inventory management) are sent via
 * CommandDatagram instead.
 */
export interface MovementDatagram {
  /** Monotonically increasing per client; never resets. Server echoes last processed seq. */
  seq: number; // u32

  /** Client tick at time of input — used for lag compensation mapping. */
  tick: number; // u32

  /** Client wall-clock at send time (ms since epoch). Used to estimate RTT. */
  timestamp: number; // f64

  /** Character facing angle in radians (world-space, 0 = +x axis). */
  facing: number; // f32

  /**
   * Normalised movement direction on the horizontal plane.
   * (0,0) = stationary. Independent of facing.
   */
  movementX: number; // f32
  movementY: number; // f32

  /**
   * Action bitfield. Bit assignments:
   *   0  attack (LMB)
   *   1  block (RMB / F)
   *   2  jump (Space)
   *   3  interact (E)
   *   4  dodge (Shift+dir)
   *   5  crouch (Ctrl)
   *   6  consume (C)
   *   7  skill slot 1
   *   8  skill slot 2
   *   9  skill slot 3
   *   10 skill slot 4
   *   11-31 reserved
   *
   * Slot-dependent actions (equip, trade, lore externalise/internalise) are NOT
   * carried here — they are sent as CommandDatagram.
   */
  actions: number; // u32
}

/** Extract a named action bit from a MovementDatagram.actions bitfield. */
export const ACTION_USE_SKILL  = 1 << 0;
export const ACTION_BLOCK      = 1 << 1;
export const ACTION_JUMP       = 1 << 2;
export const ACTION_INTERACT   = 1 << 3;
export const ACTION_DODGE      = 1 << 4;
export const ACTION_CROUCH     = 1 << 5;
export const ACTION_CONSUME    = 1 << 6;
export const ACTION_SKILL_1    = 1 << 7;
export const ACTION_SKILL_2    = 1 << 8;
export const ACTION_SKILL_3    = 1 << 9;
export const ACTION_SKILL_4    = 1 << 10;

export function hasAction(actions: number, flag: number): boolean {
  return (actions & flag) !== 0;
}

// ---- CommandDatagram (client → server, unreliable, event-driven) ----

/**
 * Discrete game commands that require slot or entity indices.
 * Sent only when the player performs an inventory/equipment/lore/trade action —
 * not every frame.
 *
 * Wire layout (handled by commandDatagramCodec):
 *   u8   type = 2
 *   u32  seq
 *   u8   cmdType          (CommandType enum)
 *   u16  payloadLen       (byte count of the payload that follows)
 *   [payloadLen bytes]    (command-specific fields, schema per CommandType)
 *
 * Forward compatibility: unknown cmdType values are skipped using payloadLen.
 * Adding fields to an existing command appends them at the end; old decoders
 * read what they know and skip the remainder via payloadLen.
 */
export const enum CommandType {
  Equip           = 1,  // payload: u8 fromInventorySlot
  Unequip         = 2,  // payload: u8 equipSlot (EquipSlotIndex enum)
  MoveItem        = 3,  // payload: u8 fromSlot, u8 toSlot
  DropItem        = 4,  // payload: u8 fromSlot
  UseItem         = 5,  // payload: u8 fromSlot
  Externalise     = 6,  // payload: u8 fragIndex (index into learnedFragmentIds)
  Internalise     = 7,  // payload: u8 inventorySlot (slot holding the tome)
  TradeBuy        = 8,  // payload: u32 listingSlot
  TradeSell       = 9,  // payload: u8 inventorySlot
  // 10 (PlaceBlueprint) retired — collapsed into Place (18)
  // 11 (DeployItem) retired — collapsed into Place (18)
  SelectRecipe    = 12, // payload: u8 strLen + UTF-8 recipeId — set active recipe on nearest workstation (assembly step)
  DebugGiveItem   = 13, // payload: u8 strLen + UTF-8 itemType + u8 quantity — dev-only cheat; server ignores unless dev mode
  DebugSpawnNpc   = 14, // payload: u8 strLen + UTF-8 npcTemplate + u8 quantity — spawn NPC(s) at player position
  DebugSetTime    = 15, // payload: f32 hour (0–24) — snap WorldClock to that hour
  DebugTeleport   = 16, // payload: f32 worldX + f32 worldY — teleport player
  DebugSetStat    = 17, // payload: u8 strLen + UTF-8 stat + f32 value — set health/stamina/etc
  Place           = 18, // payload: u8 source (0=prefab, 1=inventory) + f32 worldX + f32 worldY
                        //   source=prefab:    + u8 strLen + UTF-8 prefabId
                        //   source=inventory: + u8 fromInventorySlot
                        // Validated against the spawn prefab's `placeable` component.
  LoadWorkstation = 19, // payload: u8 inventorySlot + u8 bufferSlot — moves an inventory stack
                        //   into the named buffer slot of the player's nearest workstation.
                        //   Server validates proximity; bufferSlot 255 = "first free".
  TakeWorkstation = 20, // payload: u8 bufferSlot — moves the named buffer slot back to the
                        //   player's inventory (first free inventory slot).
  // 21-255 reserved for future commands
}

/**
 * Numeric index mapping for equipment slots, used in Unequip payloads.
 * Order must never change — it is part of the wire format.
 */
export const enum EquipSlotIndex {
  Weapon  = 0,
  OffHand = 1,
  Head    = 2,
  Chest   = 3,
  Legs    = 4,
  Feet    = 5,
  Back    = 6,
}

/** The string names that correspond to each EquipSlotIndex, in order. */
export const EQUIP_SLOT_NAMES = [
  "weapon", "offHand", "head", "chest", "legs", "feet", "back",
] as const;

export type CommandPayload =
  | { cmd: CommandType.Equip;          fromInventorySlot: number }
  | { cmd: CommandType.Unequip;        equipSlot: EquipSlotIndex }
  | { cmd: CommandType.MoveItem;       fromSlot: number; toSlot: number }
  | { cmd: CommandType.DropItem;       fromSlot: number }
  | { cmd: CommandType.UseItem;        fromSlot: number }
  | { cmd: CommandType.Externalise;    fragIndex: number }
  | { cmd: CommandType.Internalise;    inventorySlot: number }
  | { cmd: CommandType.TradeBuy;       listingSlot: number }
  | { cmd: CommandType.TradeSell;      inventorySlot: number }
  | { cmd: CommandType.Place;          source: "prefab";    prefabId: string;        worldX: number; worldY: number }
  | { cmd: CommandType.Place;          source: "inventory"; fromInventorySlot: number; worldX: number; worldY: number }
  | { cmd: CommandType.SelectRecipe;   recipeId: string }
  | { cmd: CommandType.LoadWorkstation; inventorySlot: number; bufferSlot: number }
  | { cmd: CommandType.TakeWorkstation; bufferSlot: number }
  | { cmd: CommandType.DebugGiveItem;  itemType: string; quantity: number }
  | { cmd: CommandType.DebugSpawnNpc;  npcTemplate: string; quantity: number }
  | { cmd: CommandType.DebugSetTime;   hour: number }
  | { cmd: CommandType.DebugTeleport;  worldX: number; worldY: number }
  | { cmd: CommandType.DebugSetStat;   stat: string; value: number };

export interface CommandDatagram {
  /** Monotonically increasing, shared sequence space with MovementDatagram. */
  seq: number; // u32
  command: CommandPayload;
}

// ---- game events (carried inside BinaryStateMessage.events) ----

export type GameEvent =
  | DamageDealtEvent
  | HitSparkEvent
  | EntityDiedEvent
  | CraftingCompletedEvent
  | BuildingCompletedEvent
  | BuildingMaterialsConsumedEvent
  | BuildingMissingMaterialsEvent
  | HungerCriticalEvent
  | GateApproachedEvent
  | NodeDepletedEvent
  | DayPhaseChangedEvent
  | SkillActivatedEvent
  | TradeCompletedEvent
  | LoreExternalisedEvent
  | LoreInternalisedEvent;

export interface HitSparkEvent {
  type: "HitSpark";
  x: number;
  y: number;
  z: number;
}

export interface DamageDealtEvent {
  type: "DamageDealt";
  targetId: EntityId;
  sourceId: EntityId;
  amount: number;
  blocked: boolean;
  /** World-space contact point for hit effects. */
  hitX: number;
  hitY: number;
  hitZ: number;
}

export interface EntityDiedEvent {
  type: "EntityDied";
  entityId: EntityId;
  killerId?: EntityId;
}

export interface CraftingCompletedEvent {
  type: "CraftingCompleted";
  crafterId: EntityId;
  recipeId: string;
}

export interface BuildingCompletedEvent {
  type: "BuildingCompleted";
  builderId: EntityId;
  blueprintId: EntityId;
  structureType: string;
}

export interface BuildingMaterial {
  itemType: string;
  quantity: number;
}

export interface BuildingMaterialsConsumedEvent {
  type: "BuildingMaterialsConsumed";
  builderId: EntityId;
  structureType: string;
  consumed: BuildingMaterial[];
}

export interface BuildingMissingMaterialsEvent {
  type: "BuildingMissingMaterials";
  builderId: EntityId;
  structureType: string;
  missing: BuildingMaterial[];
}

export interface HungerCriticalEvent {
  type: "HungerCritical";
  entityId: EntityId;
}

export interface GateApproachedEvent {
  type: "GateApproached";
  entityId: EntityId;
  gateId: string;
  destinationTileId: string;
}

export interface NodeDepletedEvent {
  type: "NodeDepleted";
  nodeId: EntityId;
  nodeTypeId: string;
  harvesterId: EntityId;
}

export interface DayPhaseChangedEvent {
  type: "DayPhaseChanged";
  /** "dawn" | "noon" | "dusk" | "midnight" */
  phase: string;
  timeOfDay: number;
}

export interface SkillActivatedEvent {
  type: "SkillActivated";
  casterId: EntityId;
  slot: number;
  effectType: string;
}

export interface TradeCompletedEvent {
  type: "TradeCompleted";
  buyerId: EntityId;
  traderId: EntityId;
  itemType: string;
  quantity: number;
  /** Positive = player paid coins; negative = player received coins (sell). */
  coinDelta: number;
}

export interface LoreExternalisedEvent {
  type: "LoreExternalised";
  entityId: EntityId;
  fragmentId: string;
}

export interface LoreInternalisedEvent {
  type: "LoreInternalised";
  entityId: EntityId;
  fragmentId: string;
}
