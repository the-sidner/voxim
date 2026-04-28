CREATE TABLE world_map (
  world_id      text primary key default 'default',
  seed          bigint not null,
  payload       bytea not null,
  generated_at  timestamptz not null default now()
);
