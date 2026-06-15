-- The server creates this automatically on boot, but here it is for reference / manual setup.
CREATE TABLE IF NOT EXISTS waitlist (
  id          SERIAL PRIMARY KEY,
  contact     TEXT NOT NULL UNIQUE,        -- the email or @handle
  type        TEXT NOT NULL,               -- 'email' | 'x'
  referrer    TEXT,
  user_agent  TEXT,
  ip          TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS waitlist_created_idx ON waitlist (created_at);

-- Export your signups any time:
--   SELECT contact, type, created_at FROM waitlist ORDER BY created_at;
-- Just the emails:
--   SELECT contact FROM waitlist WHERE type = 'email' ORDER BY created_at;