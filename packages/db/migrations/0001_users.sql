CREATE TABLE users (
  user_id           uuid primary key,
  login_name        text unique not null,
  password_hash     text not null,
  created_at        timestamptz not null default now(),
  last_login_at     timestamptz,
  active_dynasty_id uuid not null,
  last_tile_id      text,
  hearth_anchor     jsonb,
  settings          jsonb not null default '{}'::jsonb
);

CREATE INDEX users_last_tile_id_idx ON users (last_tile_id) WHERE last_tile_id IS NOT NULL;
