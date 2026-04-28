CREATE TABLE sessions (
  token_hash  text primary key,
  user_id     uuid not null references users(user_id) ON DELETE CASCADE,
  expires_at  timestamptz not null
);

CREATE INDEX sessions_user_id_idx ON sessions (user_id);
CREATE INDEX sessions_expires_at_idx ON sessions (expires_at);
