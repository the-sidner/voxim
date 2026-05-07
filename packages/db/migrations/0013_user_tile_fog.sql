-- T-161 · Per-player explored fog of war, persisted across sessions.
--
-- One row per (user, tile).  `bitmap` is the raw bit-packed seenEver buffer
-- (8 KB at FOG_GRID_BYTES).  Tile-server reads on join and writes on
-- disconnect; the buffer is opaque to Postgres.
--
-- world_id is intentionally NOT in the key: rebakes regenerate terrain but
-- the player's exploration shape is still meaningful (the new world might
-- look similar; if not, stale fog just slowly aligns as the player walks).
-- Drop fog manually via DELETE if a rebake invalidates it badly.

CREATE TABLE user_tile_fog (
  user_id     uuid not null references users(user_id) ON DELETE CASCADE,
  tile_id     text not null,
  bitmap      bytea not null,
  updated_at  timestamptz not null default now(),
  primary key (user_id, tile_id)
);
