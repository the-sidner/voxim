/**
 * HandoffCoordinator — the cross-tile gate/zone side of TileServer (T-352).
 *
 * Owns the per-player handoff state (in-flight fetches, last-seen zone,
 * hearth-anchor cache) plus the tick-time checks that feed
 * it: gate-proximity polling (publishes GateApproached), zone-transition
 * tracking (pushes ZoneEntered), the handoff fetch itself, and the final
 * GateCrossing send before the session closes.
 *
 * Constructed in TileServer.start() after atlas terrain load (so zoneBuffer
 * and zoneById are final) but before the gateway self-registration block —
 * gatewayUrl / gatewayLink / events are therefore read through lazy getters,
 * the same trick UnlockStairResolver uses for zoneBuffer. Nothing here runs
 * before the tick loop starts, by which point every getter resolves.
 */
import type { EntityId, EventBus, World } from "@voxim/engine";
import { TileEvents, SERVICE_SECRET_HEADER, binaryStateMessageCodec, encodeFrame } from "@voxim/protocol";
import type { BinaryStateMessage } from "@voxim/protocol";
import { TILE_SIZE } from "@voxim/world";
import { GateLink } from "./components/gate.ts";
import { mirrorPosition } from "./gate.ts";
import { Position, InputState } from "./components/game.ts";
import { Heritage } from "./components/heritage.ts";
import { serializePlayer } from "./handoff.ts";
import type { ClientSession } from "./session.ts";
import type { TickLoop } from "./tick_loop.ts";
import type { EventRouter } from "./event_router.ts";
import type { GatewayLink } from "./gateway_link.ts";
import type { HearthAnchor } from "./account_client.ts";

/** Zone metadata indexed by `zoneBuffer` ids (T-211). */
export interface ZoneMeta {
  id: number;
  name: string;
  topologyRole: string;
  traversal: "path" | "wilderness";
}

export interface HandoffCoordinatorDeps {
  world: World;
  eventBus: EventBus;
  sessions: Map<EntityId, ClientSession>;
  tickLoop: TickLoop;
  tileId: string;
  /** Shared secret presented to the gateway's control-plane endpoints (T-258). */
  serviceSecret: string;
  /**
   * Per-voxel zone id at TILE_SIZE² resolution (T-211), from atlas
   * `upsampleTile()`. Final by construction time (post-atlas-load).
   */
  zoneBuffer: Uint16Array | null;
  zoneById: Map<number, ZoneMeta>;
  /** Lazy — assigned by the gateway self-registration block later in start(). */
  getGatewayUrl: () => string | null;
  /** Lazy — assigned by the gateway-WT block later in start(). */
  getGatewayLink: () => GatewayLink | null;
  /** Lazy — the EventRouter is constructed immediately after this coordinator. */
  getEvents: () => EventRouter;
  /**
   * The single "player leaves this tile" path (TileServer.teardownSession,
   * T-354/T-361). The handoff success continuation invokes it with
   * `handedOff` so the entity destroy, per-player cache clears, and the
   * source-tile fog save all run through the one shared shape — while the
   * death/location bookkeeping is skipped (the destination tile owns both).
   */
  teardownSession: (playerId: EntityId, opts: { handedOff: boolean }) => Promise<void>;
}

/**
 * Timeout on the gateway /handoff POST. A gateway that accepts the socket
 * but never answers would otherwise leave `handingOff` set forever — the
 * player frozen and the dead-session sweep skipping them indefinitely.
 */
const HANDOFF_FETCH_TIMEOUT_MS = 10_000;

export class HandoffCoordinator {
  /**
   * Players for whom a handoff fetch is in flight. Prevents a second
   * GateApproached event (or rapidly-repeated collisions) from initiating a
   * duplicate handoff while the first is still pending its gateway round-trip.
   */
  private readonly handingOff = new Set<EntityId>();
  /** Last zone id reported per player, to detect transitions. */
  private readonly playerLastZone = new Map<EntityId, number>();
  /**
   * Hearth anchor per connected player (T-079) — cached at join so a respawn
   * (no join msg) can spawn the heir at the family hearth, or detect that the
   * hearth was destroyed and spawn the heir displaced + weakened.
   */
  private readonly playerHearthAnchors = new Map<EntityId, HearthAnchor | null>();

  constructor(private readonly deps: HandoffCoordinatorDeps) {}

  /** True while a handoff fetch owns this player's entity (T-256). */
  isHandingOff(playerId: EntityId): boolean {
    return this.handingOff.has(playerId);
  }

