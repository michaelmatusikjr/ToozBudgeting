-- v2.0.3: Plaid Link sessions kept server-side, so a bank OAuth return that opens in another browser
-- (iPhone home-screen app -> Safari) can resume with the same link token after signing in there.
CREATE TABLE IF NOT EXISTS link_sessions (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  link_token_enc TEXT NOT NULL,
  mode TEXT NOT NULL,
  item_id TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  result TEXT,
  oauth_redirect INTEGER DEFAULT 0,
  created_at INTEGER,
  updated_at INTEGER,
  expires_at INTEGER
);
CREATE INDEX IF NOT EXISTS link_sessions_household ON link_sessions (household_id, created_at);
