/**
 * Activity log: one row per real change that landed on a push (WU-44).
 * Denied, invalid, and losing records are never logged.
 */
import { now } from "./http.js";
import { recordBudgetId } from "./roles.js";

export const ACTIVITY_KEEP_DAYS = 30;

const OP_ACTION = {
  categorize: "categorized", categorized: "categorized",
  approve: "approved", approved: "approved",
  assign: "assigned", assigned: "assigned",
  move: "money-moved", "money-moved": "money-moved",
  cover: "overspending-covered", "overspending-covered": "overspending-covered",
  "auto-assign": "auto-assigned", "auto-assigned": "auto-assigned",
  "free-up": "freed-from-future", "freed-from-future": "freed-from-future",
  reconcile: "reconciled", reconciled: "reconciled",
  unreconcile: "unreconciled", unreconciled: "unreconciled",
  transfer: "transfer-edited", "transfer-added": "transfer-added", "transfer-edited": "transfer-edited",
  goal: "goal-changed", "goal-edit": "goal-changed", "goal-changed": "goal-changed",
  "bank-import": "bank-import",
  "transaction-added": "transaction-added", "transaction-edited": "transaction-edited", "transaction-deleted": "transaction-deleted",
  "account-added": "account-added", "account-renamed": "account-renamed", "account-archived": "account-archived", "account-deleted": "account-deleted",
  "card-added": "card-added", "card-renamed": "card-renamed", "card-archived": "card-archived", "card-deleted": "card-deleted",
  "category-added": "category-added", "category-renamed": "category-renamed", "category-archived": "category-archived", "category-deleted": "category-deleted",
  "group-added": "group-added", "group-renamed": "group-renamed", "group-archived": "group-archived", "group-deleted": "group-deleted",
  "note-changed": "note-changed",
};

export function cleanOp(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = String(raw.id || "").slice(0, 80);
  const action = String(raw.action || "").slice(0, 80);
  const label = String(raw.label || "").slice(0, 200);
  if (!id && !action && !label) return null;
  return { id, action, label };
}

function parseBody(raw) {
  if (raw == null) return null;
  if (typeof raw === "object") return raw;
  try { return JSON.parse(raw); } catch { return null; }
}

function eq(a, b) {
  if (a === b) return true;
  if (a == null && b == null) return true;
  try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; }
}

function changedFields(prev, next) {
  const a = prev && typeof prev === "object" ? prev : {};
  const b = next && typeof next === "object" ? next : {};
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const before = {}, after = {};
  for (const k of keys) {
    if (eq(a[k], b[k])) continue;
    before[k] = a[k] === undefined ? null : a[k];
    after[k] = b[k] === undefined ? null : b[k];
  }
  return { before, after };
}

function money(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return "";
  const sign = v < 0 ? "-" : "";
  return `${sign}$${Math.abs(v).toFixed(2)}`;
}

function isTransfer(body) {
  return !!body && (body.type === "transfer" || body.transferAccountId || body.transferLinkId || body.transferId);
}

function newMoveEntries(prevBody, nextBody) {
  const a = prevBody?.moneyMoveLog || [];
  const b = nextBody?.moneyMoveLog || [];
  const oldTs = new Set(a.map((e) => e && e.ts).filter(Boolean));
  const oldJson = new Set(a.map((e) => JSON.stringify(e)));
  return b.filter((e) => {
    if (e?.ts && oldTs.has(e.ts)) return false;
    if (oldJson.has(JSON.stringify(e))) return false;
    return true;
  });
}

function moveAction(entry, opAction) {
  if (opAction && OP_ACTION[opAction]) return OP_ACTION[opAction];
  const type = entry?.type;
  if (type === "cover") return "overspending-covered";
  if (type === "assign") return "assigned";
  if (type === "move") {
    const toRta = (entry.entries || []).every((x) => x.to === "rta");
    if (toRta && (entry.entries || []).length) return "freed-from-future";
    return "money-moved";
  }
  return "money-moved";
}

