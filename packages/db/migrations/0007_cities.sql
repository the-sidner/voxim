CREATE TABLE cities (
  city_id     uuid primary key,
  name        text not null,
  tile_id     text not null,
  state       jsonb not null,
  event_log   jsonb not null default '[]'::jsonb,
  updated_at  timestamptz not null default now()
);

CREATE INDEX cities_tile_id_idx ON cities (tile_id);
