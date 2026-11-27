import { test } from "node:test";
import assert from "node:assert/strict";
import { setup } from "./helpers.mjs";
import { purgeDeletedBudgets, ACTIVITY_KEEP_DAYS } from "../src/activity.js";
import { runScheduled } from "../src/index.js";

const rec = (id, kind, body, t, extra = {}) => ({
  id, kind, body, t, dev: extra.dev || "devA", deleted: extra.deleted || false,
  budgetId: extra.budgetId || "Family",
  op: extra.op,
  ...extra,
});

async function ownerOf(t) {
  const owner = await t.signIn();
  await t.call("POST", "/sync/push", { records: [rec("budget:Family", "budget", { id: "Family", name: "Family", moneyMoveLog: [] }, 1)] }, owner.auth);
  t.DB.raw.exec("DELETE FROM activity");
  return owner;
}

function rows(t, budgetId = "Family") {
  return t.DB.raw.prepare("SELECT * FROM activity WHERE budget_id = ? ORDER BY id").all(budgetId);
}

test("transaction added, edited, deleted, categorized, approved, reconciled, unreconciled, and transfers", async () => {
  const t = setup();
  const owner = await ownerOf(t);
  const a = await t.call("POST", "/sync/push", { records: [rec("tx:1", "transaction", { id: "1", payee: "Whole Foods", amount: 134, accountId: "chk", type: "expense" }, 10)] }, owner.auth);
  assert.equal(a.data.applied, 1);
  let ev = rows(t);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].action, "transaction-added");
  assert.equal(ev[0].user_id, owner.me.user.id);
  assert.equal(ev[0].account_id, "chk");
  assert.equal(ev[0].amount, 134);
  assert.match(ev[0].label, /Whole Foods/);
  assert.equal(ev[0].source, "app");

  await t.call("POST", "/sync/push", { records: [rec("tx:1", "transaction", { id: "1", payee: "Whole Foods", amount: 134, accountId: "chk", type: "expense", categoryId: "groceries" }, 20)] }, owner.auth);
  ev = rows(t);
  assert.equal(ev.at(-1).action, "categorized");
  assert.equal(ev.at(-1).category_id, "groceries");
  const before = JSON.parse(ev.at(-1).before);
  const after = JSON.parse(ev.at(-1).after);
  assert.equal(before.categoryId, null);
  assert.equal(after.categoryId, "groceries");

  await t.call("POST", "/sync/push", { records: [rec("tx:1", "transaction", { id: "1", payee: "Whole Foods", amount: 134, accountId: "chk", type: "expense", categoryId: "groceries", categoryConfirmed: false }, 30)] }, owner.auth);
  await t.call("POST", "/sync/push", { records: [rec("tx:1", "transaction", { id: "1", payee: "Whole Foods", amount: 134, accountId: "chk", type: "expense", categoryId: "groceries", categoryConfirmed: true }, 40)] }, owner.auth);
  assert.equal(rows(t).at(-1).action, "approved");

  await t.call("POST", "/sync/push", { records: [rec("tx:1", "transaction", { id: "1", payee: "Whole Foods", amount: 134, accountId: "chk", type: "expense", categoryId: "groceries", categoryConfirmed: true, reconciled: true }, 50)] }, owner.auth);
  assert.equal(rows(t).at(-1).action, "reconciled");
  await t.call("POST", "/sync/push", { records: [rec("tx:1", "transaction", { id: "1", payee: "Whole Foods", amount: 134, accountId: "chk", type: "expense", categoryId: "groceries", categoryConfirmed: true, reconciled: false }, 60)] }, owner.auth);
  assert.equal(rows(t).at(-1).action, "unreconciled");

  await t.call("POST", "/sync/push", { records: [rec("tx:1", "transaction", { id: "1", payee: "Whole Foods", amount: 140, accountId: "chk", type: "expense", categoryId: "groceries", categoryConfirmed: true, reconciled: false }, 70)] }, owner.auth);
  assert.equal(rows(t).at(-1).action, "transaction-edited");

  await t.call("POST", "/sync/push", { records: [rec("tx:2", "transaction", { id: "2", type: "transfer", amount: 50, accountId: "chk", transferAccountId: "sav", transferLinkId: "L1" }, 80)] }, owner.auth);
  assert.equal(rows(t).at(-1).action, "transfer-added");
  await t.call("POST", "/sync/push", { records: [rec("tx:2", "transaction", { id: "2", type: "transfer", amount: 55, accountId: "chk", transferAccountId: "sav", transferLinkId: "L1" }, 90)] }, owner.auth);
  assert.equal(rows(t).at(-1).action, "transfer-edited");

  await t.call("POST", "/sync/push", { records: [rec("tx:1", "transaction", null, 100, { deleted: true })] }, owner.auth);
  assert.equal(rows(t).at(-1).action, "transaction-deleted");
});

