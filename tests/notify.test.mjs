import { test } from "node:test";
import assert from "node:assert/strict";
import { collectReminders } from "../js/notify.js?v=154";

const month = "2026-11";
const budget = {
  accounts: [{ id: "chk", name: "Checking", lastReconciled: "2020-01-01" }],
  creditCards: [],
  categories: [{ id: "rent", name: "Rent", dueDay: 1, leadDays: 3, reminderTime: "08:00" }],
  transactions: [],
  reminders: [{ id: "custom-1", kind: "custom", title: "Custom ping", body: "hi", date: "2026-11-27" }],
  monthlyBudgets: {},
  inflows: {},
};

test("collectReminders never returns rta, bill, or custom reminders", () => {
  const rules = collectReminders(budget, month);
  assert.ok(!rules.some((r) => r.kind === "rta"));
  assert.ok(!rules.some((r) => r.kind === "bill"));
  assert.ok(!rules.some((r) => r.kind === "custom"));
  assert.ok(!rules.some((r) => r.id === "custom-1"));
  assert.ok(!rules.some((r) => String(r.id || "").startsWith("bill:")));
  assert.ok(!rules.some((r) => String(r.id || "").startsWith("rta:")));
});

function baseBudget() {
  return {
    accounts: [{ id: "chk", name: "Checking" }],
    creditCards: [],
    categories: [],
    payees: [],
    transactions: [],
    rejectedMerges: [],
    mergeExcludeWords: ["TST*"],
    pendingDuplicates: [],
    monthlyBudgets: {},
    inflows: {},
  };
}

test("collectReminders includes possible payee merges and marks them panel-only", () => {
  const budget = baseBudget();
  budget.payees = [
    { id: "p1", name: "Starbucks", canonicalName: "Starbucks" },
    { id: "p2", name: "Starbucks #12", canonicalName: "Starbucks #12" },
  ];
  budget.transactions = [
    { id: "t1", type: "expense", amount: 5, accountId: "chk", originalPayee: "Starbucks", payee: "Starbucks" },
    { id: "t2", type: "expense", amount: 6, accountId: "chk", originalPayee: "Starbucks #12", payee: "Starbucks #12" },
  ];
  const rules = collectReminders(budget, month);
  const merge = rules.find((r) => r.kind === "merge");
  assert.ok(merge, "expected a merge suggestion alert");
  assert.equal(merge.id, "merge-suggestions");
  assert.equal(merge.panelOnly, true);
  assert.match(merge.title, /1 payee merge suggestion$/);
  assert.equal(merge.action.label, "Review Merge Suggestions");
  assert.ok(!rules.some((r) => r.kind === "fuzzy"));
});

test("collectReminders includes pending fuzzy duplicates and marks them panel-only", () => {
  const budget = baseBudget();
  budget.transactions = [
    { id: "e1", type: "expense", amount: 12, accountId: "chk", date: "2026-11-02", originalPayee: "Store", payee: "Store" },
    { id: "n1", type: "expense", amount: 12, accountId: "chk", date: "2026-11-03", originalPayee: "Store", payee: "Store" },
  ];
  budget.pendingDuplicates = [
    { newTxId: "n1", existingTxId: "e1" },
    { newTxId: "missing", existingTxId: "e1" },
  ];
  const rules = collectReminders(budget, month);
  const fuzzy = rules.find((r) => r.kind === "fuzzy");
  assert.ok(fuzzy, "expected a fuzzy duplicate alert");
  assert.equal(fuzzy.id, "fuzzy-duplicates");
  assert.equal(fuzzy.panelOnly, true);
  assert.equal(fuzzy.title, "Potential duplicate transaction found");
  assert.match(fuzzy.body, /^1 transaction may be duplicated/);
  assert.equal(fuzzy.action.label, "Review Duplicates");
  const dropped = { ...budget, transactions: budget.transactions.filter((t) => t.id !== "n1") };
  assert.ok(!collectReminders(dropped, month).some((r) => r.kind === "fuzzy"));
});
