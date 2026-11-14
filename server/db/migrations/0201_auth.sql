-- B8 · Email/password accounts and persistent sessions.
-- Emails are stored lowercased; the CHECK keeps every writer honest.
ALTER TABLE users
  ADD COLUMN email         text,
  ADD COLUMN password_hash text;

ALTER TABLE users
  ADD CONSTRAINT users_email_lowercase CHECK (email = lower(email)),
  ADD CONSTRAINT users_email_length CHECK (char_length(email) <= 254);

CREATE UNIQUE INDEX users_email_key ON users (email);

-- One row per signed-in browser. The cookie holds a random token; only its
-- SHA-256 is stored, so reading this table never yields a usable cookie.
CREATE TABLE sessions (
  token_hash  bytea PRIMARY KEY CHECK (octet_length(token_hash) = 32),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token  text NOT NULL,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX sessions_user_idx ON sessions (user_id);
CREATE INDEX sessions_expires_idx ON sessions (expires_at);
