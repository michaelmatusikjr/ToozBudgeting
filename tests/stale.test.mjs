import { test } from "node:test";
import assert from "node:assert/strict";
import { freshBudgetShell, addAccount, addCreditCard, addTransaction, normalizeBudget } from "../js/mutate.js?v=154";
import { staleReconcile, lastReconciledDate, daysSince } from "../js/calc.js?v=154";

function fixture() {
  let b = normalizeBudget(freshBudgetShell("Test", "u1"));
  b = addAccount(b, { name: "Checking", type: "checking", balance: 1000 });
  b = addCreditCard(b, { name: "Visa", balance: 50 }).budget || addCreditCard(b, { name: "Visa", balance: 50 });
  if (!b.creditCards) {
    // addCreditCard may return budget directly
  }
  const chk = b.accounts[0].id;
  const card = (b.creditCards || [])[0]?.id;
  return { b, chk, card };
}

test("daysSince counts whole days between two dates", () => {
  assert.equal(daysSince("2026-11-01", "2026-11-27"), 26);
  assert.equal(daysSince("2026-11-27", "2026-11-27"), 0);
});

test("lastReconciledDate uses a reconciled transaction when the account has no date", () => {
  const { b, chk } = fixture();
  const withTx = {
    ...b,
    accounts: b.accounts.map((a) => a.id === chk ? { ...a, reconciledDate: null, lastReconciledDisplay: null } : a),
    transactions: [
      { id: "t1", date: "2026-11-20", payee: "Kroger", amount: 12, type: "expense", accountId: chk, reconciled: true },
    ],
  };
  assert.equal(lastReconciledDate(withTx, chk), "2026-11-20");
});

test("lastReconciledDate prefers the latest of the account date and any reconciled transaction", () => {
  const { b, chk } = fixture();
  const withBoth = {
    ...b,
    accounts: b.accounts.map((a) => a.id === chk ? { ...a, reconciledDate: "2026-10-01" } : a),
    transactions: [
      { id: "t1", date: "2026-11-15", payee: "Kroger", amount: 12, type: "expense", accountId: chk, reconciled: true },
    ],
  };
  assert.equal(lastReconciledDate(withBoth, chk), "2026-11-15");
});

test("an account with a recent reconciled transaction is not stale, even with no reconciledDate", () => {
  const { b, chk } = fixture();
  const withTx = {
    ...b,
    accounts: b.accounts.map((a) => ({ ...a, reconciledDate: null, lastReconciledDisplay: null })),
    creditCards: (b.creditCards || []).map((c) => ({ ...c, reconciledDate: "2026-11-20" })),
    transactions: [
      ...(b.transactions || []),
      { id: "t1", date: "2026-11-20", payee: "Kroger", amount: 12, type: "expense", accountId: chk, reconciled: true },
    ],
  };
  const stale = staleReconcile(withTx, "2026-11-27");
  assert.equal(stale.some((s) => s.id === chk), false);
});

test("an account last reconciled 31 days ago is stale; 29 days ago is not", () => {
  const { b, chk } = fixture();
  const old = {
    ...b,
    accounts: b.accounts.map((a) => a.id === chk ? { ...a, reconciledDate: "2026-10-27" } : a),
    creditCards: (b.creditCards || []).map((c) => ({ ...c, reconciledDate: "2026-11-01" })),
    transactions: (b.transactions || []).map((t) => ({ ...t, reconciled: false })),
  };
  assert.ok(staleReconcile(old, "2026-11-27").some((s) => s.id === chk));
  const recent = {
    ...old,
    accounts: old.accounts.map((a) => a.id === chk ? { ...a, reconciledDate: "2026-10-29" } : a),
  };
  assert.equal(staleReconcile(recent, "2026-11-27").some((s) => s.id === chk), false);
});

test("a reconciled transaction 31 days ago still counts, so a later account date can keep it fresh", () => {
  const { b, chk } = fixture();
  const budget = {
    ...b,
    accounts: b.accounts.map((a) => a.id === chk ? { ...a, reconciledDate: "2026-11-10", lastReconciledDisplay: "2026-10-01" } : a),
    creditCards: (b.creditCards || []).map((c) => ({ ...c, reconciledDate: "2026-11-10" })),
    transactions: [
      { id: "t-old", date: "2026-10-01", payee: "Old", amount: 5, type: "expense", accountId: chk, reconciled: true },
    ],
  };
  assert.equal(lastReconciledDate(budget, chk), "2026-11-10");
  assert.equal(staleReconcile(budget, "2026-11-27").some((s) => s.id === chk), false);
});