test("assigned, money moved, overspending covered, auto-assigned, freed from future, goal, account, card, category, group, note", async () => {
  const t = setup();
  const owner = await ownerOf(t);

  await t.call("POST", "/sync/push", { records: [rec("cell:1", "assignmentCell", { month: "2026-11", categoryId: "groceries", amount: 200 }, 10)] }, owner.auth);
  let ev = rows(t).at(-1);
  assert.equal(ev.action, "assigned");
  assert.equal(ev.category_id, "groceries");
  assert.equal(ev.amount, 200);
  assert.deepEqual(JSON.parse(ev.after), { amount: 200, month: "2026-11", categoryId: "groceries" });

  const log = (type, entries) => ({ id: "Family", name: "Family", moneyMoveLog: [{ type, month: "2026-11", ts: "2026-11-27T00:00:00.000Z", entries }] });
  await t.call("POST", "/sync/push", { records: [rec("budget:Family", "budget", log("move", [{ from: "dining", to: "groceries", amount: 25 }]), 20)] }, owner.auth);
  ev = rows(t).at(-1);
  assert.equal(ev.action, "money-moved");
  assert.equal(ev.amount, 25);

  await t.call("POST", "/sync/push", { records: [rec("budget:Family", "budget", { ...log("move", [{ from: "dining", to: "groceries", amount: 25 }]), moneyMoveLog: [
    { type: "move", month: "2026-11", ts: "2026-11-27T00:00:00.000Z", entries: [{ from: "dining", to: "groceries", amount: 25 }] },
    { type: "cover", month: "2026-11", ts: "2026-11-27T01:00:00.000Z", entries: [{ from: "rta", to: "groceries", amount: 10 }] },
  ] }, 30)] }, owner.auth);
  ev = rows(t).at(-1);
  assert.equal(ev.action, "overspending-covered");

  await t.call("POST", "/sync/push", { records: [rec("budget:Family", "budget", { id: "Family", name: "Family", moneyMoveLog: [
    { type: "move", month: "2026-11", ts: "2026-11-27T00:00:00.000Z", entries: [{ from: "dining", to: "groceries", amount: 25 }] },
    { type: "cover", month: "2026-11", ts: "2026-11-27T01:00:00.000Z", entries: [{ from: "rta", to: "groceries", amount: 10 }] },
    { type: "assign", month: "2026-11", ts: "2026-11-27T02:00:00.000Z", entries: [{ from: "rta", to: "groceries", amount: 40 }] },
  ] }, 40, { op: { id: "auto1", action: "auto-assign", label: "Auto-assigned $40.00" } })] }, owner.auth);
  ev = rows(t).at(-1);
  assert.equal(ev.action, "auto-assigned");
  assert.equal(ev.label, "Auto-assigned $40.00");

  await t.call("POST", "/sync/push", { records: [rec("budget:Family", "budget", { id: "Family", name: "Family", moneyMoveLog: [
    { type: "move", month: "2026-11", ts: "2026-11-27T00:00:00.000Z", entries: [{ from: "dining", to: "groceries", amount: 25 }] },
    { type: "cover", month: "2026-11", ts: "2026-11-27T01:00:00.000Z", entries: [{ from: "rta", to: "groceries", amount: 10 }] },
    { type: "assign", month: "2026-11", ts: "2026-11-27T02:00:00.000Z", entries: [{ from: "rta", to: "groceries", amount: 40 }] },
    { type: "move", month: "2026-12", ts: "2026-11-27T03:00:00.000Z", entries: [{ from: "vacation", to: "rta", amount: 15 }] },
  ] }, 50)] }, owner.auth);
  ev = rows(t).at(-1);
  assert.equal(ev.action, "freed-from-future");

  await t.call("POST", "/sync/push", { records: [rec("category:groceries", "category", { id: "groceries", name: "Groceries" }, 60)] }, owner.auth);
  ev = rows(t).at(-1);
  assert.equal(ev.action, "category-added");
  await t.call("POST", "/sync/push", { records: [rec("category:groceries", "category", { id: "groceries", name: "Groceries", goal: { type: "monthly", target: 400 } }, 70)] }, owner.auth);
  ev = rows(t).at(-1);
  assert.equal(ev.action, "goal-changed");
  assert.deepEqual(JSON.parse(ev.after).goal, { type: "monthly", target: 400 });
  await t.call("POST", "/sync/push", { records: [rec("category:groceries", "category", { id: "groceries", name: "Food", goal: { type: "monthly", target: 400 } }, 80)] }, owner.auth);
  ev = rows(t).at(-1);
  assert.equal(ev.action, "category-renamed");
  await t.call("POST", "/sync/push", { records: [rec("category:groceries", "category", { id: "groceries", name: "Food", goal: { type: "monthly", target: 400 }, archived: true }, 90)] }, owner.auth);
  ev = rows(t).at(-1);
  assert.equal(ev.action, "category-archived");
  await t.call("POST", "/sync/push", { records: [rec("category:old", "category", { id: "old", name: "Old" }, 91)] }, owner.auth);
  await t.call("POST", "/sync/push", { records: [rec("category:old", "category", null, 92, { deleted: true })] }, owner.auth);
  ev = rows(t).at(-1);
  assert.equal(ev.action, "category-deleted");

  await t.call("POST", "/sync/push", { records: [rec("account:chk", "account", { id: "chk", name: "Checking" }, 100)] }, owner.auth);
  assert.equal(rows(t).at(-1).action, "account-added");
  await t.call("POST", "/sync/push", { records: [rec("account:chk", "account", { id: "chk", name: "Main checking" }, 110)] }, owner.auth);
  assert.equal(rows(t).at(-1).action, "account-renamed");
  await t.call("POST", "/sync/push", { records: [rec("account:chk", "account", { id: "chk", name: "Main checking", archived: true }, 120)] }, owner.auth);
  assert.equal(rows(t).at(-1).action, "account-archived");
  await t.call("POST", "/sync/push", { records: [rec("account:chk", "account", null, 130, { deleted: true })] }, owner.auth);
  assert.equal(rows(t).at(-1).action, "account-deleted");

  await t.call("POST", "/sync/push", { records: [rec("card:amex", "creditCard", { id: "amex", name: "Amex" }, 140)] }, owner.auth);
  assert.equal(rows(t).at(-1).action, "card-added");
  await t.call("POST", "/sync/push", { records: [rec("group:bills", "categoryGroup", { id: "bills", name: "Bills" }, 150)] }, owner.auth);
  assert.equal(rows(t).at(-1).action, "group-added");
  await t.call("POST", "/sync/push", { records: [rec("notes:2026-11", "note", { month: "2026-11", notes: { groceries: "stock up" } }, 160)] }, owner.auth);
  ev = rows(t).at(-1);
  assert.equal(ev.action, "note-changed");
});

