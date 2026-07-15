/**
 * Per-event descriptor registry (T-348) — the single authoring site for every
 * GameEvent kind, mirroring CODEC_BY_WIREID for components (T-349).
 *
 * One descriptor per event carries everything that used to be hand-maintained
 * at four sites:
 *   - wire codec        (was: encodeEvent/decodeEvent switches in state_binary.ts)
 *   - AoI relevance     (was: isEventRelevant switch in tile-server/aoi.ts)
 *   - tile-bus binding  (was: ~150 lines of subscribes in tile-server/event_router.ts)
 *
 * The table is keyed by the union discriminant (`GameEvent["type"]`), so
 * adding a new GameEvent member without a descriptor is a COMPILE error —
 * stronger than the old switches, only one of which was exhaustive-checked.
 * Adding a new event = interface + union member in messages.ts, a wire id in
 * event_types.ts, and ONE entry here.
 *
 * Relevance is data, not a predicate: every event's AoI rule is one of
 * "always" or an OR of `field === playerId` / `knownEntities.has(field)`
 * clauses. A future event needing a genuinely new shape extends the clause
 * vocabulary here, not a switch elsewhere.
 *
 * Two events have no `fromTileEvent` binding by design:
 *   - ZoneEntered   — pushed directly via EventRouter.push() (zone tracker
 *     in handoff_coordinator.ts has no TileEvents counterpart).
 *   - GateCrossing  — built and encoded as a one-off BinaryStateMessage in
 *     handoff_coordinator.ts's sendGateCrossing (deliberate bypass to
 *     guarantee delivery
 *     before session close); its relevance entry exists for exhaustiveness.
 */
import { WireWriter, WireReader } from "@voxim/codecs";
import type { EntityId, EventBus } from "@voxim/engine";
import { EventType } from "./event_types.ts";
import { TileEvents } from "./tile_events.ts";
import type {
  BuildingCompletedPayload,
  BuildingMaterialsConsumedPayload,
  BuildingMissingMaterialsPayload,
  CraftingCompletedPayload,
  DamageDealtPayload,
  DayPhaseChangedPayload,
  EnclosureChangedPayload,
  EntityDiedPayload,
  GateApproachedPayload,
  HealedPayload,
  HitSparkPayload,
  HungerCriticalPayload,
  LoreExternalisedPayload,
  LoreInternalisedPayload,
  NodeDepletedPayload,
  TradeCompletedPayload,
} from "./tile_events.ts";
import type {
  GameEvent,
  DamageDealtEvent,
  HitSparkEvent,
  EntityDiedEvent,
  CraftingCompletedEvent,
  BuildingCompletedEvent,
  BuildingMaterial,
  BuildingMaterialsConsumedEvent,
  BuildingMissingMaterialsEvent,
  HungerCriticalEvent,
  GateApproachedEvent,
  GateCrossingEvent,
  NodeDepletedEvent,
  DayPhaseChangedEvent,
  TradeCompletedEvent,
  LoreExternalisedEvent,
  LoreInternalisedEvent,
  ZoneEnteredEvent,
  HealedEvent,
  EnclosureChangedEvent,
} from "./messages.ts";

// ---- descriptor shape ----

/** One AoI-relevance clause: does one EntityId-valued field admit this session? */
export type RelevanceClause<E> =
  | { readonly kind: "player"; readonly field: keyof E }   // ev[field] === playerId
  | { readonly kind: "known"; readonly field: keyof E };   // knownEntities.has(ev[field])

/** An event's AoI rule: unconditionally relevant, or an OR of clauses. */
export type Relevance<E> =
  | { readonly kind: "always" }
  | { readonly kind: "any"; readonly clauses: readonly RelevanceClause<E>[] };

export interface EventDescriptor<E extends GameEvent> {
  /** Stable u8 wire id from EventType. */
  readonly id: number;
  /** Write the event's fields — the caller writes the leading id byte. */
  encode(w: WireWriter, ev: E): void;
  decode(r: WireReader): E;
  readonly relevance: Relevance<E>;
  /**
   * Which TileEvents symbol sources this event, and how the bus payload maps
   * to the wire shape. Absent for events produced outside the bus pipeline.
   */
  readonly fromTileEvent?: {
    readonly event: symbol;
    // deno-lint-ignore no-explicit-any
    translate(payload: any): E;
  };
}

