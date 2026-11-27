/**
 * Shared budget sync.
 *
 * The app already stores its budget as small records (one per transaction, category, account, payee,
 * month-and-category assignment, and so on), each stamped with the edit time `t` and device `dev`.
 * The server keeps one row per record per household.
 *
 * Conflicts: last write wins per record, by (t, dev). Two people editing different things never collide.
 * Two people editing the same transaction at once: the later edit wins, and the other device is handed the
 * winner in the push response, so both end up the same. Deletes are tombstones, so they win the same way.
 *
 * Pull is by a per-household sequence number. The seq bump and the upsert run in one D1 batch (a single
 * transaction on a single-writer database), so a reader can never skip a change.
 */
import { HttpError, now, readJson } from "./http.js";
import { requireAction } from "./auth.js";
import { SYNC_KINDS, canReadRecord, canWriteRecord, canCreateBudget, recordBudgetId, OWNER_ONLY_BUDGET_FIELDS } from "./roles.js";
import { cleanOp, insertActivity } from "./activity.js";

const MAX_PUSH_BYTES = 1500 * 1024;
const MAX_PUSH_RECORDS = 1000;
const PULL_LIMIT = 1000;
const FUTURE_SKEW_MS = 60000;

function cleanRecord(r) {
  if (!r || typeof r !== "object") return null;
  const id = String(r.id || "");
  const kind = String(r.kind || "");
  if (!id || id.length > 200 || !SYNC_KINDS.has(kind)) return null;
  const t = Number(r.t);
  if (!Number.isFinite(t) || t <= 0) return null;
  const deleted = r.deleted ? 1 : 0;
  const body = deleted ? (r.body == null ? null : JSON.stringify(r.body)) : JSON.stringify(r.body ?? null);
  if (body && body.length > 200 * 1024) return null;
  return {
    id, kind, deleted,
    budgetId: r.budgetId == null ? null : String(r.budgetId).slice(0, 100),
    body,
    t: Math.min(Math.floor(t), now() + FUTURE_SKEW_MS),
    sentT: t,
    dev: String(r.dev || "").slice(0, 64),
    op: cleanOp(r.op),
  };
}

function rowView(row) {
  return { id: row.id, kind: row.kind, budgetId: row.budget_id, body: row.body, deleted: !!row.deleted, t: row.t, dev: row.dev, seq: row.seq, by: row.updated_by };
}

