CREATE TABLE heritage (
  user_id     uuid primary key references users(user_id) ON DELETE CASCADE,
  payload     bytea not null,
  updated_at  timestamptz not null default now()
);