function entityVerb(kind, prev, next, deleted) {
  const prefix = kind === "creditCard" ? "card" : kind === "categoryGroup" ? "group" : kind;
  if (deleted && !prev?.deleted) return `${prefix}-deleted`;
  if (!prev || prev.deleted) return `${prefix}-added`;
  if (!!next.archived && !prev.body?.archived) return `${prefix}-archived`;
  if ((next.name || "") !== (prev.body?.name || "")) return `${prefix}-renamed`;
  return null;
}

function describeRecord(rec, prevRow) {
  const prevDeleted = !!(prevRow && prevRow.deleted);
  const existed = !!prevRow && !prevDeleted;
  const prevBody = existed ? parseBody(prevRow.body) : null;
  const nextBody = rec.deleted ? null : parseBody(rec.body);
  const bid = recordBudgetId(rec) || prevRow?.budget_id || null;
  const base = {
    budgetId: bid,
    clientT: rec.t,
    targetKind: rec.kind,
    targetId: (nextBody && nextBody.id) || (prevBody && prevBody.id) || rec.id,
    categoryId: nextBody?.categoryId || prevBody?.categoryId || null,
    accountId: nextBody?.accountId || prevBody?.accountId || null,
    amount: nextBody?.amount ?? prevBody?.amount ?? null,
    before: null,
    after: null,
    action: null,
    wording: null,
  };
  const diff = changedFields(prevBody, nextBody || {});
  if (rec.kind === "transaction") {
    if (rec.deleted) {
      return { ...base, action: isTransfer(prevBody) ? "transfer-deleted" : "transaction-deleted", wording: isTransfer(prevBody) ? "Deleted a transfer" : "Deleted a transaction", before: prevBody, after: null, amount: prevBody?.amount ?? null };
    }
    if (!existed) {
      const tr = isTransfer(nextBody);
      return {
        ...base, action: tr ? "transfer-added" : "transaction-added",
        wording: tr ? `Added a transfer of ${money(nextBody?.amount)}` : `Added a transaction${nextBody?.payee ? " for " + nextBody.payee : ""}`,
        after: nextBody, before: null,
      };
    }
    const pieces = [];
    if (!eq(prevBody?.categoryId, nextBody?.categoryId)) {
      pieces.push({
        ...base, action: "categorized",
        wording: `Categorized${nextBody?.payee ? " " + nextBody.payee : ""}`,
        categoryId: nextBody?.categoryId || null,
        before: { categoryId: prevBody?.categoryId ?? null },
        after: { categoryId: nextBody?.categoryId ?? null },
      });
    }
    if (prevBody?.categoryConfirmed === false && nextBody?.categoryConfirmed === true) {
      pieces.push({ ...base, action: "approved", wording: "Approved a category", before: { categoryConfirmed: false }, after: { categoryConfirmed: true } });
    }
    if (!!prevBody?.reconciled !== !!nextBody?.reconciled) {
      const on = !!nextBody?.reconciled;
      pieces.push({ ...base, action: on ? "reconciled" : "unreconciled", wording: on ? "Reconciled a transaction" : "Unreconciled a transaction", before: { reconciled: !!prevBody?.reconciled }, after: { reconciled: on } });
    }
    if (pieces.length) return pieces;
    const tr = isTransfer(nextBody) || isTransfer(prevBody);
    return {
      ...base, action: tr ? "transfer-edited" : "transaction-edited",
      wording: tr ? "Edited a transfer" : "Edited a transaction",
      before: diff.before, after: diff.after,
    };
  }
  if (rec.kind === "assignmentCell") {
    const prevAmt = Number(prevBody?.amount || 0);
    const nextAmt = rec.deleted ? 0 : Number(nextBody?.amount || 0);
    const delta = nextAmt - prevAmt;
    if (Math.abs(delta) < 0.0005 && existed) return null;
    return {
      ...base,
      action: "assigned",
      wording: `Assigned ${money(nextAmt)}`,
      categoryId: nextBody?.categoryId || prevBody?.categoryId || null,
      amount: nextAmt,
      before: existed ? { amount: prevAmt, month: prevBody?.month } : null,
      after: rec.deleted ? null : { amount: nextAmt, month: nextBody?.month, categoryId: nextBody?.categoryId },
    };
  }
  if (rec.kind === "category") {
    if (existed && !rec.deleted && !eq(prevBody?.goal, nextBody?.goal)) {
      return { ...base, action: "goal-changed", wording: "Changed a goal", before: { goal: prevBody?.goal ?? null }, after: { goal: nextBody?.goal ?? null } };
    }
    const verb = entityVerb("category", existed ? { deleted: false, body: prevBody } : null, nextBody || {}, rec.deleted);
    if (verb) {
      const word = { "category-added": "Added a category", "category-renamed": "Renamed a category", "category-archived": "Archived a category", "category-deleted": "Deleted a category" }[verb];
      return { ...base, action: verb, wording: word, before: prevBody, after: nextBody, targetId: (nextBody || prevBody)?.id || rec.id };
    }
  }
  if (rec.kind === "account" || rec.kind === "creditCard" || rec.kind === "categoryGroup") {
    const kind = rec.kind;
    const verb = entityVerb(kind, existed ? { deleted: false, body: prevBody } : null, nextBody || {}, rec.deleted);
    if (verb) {
      const nouns = { account: "an account", creditCard: "a card", categoryGroup: "a group" };
      const acts = { added: "Added", renamed: "Renamed", archived: "Archived", deleted: "Deleted" };
      const tail = verb.split("-")[1];
      return { ...base, action: verb, wording: `${acts[tail] || tail} ${nouns[kind]}`, before: prevBody, after: nextBody };
    }
  }
  if (rec.kind === "note") {
    return { ...base, action: "note-changed", wording: "Changed a note", before: prevBody, after: nextBody };
  }
  if (rec.kind === "budget") {
    const entries = newMoveEntries(prevBody, nextBody);
    if (entries.length) {
      return entries.map((entry) => {
        const amt = (entry.entries || []).reduce((s, x) => s + Number(x.amount || 0), 0);
        const action = moveAction(entry, null);
        const wording = {
          "money-moved": `Moved ${money(amt)}`,
          "overspending-covered": `Covered overspending (${money(amt)})`,
          "assigned": `Assigned ${money(amt)}`,
          "auto-assigned": `Auto-assigned ${money(amt)}`,
          "freed-from-future": `Freed ${money(amt)} from future months`,
        }[action] || `Moved ${money(amt)}`;
        return {
          ...base, action, wording, amount: amt,
          categoryId: entry.entries?.[0]?.to || entry.entries?.[0]?.from || null,
          before: null, after: entry,
        };
      });
    }
  }
  if (!existed && !rec.deleted) {
    return { ...base, action: `${rec.kind}-added`, wording: `Added a ${rec.kind}`, after: nextBody, before: null };
  }
  if (rec.deleted) {
    return { ...base, action: `${rec.kind}-deleted`, wording: `Deleted a ${rec.kind}`, before: prevBody, after: null };
  }
  if (Object.keys(diff.before).length) {
    return { ...base, action: `${rec.kind}-edited`, wording: `Edited a ${rec.kind}`, before: diff.before, after: diff.after };
  }
  return null;
}