test("an edit that loses to a newer one is not logged", async () => {
  const t = setup();
  const owner = await ownerOf(t);
  await t.call("POST", "/household/invites", { email: "wife@example.com", role: "owner" }, owner.auth);
  const wife = await t.signIn("wife@example.com");
  await t.call("POST", "/sync/push", { records: [rec("tx:1", "transaction", { id: "1", amount: 7, memo: "wife" }, 3000, { dev: "devW" })] }, wife.auth);
  const before = rows(t).length;
  const early = await t.call("POST", "/sync/push", { records: [rec("tx:1", "transaction", { id: "1", amount: 6, memo: "mickey" }, 2000)] }, owner.auth);
  assert.equal(early.data.applied, 0);
  assert.equal(rows(t).length, before, "losing edit left no activity row");
});

test("a forged label is replaced by the server wording; old-app pushes (no op) still log", async () => {
  const t = setup();
  const owner = await ownerOf(t);
  await t.call("POST", "/sync/push", { records: [rec("budget:Family", "budget", {
    id: "Family", name: "Family",
    moneyMoveLog: [{ type: "move", month: "2026-11", ts: "2026-11-27T04:00:00.000Z", entries: [{ from: "a", to: "b", amount: 500 }] }],
  }, 10, { op: { id: "m1", action: "move", label: "moved $5" } })] }, owner.auth);
  const ev = rows(t).at(-1);
  assert.equal(ev.action, "money-moved");
  assert.equal(ev.amount, 500);
  assert.notEqual(ev.label, "moved $5");
  assert.match(ev.label, /\$500\.00/);

  t.DB.raw.exec("DELETE FROM activity");
  const old = await t.call("POST", "/sync/push", { records: [rec("tx:9", "transaction", { id: "9", amount: 3, payee: "Shop" }, 20)] }, owner.auth);
  assert.equal(old.data.applied, 1);
  const logged = rows(t);
  assert.equal(logged.length, 1);
  assert.equal(logged[0].action, "transaction-added");
  assert.equal(logged[0].op_id, null);
  assert.ok(logged[0].label);
});

