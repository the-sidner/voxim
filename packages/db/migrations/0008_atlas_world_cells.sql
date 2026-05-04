-- Atlas worldmap layer (T-atlas-1).
--
-- One row per (world_id, cell_x, cell_y). Holds the biome parameter bundle
-- and per-edge gate specs that the tilemap layer consumes deterministically.
--
-- Independent from the legacy `world_map` table (which stores the coordinator's
-- WorldMapPayload as one bytea blob). Atlas owns this table exclusively; the
-- coordinator's table will be retired in a later phase once tile-server reads
-- tile_init from atlas instead.

CREATE TABLE atlas_world_cells (
  world_id      text   not null default 'default',
  cell_x        int    not null,
  cell_y        int    not null,
  seed          bigint not null,
  biome         jsonb  not null,
  gates         jsonb  not null,
  generated_at  timestamptz not null default now(),
  PRIMARY KEY (world_id, cell_x, cell_y)
);

-- Fast "give me the whole worldmap" scans plus seed-mismatch detection.
CREATE INDEX atlas_world_cells_world_seed_idx
  ON atlas_world_cells (world_id, seed);
