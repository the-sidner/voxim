CREATE TABLE tile_saves (
  tile_id     text primary key,
  payload     bytea not null,
  saved_at    timestamptz not null default now(),
  size_bytes  integer not null
);
