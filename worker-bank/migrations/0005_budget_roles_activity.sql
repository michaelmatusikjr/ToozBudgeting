-- Per-budget roles and the activity log.
-- Numbered 0005 because 0004_link_sessions.sql already shipped.
-- Fresh databases get these tables from schema.sql; this file is for existing ones.
--
-- D11: if any membership or pending invite has a `categories` key in scopes,
-- this migration MUST be stopped before any change. Wrangler applies the whole
-- file in one batch; the guard is the first statement that writes, via a
-- RAISE, so a hit rolls the batch back. The test runner also checks in JS and
-- lists the rows.
--
-- This file is not safe to run twice: ALTER TABLE ADD COLUMN budget_roles
-- will fail if the column already exists. Wrangler records applied migrations
-- so production runs it once. Tests use applyRolesMigration() in
-- worker-bank/test/migration.test.mjs, which is idempotent.

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

CREATE TABLE IF NOT EXISTS deleted_budgets (
  household_id TEXT NOT NULL,
  budget_id TEXT NOT NULL,
  name TEXT,
  deleted_at INTEGER,
  deleted_by TEXT,
  PRIMARY KEY (household_id, budget_id)
);

-- D11 guard: abort and change nothing if any category scopes exist.
-- Temporary tables from a failed run do not persist (the batch rolls back).
CREATE TEMP TABLE _cat_scope_hits AS
  SELECT 'membership' AS kind, household_id AS household_id, user_id AS who, scopes
    FROM memberships
    WHERE json_extract(scopes, '$.categories') IS NOT NULL
  UNION ALL
  SELECT 'invite', household_id, email, scopes
    FROM invites
    WHERE accepted_at IS NULL AND revoked_at IS NULL
      AND json_extract(scopes, '$.categories') IS NOT NULL;

SELECT CASE WHEN EXISTS (SELECT 1 FROM _cat_scope_hits)
  THEN RAISE(ABORT, 'D11: category scopes exist; stop and ask Mickey per person before migrating')
END;

DROP TABLE _cat_scope_hits;

ALTER TABLE invites ADD COLUMN budget_roles TEXT;

-- Backfill budget_access from today's memberships + budget headers (D1).
-- budget_id is the budget's own id (records.budget_id / body.id), not the record id (budget:…).

INSERT OR IGNORE INTO budget_access (household_id, budget_id, user_id, role, granted_by, granted_at)
SELECT m.household_id,
       COALESCE(r.budget_id, json_extract(r.body, '$.id')),
       m.user_id,
       'owner',
       COALESCE(m.invited_by, m.user_id),
       CAST(strftime('%s', 'now') AS INTEGER) * 1000
  FROM memberships m
  JOIN records r ON r.household_id = m.household_id AND r.kind = 'budget' AND r.deleted = 0
 WHERE m.role = 'owner'
   AND COALESCE(r.budget_id, json_extract(r.body, '$.id')) IS NOT NULL;

INSERT OR IGNORE INTO budget_access (household_id, budget_id, user_id, role, granted_by, granted_at)
SELECT m.household_id,
       COALESCE(r.budget_id, json_extract(r.body, '$.id')),
       m.user_id,
       CASE m.role WHEN 'viewer' THEN 'viewer' ELSE 'member' END,
       COALESCE(m.invited_by, m.user_id),
       CAST(strftime('%s', 'now') AS INTEGER) * 1000
  FROM memberships m
  JOIN records r ON r.household_id = m.household_id AND r.kind = 'budget' AND r.deleted = 0
 WHERE m.role IN ('member', 'viewer')
   AND (m.scopes IS NULL OR json_extract(m.scopes, '$.budgets') IS NULL)
   AND COALESCE(r.budget_id, json_extract(r.body, '$.id')) IS NOT NULL;

INSERT OR IGNORE INTO budget_access (household_id, budget_id, user_id, role, granted_by, granted_at)
SELECT m.household_id,
       je.value,
       m.user_id,
       CASE m.role WHEN 'viewer' THEN 'viewer' ELSE 'member' END,
       COALESCE(m.invited_by, m.user_id),
       CAST(strftime('%s', 'now') AS INTEGER) * 1000
  FROM memberships m
  JOIN json_each(json_extract(m.scopes, '$.budgets')) je
  JOIN records r ON r.household_id = m.household_id AND r.kind = 'budget' AND r.deleted = 0
                AND COALESCE(r.budget_id, json_extract(r.body, '$.id')) = je.value
 WHERE m.role IN ('member', 'viewer')
   AND json_extract(m.scopes, '$.budgets') IS NOT NULL;

-- Copy pending invite role/scopes into budget_roles before retiring them.
-- Household-owner invites leave budget_roles NULL: they become Owner of every budget (D2).
UPDATE invites
   SET budget_roles = CASE
     WHEN role = 'owner' THEN NULL
     WHEN json_extract(scopes, '$.budgets') IS NOT NULL THEN (
       SELECT json_group_object(je.value, CASE invites.role WHEN 'viewer' THEN 'viewer' ELSE 'member' END)
         FROM json_each(json_extract(invites.scopes, '$.budgets')) je
     )
     ELSE (
       SELECT json_group_object(bid, CASE invites.role WHEN 'viewer' THEN 'viewer' ELSE 'member' END)
         FROM (
           SELECT COALESCE(r.budget_id, json_extract(r.body, '$.id')) AS bid
             FROM records r
            WHERE r.household_id = invites.household_id AND r.kind = 'budget' AND r.deleted = 0
              AND COALESCE(r.budget_id, json_extract(r.body, '$.id')) IS NOT NULL
         )
     )
   END
 WHERE accepted_at IS NULL AND revoked_at IS NULL AND budget_roles IS NULL;

UPDATE invites SET role = 'member' WHERE role = 'viewer' AND accepted_at IS NULL AND revoked_at IS NULL;
UPDATE invites SET scopes = NULL WHERE accepted_at IS NULL AND revoked_at IS NULL;

UPDATE memberships SET role = 'member' WHERE role = 'viewer';
UPDATE memberships SET scopes = NULL;
UPDATE memberships SET access_rev = access_rev + 1;
