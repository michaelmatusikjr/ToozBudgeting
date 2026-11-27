/** Pure helpers for household sync, shared by the store and tests. */

/** Record kinds that belong to the shared household budget. "app" and "user" stay on the device. */
export const SYNC_KINDS = new Set([
  "budget", "account", "creditCard", "categoryGroup", "category", "transaction", "payee",
  "assignment", "assignmentCell", "inflow", "note", "reminder",
]);

export const cellId = (budgetId, month, categoryId) => `mbc:${budgetId}:${month}:${categoryId}`;

/** Order edits: later t wins; on a tie the higher device id wins, the same rule the server uses. */
export function newer(a, b) {
  if (a.t !== b.t) return a.t > b.t;
  return String(a.dev || "") > String(b.dev || "");
}

/**
 * Should the server's copy replace what this device has? Yes, unless this device has an edit the server
 * hasn't confirmed yet that is newer. That edit gets pushed next and wins there too.
 */
export function remoteWins(local, remote) {
  if (!local || !local.dirty) return true;
  return !newer(local, remote);
}