function flatten(pieces) {
  return pieces.flatMap((p) => (Array.isArray(p) ? p : [p])).filter(Boolean);
}

function labelMatches(label, pieces) {
  if (!label) return false;
  const dollars = [...String(label).matchAll(/\$\s*(-?\d[\d,]*\.?\d*)/g)].map((m) => Number(m[1].replace(/,/g, "")));
  if (!dollars.length) return true;
  const amounts = pieces.map((p) => Number(p.amount)).filter((n) => Number.isFinite(n));
  return dollars.every((d) => amounts.some((a) => Math.abs(Math.abs(a) - Math.abs(d)) < 0.005));
}

function sourceOf(rec, op, budgetId) {
  if (String(budgetId || rec.budgetId || "").startsWith("test-")) return "test";
  if (op && (op.action === "bank-import" || OP_ACTION[op.action] === "bank-import")) return "bank";
  return "app";
}

export function buildEvents({ session, landed, previousById }) {
  const groups = new Map();
  let solo = 0;
  for (const rec of landed) {
    const key = rec.op?.id ? `op:${rec.op.id}` : `solo:${solo++}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(rec);
  }
  const events = [];
  const at = now();
  const device = session.deviceName || "Device";
  const userId = session.user?.id || null;
  for (const recs of groups.values()) {
    const op = recs.find((r) => r.op)?.op || null;
    const pieces = flatten(recs.map((r) => describeRecord(r, previousById.get(r.id) || null)));
    if (!pieces.length) continue;
    const primary = pieces[0];
    const wanted = op?.action ? OP_ACTION[op.action] : null;
    const src = sourceOf(recs[0], op, primary.budgetId);
    let finalAction = primary.action;
    if (src === "bank" || wanted === "bank-import") finalAction = "bank-import";
    else if (wanted && (pieces.some((p) => p.action === wanted) || (moneyActions(wanted) && pieces.some((p) => moneyActions(p.action))))) finalAction = wanted;
    let label;
    if (src === "bank") label = `🏦 Bank sync (applied on ${device})`;
    else if (op?.label && labelMatches(op.label, pieces)) label = op.label;
    else label = pieces.length === 1 ? primary.wording : (pieces.map((p) => p.wording).join("; ") || primary.wording);
    events.push({
      household_id: session.householdId,
      budget_id: primary.budgetId,
      at,
      client_t: Math.max(...recs.map((r) => r.t || 0)),
      user_id: userId,
      device,
      source: src,
      action: finalAction,
      op_id: op?.id || null,
      label,
      target_kind: primary.targetKind,
      target_id: primary.targetId,
      category_id: primary.categoryId,
      account_id: primary.accountId,
      amount: primary.amount,
      before: primary.before == null ? null : JSON.stringify(primary.before),
      after: primary.after == null ? null : JSON.stringify(primary.after),
    });
  }
  return events;
}

function moneyActions(a) {
  return a === "money-moved" || a === "assigned" || a === "overspending-covered" || a === "auto-assigned" || a === "freed-from-future";
}
function relatedAction(got, wanted) {
  if (got === wanted) return true;
  if (moneyActions(got) && moneyActions(wanted)) return true;
  if (got.startsWith("transfer") && wanted.startsWith("transfer")) return true;
  return false;
}

export async function insertActivity(env, session, landed, previousById) {
  const events = buildEvents({ session, landed, previousById });
  if (!events.length) return 0;
  const stmts = events.map((e) => env.DB.prepare(
    `INSERT INTO activity (household_id, budget_id, at, client_t, user_id, device, source, action, op_id, label, target_kind, target_id, category_id, account_id, amount, before, after)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    e.household_id, e.budget_id, e.at, e.client_t, e.user_id, e.device, e.source, e.action, e.op_id, e.label,
    e.target_kind, e.target_id, e.category_id, e.account_id, e.amount, e.before, e.after,
  ));
  await env.DB.batch(stmts);
  return events.length;
}

/** D8: after 30 days, drop a deleted budget's activity, access rows, then the deleted_budgets row. */
export async function purgeDeletedBudgets(env, asOf = now()) {
  const cutoff = asOf - ACTIVITY_KEEP_DAYS * 86400000;
  const rows = (await env.DB.prepare("SELECT household_id, budget_id FROM deleted_budgets WHERE deleted_at < ?").bind(cutoff).all()).results || [];
  if (!rows.length) return 0;
  const stmts = [];
  for (const r of rows) {
    stmts.push(env.DB.prepare("DELETE FROM activity WHERE household_id = ? AND budget_id = ?").bind(r.household_id, r.budget_id));
    stmts.push(env.DB.prepare("DELETE FROM budget_access WHERE household_id = ? AND budget_id = ?").bind(r.household_id, r.budget_id));
    stmts.push(env.DB.prepare("DELETE FROM deleted_budgets WHERE household_id = ? AND budget_id = ?").bind(r.household_id, r.budget_id));
  }
  await env.DB.batch(stmts);
  return rows.length;
}
