/**
 * Roles and permissions. Every server-side check goes through here, so a permissions UI can come later
 * without touching the handlers.
 *
 * owner  : everything, including members, invites, and bank logins.
 * member : reads and edits the budgets in scope; applies bank transactions; can't manage people or banks.
 * viewer : read-only on the server. Pushes are refused.
 *
 * scopes (optional, JSON on the membership): limits what a member or viewer can see.
 *   { budgets: ["budgetId", ...] }                       only these budgets
 *   { categories: { "budgetId": ["categoryId", ...] } }  within a budget, only these categories
 * null or missing means everything. Owners ignore scopes.
 */
export const ROLES = ["owner", "member", "viewer"];

const ACTIONS = {
  owner: new Set(["household.read", "household.manage", "budget.read", "budget.write", "bank.view", "bank.apply", "bank.manage"]),
  member: new Set(["household.read", "budget.read", "budget.write", "bank.view", "bank.apply"]),
  viewer: new Set(["household.read", "budget.read", "bank.view"]),
};

export const SYNC_KINDS = new Set([
  "budget", "account", "creditCard", "categoryGroup", "category", "transaction", "payee",
  "assignment", "assignmentCell", "inflow", "note", "reminder",
]);

/** Fields on a budget header that only owners may change. The server keeps the stored value otherwise. */
export const OWNER_ONLY_BUDGET_FIELDS = ["bankLinks"];

export function can(member, action) {
  return !!member && !!ACTIONS[member.role]?.has(action);
}

export function parseScopes(raw) {
  if (!raw) return null;
  let s = raw;
  if (typeof raw === "string") { try { s = JSON.parse(raw); } catch { return null; } }
  if (!s || typeof s !== "object") return null;
  const out = {};
  if (Array.isArray(s.budgets)) out.budgets = s.budgets.map(String).slice(0, 200);
  if (s.categories && typeof s.categories === "object") {
    out.categories = {};
    for (const [b, list] of Object.entries(s.categories)) if (Array.isArray(list)) out.categories[String(b)] = list.map(String).slice(0, 1000);
  }
  return Object.keys(out).length ? out : null;
}

function budgetAllowed(member, budgetId) {
  if (member.role === "owner" || !member.scopes?.budgets) return true;
  return budgetId != null && member.scopes.budgets.includes(budgetId);
}

function categoryList(member, budgetId) {
  if (member.role === "owner") return null;
  return member.scopes?.categories?.[budgetId] || null;
}

function bodyOf(rec) {
  if (rec.bodyObj !== undefined) return rec.bodyObj;
  try { rec.bodyObj = typeof rec.body === "string" ? JSON.parse(rec.body) : rec.body; } catch { rec.bodyObj = null; }
  return rec.bodyObj;
}

/** rec: { id, kind, budgetId|budget_id, body (string or object), deleted } */
export function canReadRecord(member, rec) {
  if (!can(member, "budget.read")) return false;
  const budgetId = rec.budgetId ?? rec.budget_id ?? null;
  if (!budgetAllowed(member, budgetId)) return false;
  const cats = categoryList(member, budgetId);
  if (!cats || rec.deleted) return true;
  const body = bodyOf(rec) || {};
  if (rec.kind === "category") return cats.includes(body.id);
  if (rec.kind === "assignmentCell") return cats.includes(body.categoryId);
  if (rec.kind === "transaction") {
    if (Array.isArray(body.splits) && body.splits.length) return body.splits.some((s) => cats.includes(s.categoryId));
    return cats.includes(body.categoryId);
  }
  return true;
}

export function canWriteRecord(member, rec) {
  if (!can(member, "budget.write")) return false;
  if (!SYNC_KINDS.has(rec.kind)) return false;
  if (member.role === "owner") return true;
  if (rec.kind === "budget" && rec.deleted) return false;
  return canReadRecord(member, rec);
}
