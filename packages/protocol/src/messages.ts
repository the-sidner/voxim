/**
 * Wire message types for the client ↔ tile-server protocol.
 *
 * Two channels (per the WebTransport design):
 *   - Unreliable datagrams:  InputDatagram  (client → server, ~60 Hz)
 *   - Reliable streams:      StateMessage   (server → client, per tick)
 *
 * These are plain TypeScript interfaces — serialisation is handled by the
 * Serialiser implementations in @voxim/codecs.  The interfaces are the schema;
 * a schema change is a compile error on both ends simultaneously.
 */
import type { EntityId } from "@voxim/engine";

// ---- input datagram (client → server, unreliable, ~60 Hz) ----

/**
 * Sent by the client on every render frame.
 * Loss-tolerant — latest value wins. seq is load-bearing for reconciliation.
 */
export interface InputDatagram {
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
   *   1  block (RMB)
   *   2  jump (Space)
   *   3  interact (E)
   *   4  dodge (Shift+dir)
   *   5  crouch (Ctrl)
   *   6  equip
   *   7  consume
   *   8  skill slot 1
   *   9  skill slot 2
   *   10 skill slot 3
   *   11 skill slot 4
   *   12 trade buy
   *   13 trade sell
   *   14 externalise (write fragment to tome)
   *   15 internalise (read tome to learn fragment)
   *   16-31 reserved
   */
  actions: number; // u32

  /**
   * General-purpose slot index carried alongside actions.
   * Used by: TraderSystem (listing slot), DynastySystem (fragment/inventory slot).
   * 0 when no slot interaction is active.
   */
  interactSlot: number; // u32
}

/** Extract a named action bit from an InputDatagram.actions bitfield. */
export const ACTION_USE_SKILL = 1 << 0;
export const ACTION_BLOCK = 1 << 1;
export const ACTION_JUMP = 1 << 2;
export const ACTION_INTERACT = 1 << 3;
export const ACTION_DODGE = 1 << 4;
export const ACTION_CROUCH = 1 << 5;
export const ACTION_EQUIP = 1 << 6;
export const ACTION_CONSUME = 1 << 7;
export const ACTION_SKILL_1 = 1 << 8;
export const ACTION_SKILL_2 = 1 << 9;
export const ACTION_SKILL_3 = 1 << 10;
export const ACTION_SKILL_4 = 1 << 11;
export const ACTION_TRADE_BUY = 1 << 12;
export const ACTION_TRADE_SELL = 1 << 13;
export const ACTION_EXTERNALISE = 1 << 14;
export const ACTION_INTERNALISE = 1 << 15;

export function hasAction(actions: number, flag: number): boolean {
  return (actions & flag) !== 0;
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
