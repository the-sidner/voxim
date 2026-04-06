/// <reference path="./types/webtransport.d.ts" />
/**
 * Handle one client's gateway handshake session.
 *
 * Lifecycle:
 *   1. Session opens (client connected to gateway WebTransport)
 *   2. Client opens a bidirectional stream
 *   3. Client sends GatewayConnectRequest
 *   4. Gateway responds with GatewayTileResponse (or GatewayErrorResponse)
 *   5. Stream closes — client connects directly to the tile server
 */
import type { GatewayConnectRequest, GatewayResponse } from "@voxim/protocol";
import type { TileDirectory } from "./tile_directory.ts";
import { TileDirectory as TD } from "./tile_directory.ts";
import { readMessage, encodeJson } from "./codec.ts";

export async function handleGatewaySession(
  session: WebTransportSession,
  directory: TileDirectory,
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
    const msg = await readMessage(reader);
    if (!msg || (msg as { type?: string }).type !== "connect") {
      await sendResponse(writer, {
        type: "error",
        code: "auth_failed",
        message: "expected connect request",
      });
      return;
    }

    const req = msg as GatewayConnectRequest;

    // Auth stub — always accept
    const playerId = req.playerId ?? TD.newPlayerId();

    const tile = directory.tileForPlayer(playerId);
    if (!tile) {
      await sendResponse(writer, {
        type: "error",
        code: "not_found",
        message: "no tile server available",
      });
      return;
    }

    directory.setPlayerTile(playerId, tile.tileId);

    const response: GatewayResponse = {
      type: "tile",
      tileId: tile.tileId,
      tileAddress: tile.address,
      playerId,
    };
    await sendResponse(writer, response);

    console.log(`[Gateway] player ${playerId} → tile ${tile.tileId} (${tile.address})`);
  } finally {
    reader.releaseLock();
    writer.releaseLock();
  }
}

async function sendResponse(
  writer: WritableStreamDefaultWriter<Uint8Array>,
  msg: unknown,
): Promise<void> {
  await writer.write(encodeJson(msg));
  await writer.close();
}
