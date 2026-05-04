-- Phase 8A: worlds-as-data.
--
-- Each atlas bake INSERTs a new row into `worlds` with a fresh uuid.
-- The latest row by baked_at is the active world; services restart and
-- pick it up. Prior rows linger as a record (cheap; can be purged later
-- via the inspector).
--
-- This migration is destructive: existing rows in the per-world tables
-- referenced "default" as a text world_id. The new shape requires a uuid
-- FK on worlds(id), so old data has nowhere to point. compose-reset is
-- expected for any environment that's been running prior atlas builds.

CREATE TABLE worlds (
  id          uuid    PRIMARY KEY,
  name        text    NOT NULL,
  seed        bigint  NOT NULL,
  width       int     NOT NULL,
  height      int     NOT NULL,
  version     int     NOT NULL DEFAULT 1,
  baked_at    timestamptz NOT NULL DEFAULT now()
);

-- Latest-active lookup is the hot read path on every service boot.
CREATE INDEX worlds_baked_at_desc_idx ON worlds (baked_at DESC);

-- Per-world tables: drop and recreate with FK on worlds.id. Cascade so
-- deleting a world removes its cells, tiles, and player saves together.
DROP TABLE IF EXISTS atlas_world_cells;
DROP TABLE IF EXISTS atlas_tile_init;
DROP TABLE IF EXISTS world_map;     -- legacy coordinator table; nothing reads it now
DROP TABLE IF EXISTS tile_saves;

CREATE TABLE atlas_world_cells (
  world_id     uuid   NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  cell_x       int    NOT NULL,
  cell_y       int    NOT NULL,
  seed         bigint NOT NULL,
  biome        jsonb  NOT NULL,
  gates        jsonb  NOT NULL,
  rivers       jsonb  NOT NULL DEFAULT '[]'::jsonb,
  generated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (world_id, cell_x, cell_y)
);

CREATE INDEX atlas_world_cells_world_idx ON atlas_world_cells (world_id);

CREATE TABLE atlas_tile_init (
  world_id     uuid   NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  tile_id      text   NOT NULL,
  cell_x       int    NOT NULL,
  cell_y       int    NOT NULL,
  seed         bigint NOT NULL,
  payload      jsonb  NOT NULL,
  generated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (world_id, tile_id)
);

CREATE INDEX atlas_tile_init_world_cell_idx ON atlas_tile_init (world_id, cell_x, cell_y);

-- tile_saves now scoped per world: switching worlds (rebake) starts that
-- world's tiles fresh, no risk of replaying a save against incompatible
-- terrain.
CREATE TABLE tile_saves (
  world_id    uuid   NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  tile_id     text   NOT NULL,
  payload     bytea  NOT NULL,
  saved_at    timestamptz NOT NULL DEFAULT now(),
  size_bytes  int    NOT NULL,
  PRIMARY KEY (world_id, tile_id)
);