  /** Drop the player's last-seen zone on disconnect. */
  clearZone(playerId: EntityId): void {
    this.playerLastZone.delete(playerId);
  }

  getHearthAnchor(playerId: EntityId): HearthAnchor | null {
    return this.playerHearthAnchors.get(playerId) ?? null;
  }

  setHearthAnchor(playerId: EntityId, anchor: HearthAnchor | null): void {
    this.playerHearthAnchors.set(playerId, anchor);
  }

  clearHearthAnchor(playerId: EntityId): void {
    this.playerHearthAnchors.delete(playerId);
  }

  /**
   * Per-tick proximity check: any player whose Position is within a
   * GateLink's radius gets a GateApproached event published. The
   * EventRouter forwards to initiateHandoff. The handingOff guard +
   * destination tile's handoffId dedup prevent re-firing while a
   * handoff is in flight.
   */
  checkGateProximity(): void {
    if (!this.deps.getGatewayUrl() || this.deps.sessions.size === 0) return;
    const gates = this.deps.world.query(Position, GateLink);
    if (gates.length === 0) return;

    for (const playerId of this.deps.sessions.keys()) {
      if (this.handingOff.has(playerId)) continue;
      const pos = this.deps.world.get(playerId, Position);
      if (!pos) continue;
      for (const { entityId: gateId, position: gp, gateLink } of gates) {
        const dx = pos.x - gp.x;
        const dy = pos.y - gp.y;
        const r = gateLink.radius;
        if (dx * dx + dy * dy <= r * r) {
          this.deps.eventBus.publish(TileEvents.GateApproached, {
            entityId: playerId,
            gateId,
            destinationTileId: gateLink.destinationTileId,
          });
          break; // one gate per player per tick is plenty
        }
      }
    }
  }

  /**
   * T-211 zone tracker. For each active session, look up the zone id
   * under the player's current voxel and fire a ZoneEntered game event
   * when the zone has changed. The map is cleared on disconnect.
   */
  checkZoneTransitions(): void {
    const buf = this.deps.zoneBuffer;
    if (!buf || this.deps.sessions.size === 0) return;
    const stride = TILE_SIZE;
    for (const playerId of this.deps.sessions.keys()) {
      const pos = this.deps.world.get(playerId, Position);
      if (!pos) continue;
      const vx = pos.x | 0;
      const vy = pos.y | 0;
      if (vx < 0 || vy < 0 || vx >= stride || vy >= stride) continue;
      const zoneId = buf[vy * stride + vx];
      const lastZone = this.playerLastZone.get(playerId) ?? -1;
      if (zoneId === lastZone) continue;
      this.playerLastZone.set(playerId, zoneId);

      // Sub-threshold / unzoned (0xFFFF for closed-pixel sentinel + water
      // blobs) — emit anyway with an empty name so the client can clear
      // its caption when the player walks across a no-zone band.
      const meta = this.deps.zoneById.get(zoneId);
      this.deps.getEvents().push({
        type: "ZoneEntered",
        playerId,
        zoneId,
        zoneName:     meta?.name ?? "",
        topologyRole: meta?.topologyRole ?? "",
        traversal:    meta?.traversal ?? "path",
      });
    }
  }

