-- Atlas tilemap layer.
--
-- One row per (world_id, tile_id) holding the pre-computed initial state
-- of one tile: openMask, room labelling, rooms, portals, and (later)
-- boundary regions + features. Tile-server reads this row at boot and
-- applies player edits on top.
--
-- Payload is jsonb for now (TileInitWire shape — base64-encoded typed
-- arrays + JSON-friendly metadata). When openMask + heightmap + materials
-- balloon the size, switch to bytea with a versioned binary header.

CREATE TABLE atlas_tile_init (
  world_id      text   not null default 'default',
  tile_id       text   not null,
  cell_x        int    not null,
  cell_y        int    not null,
  seed          bigint not null,
  payload       jsonb  not null,
  generated_at  timestamptz not null default now(),
  PRIMARY KEY (world_id, tile_id)
);

CREATE INDEX atlas_tile_init_cell_idx
  ON atlas_tile_init (world_id, cell_x, cell_y);