function player<E extends GameEvent>(field: keyof E): Relevance<E> {
  return { kind: "any", clauses: [{ kind: "player", field }] };
}
function known<E extends GameEvent>(field: keyof E): Relevance<E> {
  return { kind: "any", clauses: [{ kind: "known", field }] };
}
function anyOf<E extends GameEvent>(...clauses: RelevanceClause<E>[]): Relevance<E> {
  return { kind: "any", clauses };
}
const ALWAYS: { readonly kind: "always" } = { kind: "always" };

// ---- descriptors (wire field order is FORMAT — change = protocol break) ----

const damageDealt: EventDescriptor<DamageDealtEvent> = {
  id: EventType.DamageDealt,
  encode(w, ev) {
    w.writeUuid(ev.targetId);
    w.writeUuid(ev.sourceId);
    w.writeF32(ev.amount);
    w.writeU8(ev.blocked ? 1 : 0);
    w.writeF32(ev.hitX);
    w.writeF32(ev.hitY);
    w.writeF32(ev.hitZ);
  },
  decode(r) {
    return {
      type: "DamageDealt",
      targetId: r.readUuid(),
      sourceId: r.readUuid(),
      amount: r.readF32(),
      blocked: r.readU8() !== 0,
      hitX: r.readF32(),
      hitY: r.readF32(),
      hitZ: r.readF32(),
    };
  },
  relevance: anyOf<DamageDealtEvent>(
    { kind: "known", field: "targetId" },
    { kind: "known", field: "sourceId" },
  ),
  fromTileEvent: {
    event: TileEvents.DamageDealt,
    translate(p: DamageDealtPayload): DamageDealtEvent {
      return {
        type: "DamageDealt",
        targetId: p.targetId,
        sourceId: p.sourceId,
        amount: p.amount,
        blocked: p.blocked,
        hitX: p.hitX,
        hitY: p.hitY,
        hitZ: p.hitZ,
      };
    },
  },
};

const entityDied: EventDescriptor<EntityDiedEvent> = {
  id: EventType.EntityDied,
  encode(w, ev) {
    w.writeUuid(ev.entityId);
    w.writeU8(ev.killerId ? 1 : 0);
    if (ev.killerId) w.writeUuid(ev.killerId);
  },
  decode(r) {
    const entityId = r.readUuid();
    const hasKiller = r.readU8() !== 0;
    return { type: "EntityDied", entityId, killerId: hasKiller ? r.readUuid() : undefined };
  },
  relevance: known<EntityDiedEvent>("entityId"),
  fromTileEvent: {
    event: TileEvents.EntityDied,
    translate(p: EntityDiedPayload): EntityDiedEvent {
      return { type: "EntityDied", entityId: p.entityId, killerId: p.killerId };
    },
  },
};

const craftingCompleted: EventDescriptor<CraftingCompletedEvent> = {
  id: EventType.CraftingCompleted,
  encode(w, ev) {
    w.writeUuid(ev.crafterId);
    w.writeStr(ev.recipeId);
  },
  decode(r) {
    return { type: "CraftingCompleted", crafterId: r.readUuid(), recipeId: r.readStr() };
  },
  relevance: player<CraftingCompletedEvent>("crafterId"),
  fromTileEvent: {
    event: TileEvents.CraftingCompleted,
    translate(p: CraftingCompletedPayload): CraftingCompletedEvent {
      return { type: "CraftingCompleted", crafterId: p.crafterId, recipeId: p.recipeId };
    },
  },
};

const buildingCompleted: EventDescriptor<BuildingCompletedEvent> = {
  id: EventType.BuildingCompleted,
  encode(w, ev) {
    w.writeUuid(ev.builderId);
    w.writeUuid(ev.blueprintId);
    w.writeStr(ev.structureType);
  },
  decode(r) {
    return {
      type: "BuildingCompleted",
      builderId: r.readUuid(),
      blueprintId: r.readUuid(),
      structureType: r.readStr(),
    };
  },
  relevance: anyOf<BuildingCompletedEvent>(
    { kind: "player", field: "builderId" },
    { kind: "known", field: "blueprintId" },
  ),
  fromTileEvent: {
    event: TileEvents.BuildingCompleted,
    translate(p: BuildingCompletedPayload): BuildingCompletedEvent {
      return {
        type: "BuildingCompleted",
        builderId: p.builderId,
        blueprintId: p.blueprintId,
        structureType: p.structureType,
      };
    },
  },
};

