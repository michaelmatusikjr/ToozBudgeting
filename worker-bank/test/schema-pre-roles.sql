-- toozbudgeting-bank D1 schema for a fresh database. Safe to run more than once.
-- An existing database from v1 (device pairing) also needs migrations/0002_households.sql.

-- Household accounts
CREATE TABLE IF NOT EXISTS households (
  id TEXT PRIMARY KEY,
  name TEXT,
  created_at INTEGER,
  created_by TEXT,
  seq INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  google_sub TEXT NOT NULL UNIQUE,
  email TEXT,
  name TEXT,
  picture TEXT,
  created_at INTEGER,
  last_login INTEGER
);
CREATE INDEX IF NOT EXISTS users_email ON users (email);
CREATE TABLE IF NOT EXISTS memberships (
  household_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'member', 'viewer')),
  scopes TEXT,
  display_name TEXT,
  access_rev INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER,
  invited_by TEXT,
  PRIMARY KEY (household_id, user_id)
);
CREATE INDEX IF NOT EXISTS memberships_user ON memberships (user_id);
CREATE TABLE IF NOT EXISTS invites (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL,
  email TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'member', 'viewer')),
  scopes TEXT,
  invited_by TEXT,
  created_at INTEGER,
  expires_at INTEGER,
  accepted_at INTEGER,
  accepted_by TEXT,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS invites_email ON invites (email);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  user_id TEXT NOT NULL,
  household_id TEXT NOT NULL,
  device_name TEXT,
  created_at INTEGER,
  last_seen INTEGER,
  expires_at INTEGER
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_id);
CREATE TABLE IF NOT EXISTS login_codes (
  code_hash TEXT PRIMARY KEY,
  sealed TEXT NOT NULL,
  expires_at INTEGER
);

-- Shared budget: one row per app record, last write wins by (t, dev); seq orders pulls.
CREATE TABLE IF NOT EXISTS records (
  household_id TEXT NOT NULL,
  id TEXT NOT NULL,
  kind TEXT NOT NULL,
  budget_id TEXT,
  body TEXT,
  deleted INTEGER NOT NULL DEFAULT 0,
  t INTEGER NOT NULL,
  dev TEXT,
  seq INTEGER NOT NULL,
  updated_by TEXT,
  updated_at INTEGER,
  PRIMARY KEY (household_id, id)
);
CREATE INDEX IF NOT EXISTS records_seq ON records (household_id, seq);

-- Bank sync
CREATE TABLE IF NOT EXISTS items (
  item_id TEXT PRIMARY KEY,
  household_id TEXT,
  institution_id TEXT,
  institution_name TEXT,
  access_enc TEXT NOT NULL,
  cursor TEXT,
  status TEXT NOT NULL DEFAULT 'ok',
  error TEXT,
  accounts TEXT,
  new_accounts INTEGER DEFAULT 0,
  consent_expires_at TEXT,
  created_at INTEGER,
  added_by TEXT,
  last_sync_at INTEGER,
  last_webhook_at INTEGER,
  last_webhook_code TEXT,
  webhook_url TEXT,
  sync_lock INTEGER
);
CREATE TABLE IF NOT EXISTS bank_inbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  household_id TEXT NOT NULL,
  item_id TEXT,
  created_at INTEGER,
  enc TEXT NOT NULL,
  held INTEGER NOT NULL DEFAULT 0,
  claimed_by TEXT,
  claim_until INTEGER
);
CREATE INDEX IF NOT EXISTS bank_inbox_household ON bank_inbox (household_id, id);
CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v TEXT
);
CREATE TABLE IF NOT EXISTS attempts (
  ip TEXT,
  at INTEGER
);
CREATE INDEX IF NOT EXISTS attempts_ip ON attempts (ip, at);

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
