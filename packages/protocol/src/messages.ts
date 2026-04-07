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
  Equip        = 1,  // payload: u8 fromInventorySlot
  Unequip      = 2,  // payload: u8 equipSlot (EquipSlotIndex enum)
  MoveItem     = 3,  // payload: u8 fromSlot, u8 toSlot
  DropItem     = 4,  // payload: u8 fromSlot
  UseItem      = 5,  // payload: u8 fromSlot
  Externalise  = 6,  // payload: u8 fragIndex (index into learnedFragmentIds)
  Internalise  = 7,  // payload: u8 inventorySlot (slot holding the tome)
  TradeBuy     = 8,  // payload: u32 listingSlot
  TradeSell    = 9,  // payload: u8 inventorySlot
  // 10-255 reserved for future commands
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
  | { cmd: CommandType.Equip;       fromInventorySlot: number }
  | { cmd: CommandType.Unequip;     equipSlot: EquipSlotIndex }
  | { cmd: CommandType.MoveItem;    fromSlot: number; toSlot: number }
  | { cmd: CommandType.DropItem;    fromSlot: number }
  | { cmd: CommandType.UseItem;     fromSlot: number }
  | { cmd: CommandType.Externalise; fragIndex: number }
  | { cmd: CommandType.Internalise; inventorySlot: number }
  | { cmd: CommandType.TradeBuy;    listingSlot: number }
  | { cmd: CommandType.TradeSell;   inventorySlot: number };

export interface CommandDatagram {
  /** Monotonically increasing, shared sequence space with MovementDatagram. */
  seq: number; // u32
  command: CommandPayload;
}

// ---- entity delta (component of StateMessage) ----

/**
 * A single component change for one entity, delta-encoded.
 * The network layer emits one EntityDelta per (entityId, componentToken) pair
 * that appears in the tick's AppliedChangeset.
 */
export interface EntityDelta {
  entityId: EntityId;
  /** Identifies the component type — matches ComponentDef.name. */
  componentName: string;
  /** Binary-encoded component data (via the component's Serialiser). */
  data: Uint8Array;
  /** Version counter at time of encoding. Used by client to discard stale deltas. */
  version: number;
}

/** Entity was destroyed this tick. */
export interface EntityDestroyed {
  entityId: EntityId;
}

// ---- state message (server → client, reliable stream, per tick) ----

/**
 * Sent by the tile server at the end of each tick to every connected client.
 * ack_input_seq is load-bearing for client reconciliation.
 */
export interface StateMessage {
  /** Which server tick produced this state. */
  serverTick: number; // u32

  /**
   * Last input sequence number the server has processed for this client.
   * Client discards buffered inputs with seq <= ackInputSeq, then replays the rest.
   */
  ackInputSeq: number; // u32

  /** Component changes this tick. */
  entityDeltas: EntityDelta[];

  /** Entities removed this tick. */
  entityDestroys: EntityDestroyed[];

  /** Discrete game events this tick (damage, death, crafting, etc.). */
  events: GameEvent[];
}

// ---- game events (carried inside StateMessage.events) ----

export type GameEvent =
  | DamageDealtEvent
  | EntityDiedEvent
  | CraftingCompletedEvent
  | BuildingCompletedEvent
  | HungerCriticalEvent
  | GateApproachedEvent
  | NodeDepletedEvent
  | DayPhaseChangedEvent
  | SkillActivatedEvent
  | TradeCompletedEvent
  | LoreExternalisedEvent
  | LoreInternalisedEvent;

export interface DamageDealtEvent {
  type: "DamageDealt";
  targetId: EntityId;
  sourceId: EntityId;
  amount: number;
  blocked: boolean;
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