const buildingMaterialsConsumed: EventDescriptor<BuildingMaterialsConsumedEvent> = {
  id: EventType.BuildingMaterialsConsumed,
  encode(w, ev) {
    w.writeUuid(ev.builderId);
    w.writeStr(ev.structureType);
    w.writeU16(ev.consumed.length);
    for (const m of ev.consumed) { w.writeStr(m.itemType); w.writeU16(m.quantity); }
  },
  decode(r) {
    const builderId = r.readUuid();
    const structureType = r.readStr();
    const count = r.readU16();
    const consumed: BuildingMaterial[] = [];
    for (let i = 0; i < count; i++) consumed.push({ itemType: r.readStr(), quantity: r.readU16() });
    return { type: "BuildingMaterialsConsumed", builderId, structureType, consumed };
  },
  relevance: player<BuildingMaterialsConsumedEvent>("builderId"),
  fromTileEvent: {
    event: TileEvents.BuildingMaterialsConsumed,
    translate(p: BuildingMaterialsConsumedPayload): BuildingMaterialsConsumedEvent {
      return {
        type: "BuildingMaterialsConsumed",
        builderId: p.builderId,
        structureType: p.structureType,
        consumed: p.consumed,
      };
    },
  },
};

const buildingMissingMaterials: EventDescriptor<BuildingMissingMaterialsEvent> = {
  id: EventType.BuildingMissingMaterials,
  encode(w, ev) {
    w.writeUuid(ev.builderId);
    w.writeStr(ev.structureType);
    w.writeU16(ev.missing.length);
    for (const m of ev.missing) { w.writeStr(m.itemType); w.writeU16(m.quantity); }
  },
  decode(r) {
    const builderId = r.readUuid();
    const structureType = r.readStr();
    const count = r.readU16();
    const missing: BuildingMaterial[] = [];
    for (let i = 0; i < count; i++) missing.push({ itemType: r.readStr(), quantity: r.readU16() });
    return { type: "BuildingMissingMaterials", builderId, structureType, missing };
  },
  relevance: player<BuildingMissingMaterialsEvent>("builderId"),
  fromTileEvent: {
    event: TileEvents.BuildingMissingMaterials,
    translate(p: BuildingMissingMaterialsPayload): BuildingMissingMaterialsEvent {
      return {
        type: "BuildingMissingMaterials",
        builderId: p.builderId,
        structureType: p.structureType,
        missing: p.missing,
      };
    },
  },
};

const hungerCritical: EventDescriptor<HungerCriticalEvent> = {
  id: EventType.HungerCritical,
  encode(w, ev) {
    w.writeUuid(ev.entityId);
  },
  decode(r) {
    return { type: "HungerCritical", entityId: r.readUuid() };
  },
  relevance: player<HungerCriticalEvent>("entityId"),
  fromTileEvent: {
    event: TileEvents.HungerCritical,
    translate(p: HungerCriticalPayload): HungerCriticalEvent {
      return { type: "HungerCritical", entityId: p.entityId };
    },
  },
};

const healed: EventDescriptor<HealedEvent> = {
  id: EventType.Healed,
  encode(w, ev) {
    w.writeUuid(ev.entityId);
    w.writeF32(ev.amount);
  },
  decode(r) {
    return { type: "Healed", entityId: r.readUuid(), amount: r.readF32() };
  },
  relevance: known<HealedEvent>("entityId"),
  fromTileEvent: {
    event: TileEvents.Healed,
    translate(p: HealedPayload): HealedEvent {
      return { type: "Healed", entityId: p.entityId, amount: p.amount };
    },
  },
};

