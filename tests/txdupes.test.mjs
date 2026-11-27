import { test } from "node:test";
import assert from "node:assert/strict";
import { freshBudgetShell, addAccount, addCategory, addTransaction, normalizeBudget, resolveDuplicatePair, isLocked } from "../js/mutate.js?v=154";
import { accountBalances } from "../js/calc.js?v=154";

function fixture() {
  let b = normalizeBudget(freshBudgetShell("Test", "u1"));
  b = addAccount(b, { name: "Checking", type: "checking", balance: 1000 });
  b = { ...b, categoryGroups: [{ id: "g1", name: "Everyday" }] };
  b = addCategory(b, { name: "Groceries", groupId: "g1" }).budget;
  const chk = b.accounts[0].id;
  const groceries = b.categories.find((c) => c.name === "Groceries").id;
  return { b, chk, groceries };
}

function twoSimilar(b, chk, groceries) {
  let res = addTransaction(b, { date: "2026-11-21", payee: "Whole Foods Market", amount: 138, accountId: chk, categoryId: groceries });
  const existing = res.budget.transactions.find((t) => t.payee === "Whole Foods Market");
  res = addTransaction(res.budget, { date: "2026-11-21", payee: "Whole Foods Market", amount: 138, accountId: chk, categoryId: groceries, note: "Imported" });
  const added = res.budget.transactions.filter((t) => t.payee === "Whole Foods Market");
  const newer = added.find((t) => t.id !== existing.id);
  const budget = {
    ...res.budget,
    pendingDuplicates: [{ newTxId: newer.id, existingTxId: existing.id }],
  };
  return { budget, existing, newer, chk };
}

test("Keep Both leaves both transactions and drops the pair", () => {
  const { b, chk, groceries } = fixture();
  const { budget, existing, newer } = twoSimilar(b, chk, groceries);
  const out = resolveDuplicatePair(budget, budget.pendingDuplicates[0], "both");
  assert.equal(out.error, undefined);
  const ids = out.budget.transactions.map((t) => t.id);
  assert.ok(ids.includes(existing.id));
  assert.ok(ids.includes(newer.id));
  assert.equal((out.budget.pendingDuplicates || []).length, 0);
});

test("Keep Left keeps the new transaction and deletes the existing one", () => {
  const { b, chk, groceries } = fixture();
  const { budget, existing, newer, chk: accountId } = twoSimilar(b, chk, groceries);
  const before = accountBalances(budget)[accountId];
  const out = resolveDuplicatePair(budget, budget.pendingDuplicates[0], "left");
  assert.equal(out.error, undefined);
  const ids = out.budget.transactions.map((t) => t.id);
  assert.equal(ids.includes(existing.id), false);
  assert.equal(ids.includes(newer.id), true);
  assert.equal((out.budget.pendingDuplicates || []).length, 0);
  assert.equal(accountBalances(out.budget)[accountId], before + 138);
});

test("Keep Right keeps the existing transaction and deletes the new one", () => {
  const { b, chk, groceries } = fixture();
  const { budget, existing, newer } = twoSimilar(b, chk, groceries);
  const out = resolveDuplicatePair(budget, budget.pendingDuplicates[0], "right");
  assert.equal(out.error, undefined);
  const ids = out.budget.transactions.map((t) => t.id);
  assert.equal(ids.includes(newer.id), false);
  assert.equal(ids.includes(existing.id), true);
  assert.equal((out.budget.pendingDuplicates || []).length, 0);
});

test("resolving the first pair leaves a later pair in the list", () => {
  const { b, chk, groceries } = fixture();
  const first = twoSimilar(b, chk, groceries);
  let res = addTransaction(first.budget, { date: "2026-11-22", payee: "Shell Gas Station", amount: 52, accountId: chk, categoryId: groceries });
  const existing2 = res.budget.transactions.find((t) => t.payee === "Shell Gas Station");
  res = addTransaction(res.budget, { date: "2026-11-22", payee: "Shell Gas Station", amount: 52, accountId: chk, categoryId: groceries });
  const newer2 = res.budget.transactions.filter((t) => t.payee === "Shell Gas Station").find((t) => t.id !== existing2.id);
  const budget = {
    ...res.budget,
    pendingDuplicates: [
      { newTxId: first.newer.id, existingTxId: first.existing.id },
      { newTxId: newer2.id, existingTxId: existing2.id },
    ],
  };
  const out = resolveDuplicatePair(budget, budget.pendingDuplicates[0], "both");
  assert.equal(out.budget.pendingDuplicates.length, 1);
  assert.equal(out.budget.pendingDuplicates[0].newTxId, newer2.id);
  assert.ok(out.budget.transactions.some((t) => t.id === first.existing.id));
  assert.ok(out.budget.transactions.some((t) => t.id === first.newer.id));
});

test("Keep Left does not delete a reconciled transaction", () => {
  const { b, chk, groceries } = fixture();
  const { budget, existing, newer } = twoSimilar(b, chk, groceries);
  const locked = {
    ...budget,
    transactions: budget.transactions.map((t) => t.id === existing.id ? { ...t, reconciled: true } : t),
  };
  assert.equal(isLocked(locked, locked.transactions.find((t) => t.id === existing.id)), true);
  const out = resolveDuplicatePair(locked, locked.pendingDuplicates[0], "left");
  assert.ok(out.error);
  assert.ok(out.budget.transactions.some((t) => t.id === existing.id));
  assert.ok(out.budget.transactions.some((t) => t.id === newer.id));
  assert.equal(out.budget.pendingDuplicates.length, 1);
});
