/**
 * Account domain types shared across the auth/storage layer.
 *
 * The user record is JSON-encoded because its shape evolves (settings grow,
 * new fields get added). The heritage payload is binary because it has a
 * stable schema and a codec already exists in @voxim/codecs.
 */

/**
 * A user account record — persisted as `users/{userId}.json`.
 *
 * Heritage is NOT stored here; it lives in a sibling binary file. No field
 * duplicates state between the two, so cross-file atomicity is a non-issue:
 * a crash between JSON and binary writes loses at most one of two
 * independent state components.
 */
export interface UserRecord {
  userId: string;
  loginName: string;
  /**
   * Hashed password string, including the KDF parameters and salt. Opaque to
   * callers; parsed by auth.ts.
   */
  passwordHash: string;
  createdAt: number;
  lastLoginAt: number;

  /**
   * Which dynasty this user's current character belongs to. The dynasty itself
   * (generation, traits) lives in the binary heritage file. This is just the
   * pointer — one user runs one active dynasty at a time.
   */
  activeDynastyId: string;

  /** Last tile this user's character was seen on. Drives routing on login. */
  lastTileId: string | null;

  /**
   * Respawn anchor set when the user places a Hearth. On login after death,
   * the gateway routes to `tileId` and the tile spawns the heir at
   * `position`. Null when no hearth has been placed yet (first character).
   */
  hearthAnchor: HearthAnchor | null;

  /**
   * Free-form UI + gameplay preferences. Deliberately untyped here so the
   * store doesn't need to evolve when clients add settings.
   */
  settings: Record<string, unknown>;
}

/** Where a dynasty's heir spawns after a death. */
export interface HearthAnchor {
  tileId: string;
  position: { x: number; y: number; z: number };
}

/** Minimal projection used by the handshake: what the gateway needs to route. */
export interface SessionInfo {
  userId: string;
  activeDynastyId: string;
  lastTileId: string | null;
  hearthAnchor: HearthAnchor | null;
}