const gateApproached: EventDescriptor<GateApproachedEvent> = {
  id: EventType.GateApproached,
  encode(w, ev) {
    w.writeUuid(ev.entityId);
    w.writeStr(ev.gateId);
    w.writeStr(ev.destinationTileId);
  },
  decode(r) {
    return {
      type: "GateApproached",
      entityId: r.readUuid(),
      gateId: r.readStr(),
      destinationTileId: r.readStr(),
    };
  },
  relevance: player<GateApproachedEvent>("entityId"),
  fromTileEvent: {
    event: TileEvents.GateApproached,
    translate(p: GateApproachedPayload): GateApproachedEvent {
      return {
        type: "GateApproached",
        entityId: p.entityId,
        gateId: p.gateId,
        destinationTileId: p.destinationTileId,
      };
    },
  },
};

const gateCrossing: EventDescriptor<GateCrossingEvent> = {
  id: EventType.GateCrossing,
  encode(w, ev) {
    w.writeUuid(ev.entityId);
    w.writeStr(ev.destinationTileAddress);
    w.writeStr(ev.destinationTileCertHashHex);
  },
  decode(r) {
    return {
      type: "GateCrossing",
      entityId: r.readUuid(),
      destinationTileAddress: r.readStr(),
      destinationTileCertHashHex: r.readStr(),
    };
  },
  relevance: player<GateCrossingEvent>("entityId"),
  // No bus binding: sent out-of-band via sendGateCrossing (see header).
};

const nodeDepleted: EventDescriptor<NodeDepletedEvent> = {
  id: EventType.NodeDepleted,
  encode(w, ev) {
    w.writeUuid(ev.nodeId);
    w.writeStr(ev.nodeTypeId);
    w.writeUuid(ev.harvesterId);
  },
  decode(r) {
    return {
      type: "NodeDepleted",
      nodeId: r.readUuid(),
      nodeTypeId: r.readStr(),
      harvesterId: r.readUuid(),
    };
  },
  relevance: anyOf<NodeDepletedEvent>(
    { kind: "known", field: "nodeId" },
    { kind: "known", field: "harvesterId" },
  ),
  fromTileEvent: {
    event: TileEvents.NodeDepleted,
    translate(p: NodeDepletedPayload): NodeDepletedEvent {
      return {
        type: "NodeDepleted",
        nodeId: p.nodeId,
        nodeTypeId: p.nodeTypeId,
        harvesterId: p.harvesterId,
      };
    },
  },
};

const dayPhaseChanged: EventDescriptor<DayPhaseChangedEvent> = {
  id: EventType.DayPhaseChanged,
  encode(w, ev) {
    w.writeStr(ev.phase);
    w.writeF32(ev.timeOfDay);
  },
  decode(r) {
    return { type: "DayPhaseChanged", phase: r.readStr(), timeOfDay: r.readF32() };
  },
  relevance: ALWAYS,
  fromTileEvent: {
    event: TileEvents.DayPhaseChanged,
    translate(p: DayPhaseChangedPayload): DayPhaseChangedEvent {
      return { type: "DayPhaseChanged", phase: p.phase, timeOfDay: p.timeOfDay };
    },
  },
};

const tradeCompleted: EventDescriptor<TradeCompletedEvent> = {
  id: EventType.TradeCompleted,
  encode(w, ev) {
    w.writeUuid(ev.buyerId);
    w.writeUuid(ev.traderId);
    w.writeStr(ev.itemType);
    w.writeU16(ev.quantity);
    w.writeI32(ev.coinDelta);
  },
  decode(r) {
    return {
      type: "TradeCompleted",
      buyerId: r.readUuid(),
      traderId: r.readUuid(),
      itemType: r.readStr(),
      quantity: r.readU16(),
      coinDelta: r.readI32(),
    };
  },
  relevance: anyOf<TradeCompletedEvent>(
    { kind: "player", field: "buyerId" },
    { kind: "known", field: "traderId" },
  ),
  fromTileEvent: {
    event: TileEvents.TradeCompleted,
    translate(p: TradeCompletedPayload): TradeCompletedEvent {
      return {
        type: "TradeCompleted",
        buyerId: p.buyerId,
        traderId: p.traderId,
        itemType: p.itemType,
        quantity: p.quantity,
        coinDelta: p.coinDelta,
      };
    },
  },
};

