/**
 * Public account-domain types used outside the storage layer.
 *
 * The persisted shapes live in `@voxim/db` (UserRow, HeritageRow, etc.).
 * This module exports only the projections that flow over the wire to
 * tile-servers and clients.
 */

import type { HearthAnchor } from "@voxim/db";
export type { HearthAnchor };

/** Minimal projection used by the handshake: what the gateway needs to route. */
export interface SessionInfo {
  userId: string;
  activeDynastyId: string;
  lastTileId: string | null;
  hearthAnchor: HearthAnchor | null;
}