  /**
   * Fire-and-forget handoff to the destination tile via the gateway. The
   * re-entry guard prevents a second GateApproached event from starting a
   * parallel handoff while the first is still pending its round-trip; the
   * destination tile deduplicates retries on handoffId.
   *
   * Position is mirrored to the destination's matching edge so the player
   * lands just inside the new tile's gate (away from its own trigger
   * radius — otherwise we'd bounce straight back).
   */
  initiateHandoff(payload: { entityId: EntityId; gateId: string; destinationTileId: string }): void {
    if (!this.deps.getGatewayUrl() || this.handingOff.has(payload.entityId)) return;
    this.handingOff.add(payload.entityId);

    // Freeze the player for the round-trip (T-361). The payload below is a
    // snapshot: anything the player does after it is built diverges the live
    // world from what the destination restores — a dropped item would exist
    // on both tiles, a picked-up one would be destroyed at the source but be
    // absent from the payload. The tick loop's input drain discards this
    // player's datagrams/commands while `handingOff` is set; neutralising
    // InputState here stops the LAST drained frame (held movement / action
    // bits) from replaying every tick of the freeze.
    const input = this.deps.world.get(payload.entityId, InputState);
    if (input) {
      this.deps.world.write(payload.entityId, InputState, {
        ...input, movementX: 0, movementY: 0, actions: 0, chargeMs: 0,
      });
    }

    const gateLink = this.deps.world.get(payload.gateId as EntityId, GateLink);
    const dynastyId = this.deps.world.get(payload.entityId, Heritage)?.dynastyId ?? payload.entityId;
    const handoffId = crypto.randomUUID();
    const body = serializePlayer(this.deps.world, payload.entityId, dynastyId, payload.destinationTileId, handoffId);

    // Land the player just inside the destination's matching gate. Mirror both
    // the re-spawn coordinates and the Position overlay so spawnPrefab and the
    // overlay agree.
    if (gateLink) {
      const arrival = mirrorPosition(body.z, gateLink.edge, gateLink.offset);
      body.x = arrival.x; body.y = arrival.y; body.z = arrival.z;
      body.player.position = arrival;
    }

    // Inform the coordinator (T-139 channel). Best-effort — gateway may
    // be down or the link may not be open yet.
    this.deps.getGatewayLink()?.publish({
      type: "world_event",
      sourceTileId: this.deps.tileId,
      event: {
        kind: "gate_approached",
        playerId: payload.entityId,
        destinationTileId: payload.destinationTileId,
        edge: gateLink?.edge ?? "north",
      },
    }).catch(() => {/* best-effort */});

    fetch(`${this.deps.getGatewayUrl()}/handoff`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [SERVICE_SECRET_HEADER]: this.deps.serviceSecret,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(HANDOFF_FETCH_TIMEOUT_MS),
    }).then(async (r) => {
      if (r.ok) {
        const ack = await r.json().catch(() => null) as
          | { destinationTileAddress?: string; destinationTileCertHashHex?: string }
          | null;
        const session = this.deps.sessions.get(payload.entityId);
        // Send a final GateCrossing event on the reliable stream and AWAIT
        // the flush — sendStateRaw queues writes via a Promise chain, and
        // session.close() trips the queue's _closed guard if it runs before
        // the queued microtask. Without the await the GateCrossing bytes
        // never hit the wire and the client just sees the disconnect.
        if (session && ack?.destinationTileAddress) {
          this.sendGateCrossing(
            session,
            payload.entityId,
            ack.destinationTileAddress,
            ack.destinationTileCertHashHex ?? "",
          );
          await session.flush();
        }
        session?.close();
        // The one "player leaves this tile" path (T-361): its sync phase
        // deletes the sessions entry, clears every per-player cache, and
        // destroys the entity + carried items (the destination tile already
        // re-created them from `body`, so the source copies must not
        // linger); its async tail saves the source-tile fog. `handedOff`
        // skips the death/location bookkeeping — the destination owns both.
        // The sessions delete lands in the same microtask as close(), so
        // handleSession's stale-session guard supersede-returns and the
        // dead-session sweep never sees the entry.
        await this.deps.teardownSession(payload.entityId, { handedOff: true });
        console.log(
          `[TileServer] handoff complete: ${payload.entityId.slice(0, 8)} → ${payload.destinationTileId}`,
        );
      } else {
        console.error(`[TileServer] handoff failed for ${payload.entityId}: ${r.status}`);
      }
    }).catch((err: unknown) => {
      console.error("[TileServer] handoff fetch error:", err);
    }).finally(() => {
      this.handingOff.delete(payload.entityId);
    });
  }

  /**
   * Encode a one-off BinaryStateMessage carrying a single GateCrossing event
   * and push it to the player's reliable stream. Sequenced through the
   * session's write queue so it is delivered before the subsequent close().
   */
  private sendGateCrossing(
    session: ClientSession,
    entityId: EntityId,
    destinationTileAddress: string,
    destinationTileCertHashHex: string,
  ): void {
    const msg: BinaryStateMessage = {
      serverTick: this.deps.tickLoop.currentTick,
      ackInputSeq: this.deps.world.get(entityId, InputState)?.seq ?? 0,
      spawns: [],
      deltas: [],
      removals: [],
      destroys: [],
      events: [{
        type: "GateCrossing" as const,
        entityId,
        destinationTileAddress,
        destinationTileCertHashHex,
      }],
      fogSnapshot: null,
      fogReveals: new Uint16Array(0),
      onlineCount: this.deps.sessions.size,
    };
    const payload = binaryStateMessageCodec.encode(msg);
    session.sendStateRaw(encodeFrame(payload));
  }
}
