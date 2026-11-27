-- toozbudgeting-bank D1 schema. Safe to run more than once.
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  public_key TEXT NOT NULL,
  name TEXT,
  created_at INTEGER,
  last_seen INTEGER
);
CREATE TABLE IF NOT EXISTS items (
  item_id TEXT PRIMARY KEY,
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
  last_sync_at INTEGER,
  last_webhook_at INTEGER,
  sync_lock INTEGER
);
CREATE TABLE IF NOT EXISTS inbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT NOT NULL,
  item_id TEXT,
  created_at INTEGER,
  enc TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS inbox_device ON inbox (device_id, id);
CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v TEXT
);
CREATE TABLE IF NOT EXISTS attempts (
  ip TEXT,
  at INTEGER
);
CREATE INDEX IF NOT EXISTS attempts_ip ON attempts (ip, at);
