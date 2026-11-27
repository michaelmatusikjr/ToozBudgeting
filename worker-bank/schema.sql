-- toozbudgeting-bank D1 schema for a fresh database. Safe to run more than once.
-- An existing database from v1 (device pairing) also needs migrations/0002_households.sql.
-- Existing databases also need 0004_link_sessions.sql and 0005_budget_roles_activity.sql
-- (0005 is numbered after 0004_link_sessions, which already shipped).

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
  budget_roles TEXT,
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

-- Per-budget access. No row = no access. Household owners are treated as owner even without a row (see roles.js).
CREATE TABLE IF NOT EXISTS budget_access (
  household_id TEXT NOT NULL,
  budget_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'member', 'viewer')),
  granted_by TEXT,
  granted_at INTEGER,
  PRIMARY KEY (household_id, budget_id, user_id)
);
CREATE INDEX IF NOT EXISTS budget_access_user ON budget_access (household_id, user_id);

-- Activity log for one budget. Kept forever until the budget is deleted and 30 days pass.
CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  household_id TEXT NOT NULL,
  budget_id TEXT NOT NULL,
  at INTEGER,
  client_t INTEGER,
  user_id TEXT,
  device TEXT,
  source TEXT DEFAULT 'app',
  action TEXT,
  op_id TEXT,
  label TEXT,
  target_kind TEXT,
  target_id TEXT,
  category_id TEXT,
  account_id TEXT,
  amount REAL,
  before TEXT,
  after TEXT
);
CREATE INDEX IF NOT EXISTS activity_budget_at ON activity (household_id, budget_id, at);
CREATE INDEX IF NOT EXISTS activity_budget_user_at ON activity (household_id, budget_id, user_id, at);

CREATE TABLE IF NOT EXISTS household_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  household_id TEXT NOT NULL,
  at INTEGER,
  user_id TEXT,
  action TEXT,
  target_user TEXT,
  budget_id TEXT,
  before TEXT,
  after TEXT
);
CREATE INDEX IF NOT EXISTS household_log_hh_at ON household_log (household_id, at);

-- Deleted budgets: activity stays exportable for 30 days.
CREATE TABLE IF NOT EXISTS deleted_budgets (
  household_id TEXT NOT NULL,
  budget_id TEXT NOT NULL,
  name TEXT,
  deleted_at INTEGER,
  deleted_by TEXT,
  PRIMARY KEY (household_id, budget_id)
);
