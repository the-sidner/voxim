CREATE TABLE tile_registry (
  tile_id            text primary key,
  address            text not null,
  admin_url          text not null,
  last_heartbeat_at  timestamptz not null default now()
);

CREATE INDEX tile_registry_last_heartbeat_idx ON tile_registry (last_heartbeat_at);