/** POST /sync/push { records: [...] } -> { seq, from, applied, current: [server copies that won or were kept], denied, invalid } */
export async function push(env, req, session) {
  requireAction(session, "budget.write", "You have view-only access, so changes stay on this device");
  const body = await readJson(req, MAX_PUSH_BYTES);
  const raw = Array.isArray(body.records) ? body.records : [];
  if (raw.length > MAX_PUSH_RECORDS) throw new HttpError(413, `Send at most ${MAX_PUSH_RECORDS} records at a time`);
  const cleaned = [];
  let invalid = 0;
  for (const r of raw) {
    const c = cleanRecord(r);
    if (!c) { invalid++; continue; }
    cleaned.push(c);
  }
  const hid = session.householdId;

  // Which budget headers already exist live? A missing or tombstoned header is a create (D3, D4).
  const headerKeys = new Set();
  for (const c of cleaned) {
    if (c.kind !== "budget") continue;
    headerKeys.add(c.id);
    const bid = recordBudgetId(c);
    if (bid) headerKeys.add(bid);
  }
  const existingLive = new Set();
  const existingName = new Map();
  if (headerKeys.size) {
    const rows = (await env.DB.prepare(
      "SELECT id, budget_id, deleted, body FROM records WHERE household_id = ? AND kind = 'budget' AND (id IN (SELECT value FROM json_each(?)) OR budget_id IN (SELECT value FROM json_each(?)))"
    ).bind(hid, JSON.stringify([...headerKeys]), JSON.stringify([...headerKeys])).all()).results || [];
    for (const row of rows) {
      const keys = [row.id, row.budget_id].filter(Boolean);
      let name = null;
      try { name = JSON.parse(row.body || "null")?.name || null; } catch { name = null; }
      for (const k of keys) if (name) existingName.set(k, name);
      if (!row.deleted) for (const k of keys) existingLive.add(k);
    }
  }

  const byId = new Map();
  const denied = [];
  const creates = new Set(); // budget ids this push is creating
  for (const c of cleaned) {
    const bid = recordBudgetId(c);
    const isCreate = c.kind === "budget" && !c.deleted && !existingLive.has(c.id) && (!bid || !existingLive.has(bid));
    if (isCreate) {
      if (!canCreateBudget(session)) { denied.push(c.id); continue; }
      if (bid) creates.add(bid);
    } else if (creates.has(bid) && canCreateBudget(session)) {
      // Same-push child records of a budget this person is creating.
    } else if (!canWriteRecord(session, c)) {
      denied.push(c.id);
      continue;
    }
    const prev = byId.get(c.id);
    if (!prev || c.t > prev.t || (c.t === prev.t && c.dev > prev.dev)) byId.set(c.id, c);
  }
  const list = [...byId.values()];

  if (session.member.role !== "owner") {
    const headers = list.filter((r) => r.kind === "budget" && r.body);
    if (headers.length) {
      const stored = (await env.DB.prepare("SELECT id, body FROM records WHERE household_id = ? AND kind = 'budget' AND id IN (SELECT value FROM json_each(?))")
        .bind(hid, JSON.stringify(headers.map((h) => h.id))).all()).results || [];
      const old = new Map(stored.map((s) => [s.id, (() => { try { return JSON.parse(s.body) || {}; } catch { return {}; } })()]));
      for (const h of headers) {
        const b = JSON.parse(h.body) || {};
        const prev = old.get(h.id) || {};
        for (const f of OWNER_ONLY_BUDGET_FIELDS) {
          if (prev[f] !== undefined) b[f] = prev[f]; else delete b[f];
        }
        const next = JSON.stringify(b);
        if (next !== h.body) { h.body = next; h.overridden = true; }
      }
    }
  }

  const previousById = new Map();
  if (list.length) {
    const prev = (await env.DB.prepare("SELECT id, kind, budget_id, body, deleted FROM records WHERE household_id = ? AND id IN (SELECT value FROM json_each(?))")
      .bind(hid, JSON.stringify(list.map((r) => r.id))).all()).results || [];
    for (const row of prev) previousById.set(row.id, row);
  }

  if (list.length) {
    const stmts = [
      env.DB.prepare(`INSERT INTO records (household_id, id, kind, budget_id, body, deleted, t, dev, seq, updated_by, updated_at)
        SELECT ?1, json_extract(value, '$.id'), json_extract(value, '$.kind'), json_extract(value, '$.budgetId'), json_extract(value, '$.body'),
          json_extract(value, '$.deleted'), json_extract(value, '$.t'), json_extract(value, '$.dev'),
          (SELECT seq FROM households WHERE id = ?1) + key + 1, ?2, ?3
        FROM json_each(?4) WHERE true
        ON CONFLICT(household_id, id) DO UPDATE SET
          kind = excluded.kind, budget_id = excluded.budget_id, body = excluded.body, deleted = excluded.deleted,
          t = excluded.t, dev = excluded.dev, seq = excluded.seq, updated_by = excluded.updated_by, updated_at = excluded.updated_at
        WHERE excluded.t > records.t OR (excluded.t = records.t AND excluded.dev > records.dev)`)
        .bind(hid, session.user.id, now(), JSON.stringify(list.map(({ sentT, overridden, op, ...r }) => r))),
      env.DB.prepare("UPDATE households SET seq = seq + ? WHERE id = ?").bind(list.length, hid),
    ];
    const created = [...creates];
    if (created.length) {
      stmts.push(env.DB.prepare(
        `INSERT OR IGNORE INTO budget_access (household_id, budget_id, user_id, role, granted_by, granted_at)
         SELECT ?1, value, ?2, 'owner', ?2, ?3 FROM json_each(?4)`
      ).bind(hid, session.user.id, now(), JSON.stringify(created)));
      stmts.push(env.DB.prepare(
        "UPDATE memberships SET access_rev = access_rev + 1 WHERE household_id = ? AND user_id = ?"
      ).bind(hid, session.user.id));
    }
    for (const tomb of list.filter((r) => r.kind === "budget" && r.deleted)) {
      const bid = recordBudgetId(tomb) || tomb.id;
      let name = existingName.get(bid) || existingName.get(tomb.id) || bid;
      try { name = JSON.parse(tomb.body || "null")?.name || name; } catch { /* keep */ }
      stmts.push(env.DB.prepare(
        `INSERT INTO deleted_budgets (household_id, budget_id, name, deleted_at, deleted_by)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(household_id, budget_id) DO UPDATE SET name = excluded.name, deleted_at = excluded.deleted_at, deleted_by = excluded.deleted_by`
      ).bind(hid, bid, String(name || bid).slice(0, 200), now(), session.user.id));
    }
    await env.DB.batch(stmts);
  }
  // Find what didn't land as sent (lost to a newer edit, clamped, or owner-only fields kept), and send those back.
  const sent = new Map(list.map((r) => [r.id, r]));
  const brief = list.length
    ? ((await env.DB.prepare("SELECT id, t, dev FROM records WHERE household_id = ? AND id IN (SELECT value FROM json_each(?))").bind(hid, JSON.stringify(list.map((r) => r.id))).all()).results || [])
    : [];
  const differs = [...denied];
  let applied = 0;
  const landed = [];
  for (const row of brief) {
    const s = sent.get(row.id);
    if (row.t === s.sentT && row.dev === s.dev && !s.overridden) { applied++; landed.push(s); }
    else differs.push(row.id);
  }
  if (landed.length) await insertActivity(env, session, landed, previousById);
  const current = [];
  if (differs.length) {
    const rows = (await env.DB.prepare("SELECT * FROM records WHERE household_id = ? AND id IN (SELECT value FROM json_each(?))").bind(hid, JSON.stringify(differs.slice(0, 2000))).all()).results || [];
    for (const row of rows) if (canReadRecord(session, row)) current.push(rowView(row));
  }
  const seq = (await env.DB.prepare("SELECT seq FROM households WHERE id = ?").bind(hid).first())?.seq || 0;
  // from: the seq just before this push (the bump and the insert are one transaction). When it equals the
  // device's cursor, nobody else wrote in between, so the device can skip pulling its own records back.
  const from = list.length ? seq - list.length : seq;
  return { seq, from, applied, current, denied, invalid };
}

/** GET /sync/pull?since=N -> { records, seq, more } */
export async function pull(env, url, session) {
  requireAction(session, "budget.read");
  const since = Math.max(0, Number(url.searchParams.get("since") || 0) || 0);
  const limit = Math.max(1, Math.min(PULL_LIMIT, Number(url.searchParams.get("limit") || PULL_LIMIT) || PULL_LIMIT));
  const rows = (await env.DB.prepare("SELECT * FROM records WHERE household_id = ? AND seq > ? ORDER BY seq LIMIT ?").bind(session.householdId, since, limit).all()).results || [];
  const records = [];
  for (const row of rows) if (canReadRecord(session, row)) records.push(rowView(row));
  const last = rows.length ? rows[rows.length - 1].seq : since;
  return { records, seq: last, more: rows.length === limit, accessRev: session.member.accessRev, role: session.member.role };
}
