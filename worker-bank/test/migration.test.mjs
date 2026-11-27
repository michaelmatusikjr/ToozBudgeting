/** WU-40: budget roles + activity schema, and the 0005 migration from today's schema. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { makeD1 } from "./d1-mock.mjs";

const LEGACY_SCHEMA = readFileSync(new URL("./schema-pre-roles.sql", import.meta.url), "utf8");
const MIGRATION_SQL = readFileSync(new URL("../migrations/0005_budget_roles_activity.sql", import.meta.url), "utf8");
const META_KEY = "migration:0005_budget_roles";

const now = 1_700_000_000_000;

function parseJson(raw) {
  if (raw == null || raw === "") return null;
  if (typeof raw === "object") return raw;
  try { return JSON.parse(raw); } catch { return null; }
}

/** List memberships / pending invites that still have a categories scope (D11). */
export function categoryScopeHits(raw) {
  const hits = [];
  for (const row of raw.prepare("SELECT household_id, user_id, scopes FROM memberships").all()) {
    const s = parseJson(row.scopes);
    if (s && Object.prototype.hasOwnProperty.call(s, "categories")) {
      hits.push({ kind: "membership", household_id: row.household_id, who: row.user_id, scopes: s });
    }
  }
  for (const row of raw.prepare(`
    SELECT household_id, email, scopes FROM invites
     WHERE accepted_at IS NULL AND revoked_at IS NULL
  `).all()) {
    const s = parseJson(row.scopes);
    if (s && Object.prototype.hasOwnProperty.call(s, "categories")) {
      hits.push({ kind: "invite", household_id: row.household_id, who: row.email, scopes: s });
    }
  }
  return hits;
}

function columnExists(raw, table, column) {
  return raw.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
}

function tableExists(raw, table) {
  return !!raw.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
}

/**
 * Apply 0005 idempotently against a node:sqlite DatabaseSync.
 * Production uses wrangler d1 migrations apply of the .sql file (once).
 */
export function applyRolesMigration(raw) {
  const already = raw.prepare("SELECT v FROM meta WHERE k = ?").get(META_KEY);
  if (already) return { already: true, hits: [] };

  const hits = categoryScopeHits(raw);
  if (hits.length) {
    const listing = hits.map((h) => `${h.kind} ${h.household_id} ${h.who} ${JSON.stringify(h.scopes)}`).join("\n");
    throw new Error(`D11: category scopes exist; stop and ask Mickey per person before migrating\n${listing}`);
  }

  raw.exec("BEGIN");
  try {
    // Run the SQL file, skipping comments, the D11 guard (already checked in JS),
    // and ALTER TABLE when the column already exists.
    const withoutComments = MIGRATION_SQL.replace(/--[^\n]*/g, "");
    const stripped = withoutComments
      .replace(/CREATE TEMP TABLE _cat_scope_hits[\s\S]*?DROP TABLE _cat_scope_hits;/, "")
      .replace(/SELECT CASE WHEN EXISTS[\s\S]*?END;/, "");
    const statements = stripped
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean);
    for (const sql of statements) {
      if (/^ALTER TABLE invites ADD COLUMN budget_roles\b/i.test(sql)) {
        if (!columnExists(raw, "invites", "budget_roles")) raw.exec(sql);
        continue;
      }
      raw.exec(sql);
    }
    raw.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)").run(META_KEY, "1");
    raw.exec("COMMIT");
    return { already: false, hits: [] };
  } catch (e) {
    try { raw.exec("ROLLBACK"); } catch { /* ignore */ }
    throw e;
  }
}

function makeLegacy() {
  const db = new DatabaseSync(":memory:");
  db.exec(LEGACY_SCHEMA);
  return db;
}

function insertHousehold(raw, { id = "h1", name = "House" } = {}) {
  raw.prepare("INSERT INTO households (id, name, created_at, seq) VALUES (?, ?, ?, 0)").run(id, name, now);
}

function insertUser(raw, { id, email, name }) {
  raw.prepare("INSERT INTO users (id, google_sub, email, name, created_at) VALUES (?, ?, ?, ?, ?)").run(id, "sub-" + id, email, name, now);
}