const loreExternalised: EventDescriptor<LoreExternalisedEvent> = {
  id: EventType.LoreExternalised,
  encode(w, ev) {
    w.writeUuid(ev.entityId);
    w.writeStr(ev.fragmentId);
  },
  decode(r) {
    return { type: "LoreExternalised", entityId: r.readUuid(), fragmentId: r.readStr() };
  },
  relevance: player<LoreExternalisedEvent>("entityId"),
  fromTileEvent: {
    event: TileEvents.LoreExternalised,
    translate(p: LoreExternalisedPayload): LoreExternalisedEvent {
      return { type: "LoreExternalised", entityId: p.entityId, fragmentId: p.fragmentId };
    },
  },
};

const loreInternalised: EventDescriptor<LoreInternalisedEvent> = {
  id: EventType.LoreInternalised,
  encode(w, ev) {
    w.writeUuid(ev.entityId);
    w.writeStr(ev.fragmentId);
  },
  decode(r) {
    return { type: "LoreInternalised", entityId: r.readUuid(), fragmentId: r.readStr() };
  },
  relevance: player<LoreInternalisedEvent>("entityId"),
  fromTileEvent: {
    event: TileEvents.LoreInternalised,
    translate(p: LoreInternalisedPayload): LoreInternalisedEvent {
      return { type: "LoreInternalised", entityId: p.entityId, fragmentId: p.fragmentId };
    },
  },
};

const hitSpark: EventDescriptor<HitSparkEvent> = {
  id: EventType.HitSpark,
  encode(w, ev) {
    w.writeF32(ev.x);
    w.writeF32(ev.y);
    w.writeF32(ev.z);
    w.writeStr(ev.attackerPart);
    w.writeStr(ev.victimPart);
  },
  decode(r) {
    return {
      type: "HitSpark",
      x: r.readF32(),
      y: r.readF32(),
      z: r.readF32(),
      attackerPart: r.readStr(),
      victimPart: r.readStr(),
    };
  },
  relevance: ALWAYS,
  fromTileEvent: {
    event: TileEvents.HitSpark,
    translate(p: HitSparkPayload): HitSparkEvent {
      return {
        type: "HitSpark",
        x: p.x,
        y: p.y,
        z: p.z,
        attackerPart: p.attackerPart,
        victimPart: p.victimPart,
      };
    },
  },
};

const zoneEntered: EventDescriptor<ZoneEnteredEvent> = {
  id: EventType.ZoneEntered,
  encode(w, ev) {
    w.writeUuid(ev.playerId);
    w.writeU16(ev.zoneId);
    w.writeStr(ev.zoneName);
    w.writeStr(ev.topologyRole);
    w.writeU8(ev.traversal === "wilderness" ? 1 : 0);
  },
  decode(r) {
    const playerId     = r.readUuid();
    const zoneId       = r.readU16();
    const zoneName     = r.readStr();
    const topologyRole = r.readStr();
    const traversal    = r.readU8() === 1 ? "wilderness" as const : "path" as const;
    return { type: "ZoneEntered", playerId, zoneId, zoneName, topologyRole, traversal };
  },
  // Each client only cares about its own player's zone transitions (other
  // players' zone changes don't drive its HUD). Server still emits to AoI so
  // spectator UIs / observability tools can listen.
  relevance: player<ZoneEnteredEvent>("playerId"),
  // No bus binding: pushed directly via EventRouter.push() (see header).
};

const enclosureChanged: EventDescriptor<EnclosureChangedEvent> = {
  id: EventType.EnclosureChanged,
  encode(w, ev) {
    w.writeU16(ev.cells.length);
    for (const c of ev.cells) { w.writeU16(c.x); w.writeU16(c.y); }
  },
  decode(r) {
    const count = r.readU16();
    const cells: { x: number; y: number }[] = [];
    for (let i = 0; i < count; i++) cells.push({ x: r.readU16(), y: r.readU16() });
    return { type: "EnclosureChanged", cells };
  },
  // Tile-wide broadcast, like DayPhaseChanged — every connected client
  // rebuilds its roof geometry off the same cell set.
  relevance: ALWAYS,
  fromTileEvent: {
    event: TileEvents.EnclosureChanged,
    translate(p: EnclosureChangedPayload): EnclosureChangedEvent {
      return { type: "EnclosureChanged", cells: p.cells };
    },
  },
};

