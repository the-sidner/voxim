/// <reference path="./types/webtransport.d.ts" />
/**
 * Handle one client's gateway handshake session.
 *
 * Lifecycle:
 *   1. Session opens (client connected to gateway WebTransport)
 *   2. Client opens a bidirectional stream
 *   3. Client sends GatewayConnectRequest with a session token
 *   4. Gateway validates the token via SessionStore, looks up the user's
 *      activeDynastyId + lastTileId, and picks a tile to route them to
 *   5. Gateway responds with GatewayTileResponse (or GatewayErrorResponse)
 *   6. Stream closes — client connects directly to the tile server, passing
 *      the same session token through to the tile on the join handshake.
 *
 * The routing key is userId (not a fresh per-session ID) — one user always
 * owns the same entity across reconnects. Tile servers can use userId as
 * the EntityId for the player entity without any translation layer.
 */
import type { GatewayConnectRequest, GatewayResponse } from "@voxim/protocol";
import type { TileDirectory } from "./tile_directory.ts";
import type { AccountStore } from "./account/store.ts";
import type { SessionStore } from "./account/session_store.ts";
import { makeFrameReader, encodeJson } from "./codec.ts";

export interface GatewaySessionDeps {
  directory: TileDirectory;
  accountStore: AccountStore;
  sessions: SessionStore;
}

export async function handleGatewaySession(
  session: WebTransportSession,
  deps: GatewaySessionDeps,
): Promise<void> {
  await session.ready;

  // Wait for the client to open a bidirectional stream for the handshake
  const streamReader = session.incomingBidirectionalStreams.getReader();
  const { value: stream, done } = await streamReader.read();
  streamReader.releaseLock();
  if (done || !stream) {
    session.close({ reason: "no handshake stream" });
    return;
  }

  const reader = stream.readable.getReader();
  const writer = stream.writable.getWriter();

  try {
    const msg = await makeFrameReader(reader).readJson();
    if (!msg || (msg as { type?: string }).type !== "connect") {
      await sendResponse(writer, {
        type: "error",
        code: "auth_failed",
        message: "expected connect request",
      });
      return;
    }

    const req = msg as GatewayConnectRequest;

    // Validate session token. Missing, unknown, or expired tokens all
    // collapse to "unauthenticated" — clients treat this as a signal to
    // clear the locally-stored token and re-show the login screen.
    if (!req.token) {
      await sendResponse(writer, {
        type: "error",
        code: "unauthenticated",
        message: "session token required",
      });
      return;
    }
    const userId = await deps.sessions.validate(req.token);
    if (!userId) {
      await sendResponse(writer, {
        type: "error",
        code: "unauthenticated",
        message: "invalid or expired session",
      });
      return;
    }

    // The user's record tells us where they were last seen so we can route
    // them back to the same tile after reconnect.
    const user = await deps.accountStore.getUserById(userId);
    if (!user) {
      await sendResponse(writer, {
        type: "error",
        code: "unauthenticated",
        message: "user record missing",
      });
      return;
    }

    // Prefer the user's last tile when it is still registered; otherwise
    // fall back to the directory's default selection.
    const preferred = user.lastTileId ? deps.directory.get(user.lastTileId) : null;
    const tile = preferred ?? deps.directory.tileForPlayer(userId);
    if (!tile) {
      await sendResponse(writer, {
        type: "error",
        code: "not_found",
        message: "no tile server available",
      });
      return;
    }

    deps.directory.setPlayerTile(userId, tile.tileId);

    const response: GatewayResponse = {
      type: "tile",
      tileId: tile.tileId,
      tileAddress: tile.address,
      playerId: userId,
    };
    await sendResponse(writer, response);

    console.log(`[Gateway] user ${userId.slice(0, 8)} → tile ${tile.tileId} (${tile.address})`);
  } finally {
    reader.releaseLock();
    writer.releaseLock();
  }
}

async function sendResponse(
  writer: WritableStreamDefaultWriter<Uint8Array>,
  msg: GatewayResponse,
): Promise<void> {
  await writer.write(encodeJson(msg));
  await writer.close();
}
