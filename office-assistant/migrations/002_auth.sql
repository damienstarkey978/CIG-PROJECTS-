ALTER TABLE users
  ADD COLUMN password_hash text,
  ADD COLUMN last_login_at timestamptz;

CREATE UNIQUE INDEX users_email_unique ON users (lower(email)) WHERE email IS NOT NULL;

CREATE TABLE sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash  text NOT NULL UNIQUE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL
);
CREATE INDEX sessions_user ON sessions (user_id);