// ---- the registry ----

/**
 * Keyed by the GameEvent discriminant: a new union member in messages.ts
 * without an entry here fails to compile.
 */
export const EVENT_DESCRIPTORS: {
  readonly [K in GameEvent["type"]]: EventDescriptor<Extract<GameEvent, { type: K }>>;
} = {
  DamageDealt: damageDealt,
  EntityDied: entityDied,
  CraftingCompleted: craftingCompleted,
  BuildingCompleted: buildingCompleted,
  BuildingMaterialsConsumed: buildingMaterialsConsumed,
  BuildingMissingMaterials: buildingMissingMaterials,
  HungerCritical: hungerCritical,
  GateApproached: gateApproached,
  GateCrossing: gateCrossing,
  NodeDepleted: nodeDepleted,
  DayPhaseChanged: dayPhaseChanged,
  TradeCompleted: tradeCompleted,
  LoreExternalised: loreExternalised,
  LoreInternalised: loreInternalised,
  ZoneEntered: zoneEntered,
  Healed: healed,
  EnclosureChanged: enclosureChanged,
  HitSpark: hitSpark,
};

// One controlled widening: dispatch always looks up by ev.type / wire id, so
// the descriptor returned structurally matches the runtime value even though
// the generic parameter is narrower per-key above. Keep this the ONLY such
// cast — a consumer needing another one means the widening belongs here.
const DESCRIPTOR_BY_TYPE = EVENT_DESCRIPTORS as Record<string, EventDescriptor<GameEvent>>;

const EVENT_DESCRIPTOR_BY_ID: ReadonlyMap<number, EventDescriptor<GameEvent>> = new Map(
  Object.values(DESCRIPTOR_BY_TYPE).map((d) => [d.id, d]),
);

// Fail fast at module load if two descriptors claim the same wire id (the
// same duplicate-guard spirit as the T-349 component-codec boot check).
if (EVENT_DESCRIPTOR_BY_ID.size !== Object.keys(EVENT_DESCRIPTORS).length) {
  throw new Error("[event_registry] duplicate EventType wire id across descriptors");
}

// ---- generic dispatch ----

/** Encode one event: leading u8 wire id, then the descriptor's field layout. */
export function encodeEvent(w: WireWriter, ev: GameEvent): void {
  const d = DESCRIPTOR_BY_TYPE[ev.type];
  w.writeU8(d.id);
  d.encode(w, ev);
}

export function decodeEvent(r: WireReader): GameEvent {
  const id = r.readU8();
  const d = EVENT_DESCRIPTOR_BY_ID.get(id);
  if (!d) throw new Error(`Unknown event type ID: ${id}`);
  return d.decode(r);
}

/** Is this event visible to the session viewing as `playerId` with `knownEntities` in AoI this tick? */
export function isEventRelevant(
  ev: GameEvent,
  playerId: EntityId,
  knownEntities: ReadonlySet<EntityId>,
): boolean {
  const rel = DESCRIPTOR_BY_TYPE[ev.type].relevance;
  if (rel.kind === "always") return true;
  return rel.clauses.some((c) => {
    const v = (ev as unknown as Record<string, unknown>)[c.field as string] as EntityId;
    return c.kind === "player" ? v === playerId : knownEntities.has(v);
  });
}

/**
 * Subscribe every bus-sourced event's translation in one pass: each incoming
 * TileEvents payload becomes a GameEvent via the descriptor's `translate` and
 * is handed to `push`. Events without a `fromTileEvent` binding are skipped.
 */
export function subscribeAllEvents(bus: EventBus, push: (ev: GameEvent) => void): void {
  for (const d of Object.values(DESCRIPTOR_BY_TYPE)) {
    if (!d.fromTileEvent) continue;
    const { event, translate } = d.fromTileEvent;
    bus.subscribe(event, (payload: unknown) => push(translate(payload)));
  }
}