function insertMembership(raw, { household_id = "h1", user_id, role, scopes = null, access_rev = 1, invited_by = null }) {
  raw.prepare(`
    INSERT INTO memberships (household_id, user_id, role, scopes, access_rev, created_at, invited_by)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(household_id, user_id, role, scopes, access_rev, now, invited_by);
}

function insertBudget(raw, { household_id = "h1", id, name, deleted = 0 }) {
  const recId = "budget:" + id;
  const body = JSON.stringify({ id, name });
  raw.prepare(`
    INSERT INTO records (household_id, id, kind, budget_id, body, deleted, t, dev, seq, updated_at)
    VALUES (?, ?, 'budget', ?, ?, ?, ?, 'd', 1, ?)
  `).run(household_id, recId, id, body, deleted, now, now);
}

function insertInvite(raw, { id, household_id = "h1", email, role, scopes = null, accepted_at = null, revoked_at = null }) {
  raw.prepare(`
    INSERT INTO invites (id, household_id, email, role, scopes, invited_by, created_at, expires_at, accepted_at, revoked_at)
    VALUES (?, ?, ?, ?, ?, 'u_olivia', ?, ?, ?, ?)
  `).run(id, household_id, email, role, scopes, now, now + 86_400_000, accepted_at, revoked_at);
}

function seedToday({ withCategoryScope = false, inviteCategoryScope = false } = {}) {
  const raw = makeLegacy();
  insertHousehold(raw);
  insertUser(raw, { id: "u_olivia", email: "olivia@example.com", name: "Olivia" });
  insertUser(raw, { id: "u_mo", email: "mo@example.com", name: "Mo" });
  insertUser(raw, { id: "u_sam", email: "sam@example.com", name: "Sam" });
  insertUser(raw, { id: "u_val", email: "val@example.com", name: "Val" });

  insertMembership(raw, { user_id: "u_olivia", role: "owner", access_rev: 3 });
  insertMembership(raw, { user_id: "u_mo", role: "member", access_rev: 2, invited_by: "u_olivia" }); // unscoped
  insertMembership(raw, {
    user_id: "u_sam", role: "member", invited_by: "u_olivia",
    scopes: JSON.stringify({ budgets: ["family"] }),
  });
  insertMembership(raw, {
    user_id: "u_val", role: "viewer", invited_by: "u_olivia", access_rev: 4,
    scopes: withCategoryScope
      ? JSON.stringify({ budgets: ["family"], categories: { family: ["cat-groceries"] } })
      : JSON.stringify({ budgets: ["family"] }),
  });

  insertBudget(raw, { id: "family", name: "Family" });
  insertBudget(raw, { id: "private", name: "Private" });
  insertBudget(raw, { id: "gone", name: "Gone", deleted: 1 });

  insertInvite(raw, { id: "inv_member_all", email: "all@example.com", role: "member" });
  insertInvite(raw, {
    id: "inv_member_scoped", email: "scoped@example.com", role: "member",
    scopes: JSON.stringify({ budgets: ["private"] }),
  });
  insertInvite(raw, { id: "inv_viewer", email: "view@example.com", role: "viewer" });
  insertInvite(raw, { id: "inv_owner", email: "pat@example.com", role: "owner" });
  insertInvite(raw, {
    id: "inv_accepted", email: "old@example.com", role: "viewer",
    scopes: JSON.stringify({ budgets: ["family"] }),
    accepted_at: now,
  });
  if (inviteCategoryScope) {
    insertInvite(raw, {
      id: "inv_cats", email: "cats@example.com", role: "member",
      scopes: JSON.stringify({ categories: { family: ["cat-x"] } }),
    });
  }
  return raw;
}

function accessMap(raw) {
  const rows = raw.prepare("SELECT user_id, budget_id, role FROM budget_access ORDER BY user_id, budget_id").all();
  const out = {};
  for (const r of rows) {
    (out[r.user_id] ||= {})[r.budget_id] = r.role;
  }
  return out;
}

function snapshot(raw) {
  const tables = raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((t) => t.name);
  const data = {};
  for (const name of tables) {
    data[name] = raw.prepare(`SELECT * FROM "${name}"`).all();
  }
  return data;
}

test("a mock database with today's schema migrates to the expected access rows", () => {
  const raw = seedToday();
  const beforeRev = Object.fromEntries(
    raw.prepare("SELECT user_id, access_rev, role, scopes FROM memberships").all()
      .map((r) => [r.user_id, { access_rev: r.access_rev, role: r.role, scopes: r.scopes }]),
  );

  const result = applyRolesMigration(raw);
  assert.equal(result.already, false);

  // Access mapping (D1): no one gains or loses access.
  assert.deepEqual(accessMap(raw), {
    u_olivia: { family: "owner", private: "owner" },
    u_mo: { family: "member", private: "member" },
    u_sam: { family: "member" },
    u_val: { family: "viewer" },
  });
  // Deleted budget "gone" is not in access.
  const gone = raw.prepare("SELECT 1 FROM budget_access WHERE budget_id = 'gone'").get();
  assert.equal(gone, undefined);

  // Household roles: viewer → member; scopes retired; access_rev bumped once.
  const members = raw.prepare("SELECT user_id, role, scopes, access_rev FROM memberships ORDER BY user_id").all();
  for (const m of members) {
    assert.ok(m.role === "owner" || m.role === "member", `${m.user_id} role is ${m.role}`);
    assert.equal(m.scopes, null);
    assert.equal(m.access_rev, beforeRev[m.user_id].access_rev + 1);
  }
  assert.equal(members.find((m) => m.user_id === "u_val").role, "member");
  assert.equal(members.find((m) => m.user_id === "u_olivia").role, "owner");

  // Pending invites.
  const invites = Object.fromEntries(
    raw.prepare("SELECT id, role, scopes, budget_roles FROM invites").all().map((r) => [r.id, r]),
  );
  assert.equal(invites.inv_owner.role, "owner");
  assert.equal(invites.inv_owner.budget_roles, null);
  assert.equal(invites.inv_owner.scopes, null);

  assert.equal(invites.inv_member_all.role, "member");
  assert.equal(invites.inv_member_all.scopes, null);
  assert.deepEqual(JSON.parse(invites.inv_member_all.budget_roles), { family: "member", private: "member" });

  assert.equal(invites.inv_member_scoped.role, "member");
  assert.deepEqual(JSON.parse(invites.inv_member_scoped.budget_roles), { private: "member" });

  assert.equal(invites.inv_viewer.role, "member"); // household role
  assert.deepEqual(JSON.parse(invites.inv_viewer.budget_roles), { family: "viewer", private: "viewer" });

  // Already-accepted invite is left alone (not pending).
  assert.equal(invites.inv_accepted.role, "viewer");
  assert.ok(invites.inv_accepted.scopes);
  assert.equal(invites.inv_accepted.budget_roles, null);

  // Log starts empty; new tables exist.
  assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM activity").get().n, 0);
  assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM household_log").get().n, 0);
  assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM deleted_budgets").get().n, 0);
  assert.ok(columnExists(raw, "invites", "budget_roles"));
});

test("a database with a category scope makes the migration stop and change nothing", () => {
  const raw = seedToday({ withCategoryScope: true });
  const before = snapshot(raw);

  assert.throws(() => applyRolesMigration(raw), /D11: category scopes exist[\s\S]*membership h1 u_val/);

  const after = snapshot(raw);
  assert.deepEqual(after, before);
  assert.equal(tableExists(raw, "budget_access"), false);
  assert.equal(columnExists(raw, "invites", "budget_roles"), false);
  // memberships untouched
  const val = raw.prepare("SELECT role, scopes, access_rev FROM memberships WHERE user_id = 'u_val'").get();
  assert.equal(val.role, "viewer");
  assert.ok(JSON.parse(val.scopes).categories);
  assert.equal(val.access_rev, 4);
});

test("a pending invite with a category scope also stops the migration", () => {
  const raw = seedToday({ inviteCategoryScope: true });
  const before = snapshot(raw);
  assert.throws(() => applyRolesMigration(raw), /D11: category scopes exist[\s\S]*invite h1 cats@example.com/);
  assert.deepEqual(snapshot(raw), before);
});

test("running the migration twice changes nothing the second time", () => {
  const raw = seedToday();
  applyRolesMigration(raw);
  const first = snapshot(raw);
  const second = applyRolesMigration(raw);
  assert.equal(second.already, true);
  assert.deepEqual(snapshot(raw), first);
  // access_rev was not bumped again
  const olivia = raw.prepare("SELECT access_rev FROM memberships WHERE user_id = 'u_olivia'").get();
  assert.equal(olivia.access_rev, 4); // was 3, plus one
});

test("afterwards memberships.role is only owner/member and every scopes is NULL", () => {
  const raw = seedToday();
  applyRolesMigration(raw);
  const roles = raw.prepare("SELECT DISTINCT role FROM memberships").all().map((r) => r.role).sort();
  assert.deepEqual(roles, ["member", "owner"]);
  const scoped = raw.prepare("SELECT COUNT(*) AS n FROM memberships WHERE scopes IS NOT NULL").get();
  assert.equal(scoped.n, 0);
});

test("a fresh schema.sql database already has the new tables and budget_roles column", () => {
  const d1 = makeD1();
  const raw = d1.raw;
  assert.ok(tableExists(raw, "budget_access"));
  assert.ok(tableExists(raw, "activity"));
  assert.ok(tableExists(raw, "household_log"));
  assert.ok(tableExists(raw, "deleted_budgets"));
  assert.ok(columnExists(raw, "invites", "budget_roles"));
  // Existing tests still need to be able to insert a viewer membership (role model changes in WU-41).
  raw.prepare(`
    INSERT INTO households (id, name, created_at, seq) VALUES ('h', 'H', 1, 0)
  `).run();
  raw.prepare(`
    INSERT INTO users (id, google_sub, email, created_at) VALUES ('u', 'sub-u', 'a@b.c', 1)
  `).run();
  raw.prepare(`
    INSERT INTO memberships (household_id, user_id, role, access_rev) VALUES ('h', 'u', 'viewer', 1)
  `).run();
  const row = raw.prepare("SELECT role FROM memberships WHERE user_id = 'u'").get();
  assert.equal(row.role, "viewer");
});
