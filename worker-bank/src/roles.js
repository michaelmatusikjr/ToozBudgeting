/**
 * Two-layer permissions.
 *
 * Household roles: owner or member.
 *   household.read  — everyone in the household
 *   household.manage, bank.manage — household Owners
 *
 * Budget roles (per person, per budget): owner, member, viewer (View only), or no row (No access).
 * Household Owners are Owner of every budget, even without a budget_access row (D2).
 *
 * The legacy `role` field returned to old apps is computed by legacyRole(): owner for household
 * Owners, viewer when every budget they can see is View only, otherwise member.
 */
// Household roles in use are owner and member. "viewer" remains assignable on
// invites and memberships until WU-43, and session loading treats it as a household member.
export const ROLES = ["owner", "member", "viewer"];
export const BUDGET_ROLES = ["owner", "member", "viewer"];

const HOUSEHOLD_ACTIONS = {
  owner: new Set(["household.read", "household.manage", "budget.read", "budget.write", "bank.view", "bank.apply", "bank.manage"]),
  member: new Set(["household.read", "budget.read", "budget.write", "bank.view", "bank.apply"]),
};

export const SYNC_KINDS = new Set([
  "budget", "account", "creditCard", "categoryGroup", "category", "transaction", "payee",
  "assignment", "assignmentCell", "inflow", "note", "reminder",
]);

/** Fields on a budget header that only household Owners may change. The server keeps the stored value otherwise. */
export const OWNER_ONLY_BUDGET_FIELDS = ["bankLinks"];

function asSession(sessionOrMember) {
  if (sessionOrMember && sessionOrMember.member) return sessionOrMember;
  return { member: sessionOrMember || {}, access: sessionOrMember?.access || {} };
}

export function householdRole(sessionOrMember) {
  const member = asSession(sessionOrMember).member;
  const r = member.householdRole || member.role;
  if (r === "owner") return "owner";
  if (r) return "member";
  return null;
}

export function can(sessionOrMember, action) {
  const role = householdRole(sessionOrMember);
  return !!role && !!HOUSEHOLD_ACTIONS[role]?.has(action);
}

/** Still used by invite payloads until WU-43. Category scopes are no longer read (D11). */
export function parseScopes(raw) {
  if (!raw) return null;
  let s = raw;
  if (typeof raw === "string") { try { s = JSON.parse(raw); } catch { return null; } }
  if (!s || typeof s !== "object") return null;
  const out = {};
  if (Array.isArray(s.budgets)) out.budgets = s.budgets.map(String).slice(0, 200);
  return Object.keys(out).length ? out : null;
}

export function budgetRole(sessionOrMember, budgetId) {
  const session = asSession(sessionOrMember);
  if (householdRole(session) === "owner") return "owner";
  if (budgetId == null || budgetId === "") return null;
  const access = session.access || session.member.access || {};
  return access[budgetId] || null;
}

function bodyOf(rec) {
  if (rec.bodyObj !== undefined) return rec.bodyObj;
  try { rec.bodyObj = typeof rec.body === "string" ? JSON.parse(rec.body) : rec.body; } catch { rec.bodyObj = null; }
  return rec.bodyObj;
}

export function recordBudgetId(rec) {
  const bid = rec.budgetId ?? rec.budget_id ?? null;
  if (bid != null && bid !== "") return bid;
  if (rec.kind === "budget") {
    const body = bodyOf(rec) || {};
    if (body.id) return body.id;
    const id = String(rec.id || "");
    if (id.startsWith("budget:")) return id.slice("budget:".length);
    return id || null;
  }
  return null;
}

/** rec: { id, kind, budgetId|budget_id, body (string or object), deleted } */
export function canReadRecord(sessionOrMember, rec) {
  return budgetRole(sessionOrMember, recordBudgetId(rec)) != null;
}

export function canWriteRecord(sessionOrMember, rec) {
  if (!SYNC_KINDS.has(rec.kind)) return false;
  const role = budgetRole(sessionOrMember, recordBudgetId(rec));
  if (role !== "owner" && role !== "member") return false;
  if (rec.kind === "budget" && rec.deleted) return role === "owner";
  return true;
}

/** Legacy household-style role for old apps (WU-41 step 5). */
export function legacyRole(sessionOrMember) {
  const session = asSession(sessionOrMember);
  if (householdRole(session) === "owner") return "owner";
  const roles = Object.values(session.access || session.member.access || {});
  if (roles.length && roles.every((r) => r === "viewer")) return "viewer";
  return "member";
}
