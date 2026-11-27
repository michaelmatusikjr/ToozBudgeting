import { test } from "node:test";
import assert from "node:assert/strict";
import { freshBudgetShell, addAccount, addCategory, addTransaction, normalizeBudget } from "../js/mutate.js?v=154";
import { accountBalances } from "../js/calc.js?v=154";

function fixture() {
  let b = normalizeBudget(freshBudgetShell("Test", "u1"));
  b = addAccount(b, { name: "Checking", type: "checking", balance: 1000 });
  b = addAccount(b, { name: "Savings", type: "savings", balance: 500 });
  b = { ...b, categoryGroups: [{ id: "g1", name: "Everyday" }] };
  b = addCategory(b, { name: "Groceries", groupId: "g1" }).budget;
  b = addCategory(b, { name: "Dining Out", groupId: "g1" }).budget;
  const chk = b.accounts[0].id;
  const sav = b.accounts[1].id;
  const groceries = b.categories.find((c) => c.name === "Groceries").id;
  const dining = b.categories.find((c) => c.name === "Dining Out").id;
  return { b, chk, sav, groceries, dining };
}

test("a split transaction stores both parts and they add up to the amount", () => {
  const { b, chk, groceries, dining } = fixture();
  const res = addTransaction(b, {
    date: "2026-11-27",
    payee: "Costco",
    amount: 40,
    accountId: chk,
    splits: [
      { categoryId: groceries, amount: 25 },
      { categoryId: dining, amount: 15 },
    ],
  });
  assert.equal(res.error, undefined);
  const tx = res.budget.transactions.find((t) => t.payee === "Costco");
  assert.ok(tx);
  assert.equal(tx.type, "expense");
  assert.equal(tx.amount, 40);
  assert.equal(tx.splits.length, 2);
  assert.deepEqual(tx.splits.map((s) => s.amount), [25, 15]);
  assert.deepEqual(tx.splits.map((s) => s.categoryId), [groceries, dining]);
  assert.equal(accountBalances(res.budget)[chk], 1000 - 40);
});

test("a transfer made from the form shows on both accounts", () => {
  const { b, chk, sav } = fixture();
  const before = accountBalances(b);
  const res = addTransaction(b, {
    date: "2026-11-27",
    payee: "",
    amount: 75,
    accountId: chk,
    transferAccountId: sav,
    type: "transfer",
  });
  assert.equal(res.error, undefined);
  const transfers = res.budget.transactions.filter((t) => t.type === "transfer");
  assert.equal(transfers.length, 2);
  const out = transfers.find((t) => t.accountId === chk);
  const inn = transfers.find((t) => t.accountId === sav);
  assert.ok(out && inn);
  assert.equal(out.transferAccountId, sav);
  assert.equal(inn.transferAccountId, chk);
  assert.equal(out.transferLinkId, inn.transferLinkId);
  assert.equal(out.amount, -75);
  assert.equal(inn.amount, 75);
  const after = accountBalances(res.budget);
  assert.equal(after[chk], before[chk] - 75);
  assert.equal(after[sav], before[sav] + 75);
});