test("bank imports are logged with source=bank; test- budgets use source=test", async () => {
  const t = setup();
  const owner = await ownerOf(t);
  await t.call("POST", "/sync/push", { records: [rec("tx:b1", "transaction", { id: "b1", amount: 8, payee: "Plaid Store", accountId: "chk" }, 10, {
    op: { id: "bank-1", action: "bank-import", label: "ignored" },
  })] }, owner.auth);
  const ev = rows(t).at(-1);
  assert.equal(ev.source, "bank");
  assert.equal(ev.action, "bank-import");
  assert.equal(ev.label, "🏦 Bank sync (applied on Test)");

  await t.call("POST", "/sync/push", { records: [rec("budget:test-1", "budget", { id: "test-1", name: "🧪 Test Budget" }, 20, { budgetId: "test-1" })] }, owner.auth);
  const testRows = t.DB.raw.prepare("SELECT * FROM activity WHERE budget_id = 'test-1'").all();
  assert.ok(testRows.length);
  assert.ok(testRows.every((r) => r.source === "test"));
});

test("the cron removes a deleted budget's log after 30 days and not before", async () => {
  const t = setup();
  const owner = await ownerOf(t);
  await t.call("POST", "/sync/push", { records: [
    rec("budget:Gone", "budget", { id: "Gone", name: "Gone" }, 10, { budgetId: "Gone" }),
    rec("tx:g", "transaction", { id: "g", amount: 1 }, 10, { budgetId: "Gone" }),
  ] }, owner.auth);
  await t.call("POST", "/sync/push", { records: [rec("budget:Gone", "budget", null, 20, { budgetId: "Gone", deleted: true })] }, owner.auth);
  const hid = owner.me.household.id;
  const fresh = t.DB.raw.prepare("SELECT * FROM activity WHERE budget_id = 'Gone'").all();
  assert.ok(fresh.length);
  const row = t.DB.raw.prepare("SELECT * FROM deleted_budgets WHERE budget_id = 'Gone'").get();
  assert.ok(row);

  const now = Date.now();
  await purgeDeletedBudgets(t.env, now); // not yet 30 days
  assert.ok(t.DB.raw.prepare("SELECT * FROM deleted_budgets WHERE budget_id = 'Gone'").get());
  assert.ok(t.DB.raw.prepare("SELECT * FROM activity WHERE budget_id = 'Gone'").all().length);

  t.DB.raw.prepare("UPDATE deleted_budgets SET deleted_at = ? WHERE budget_id = 'Gone'").run(now - (ACTIVITY_KEEP_DAYS + 1) * 86400000);
  await runScheduled(t.env, { fetchImpl: t.plaid.fetchImpl });
  assert.equal(t.DB.raw.prepare("SELECT * FROM deleted_budgets WHERE budget_id = 'Gone'").get(), undefined);
  assert.equal(t.DB.raw.prepare("SELECT * FROM activity WHERE budget_id = 'Gone'").all().length, 0);
  assert.equal(t.DB.raw.prepare("SELECT * FROM budget_access WHERE budget_id = 'Gone'").all().length, 0);
  // Family's log is untouched
  assert.ok(t.DB.raw.prepare("SELECT * FROM records WHERE budget_id = 'Family' AND deleted = 0").all().length);
});
