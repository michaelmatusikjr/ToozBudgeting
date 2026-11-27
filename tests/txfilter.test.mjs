import test from "node:test";
import assert from "node:assert/strict";

if (!globalThis.window || !globalThis.window.addEventListener) {
  globalThis.window = new Proxy(globalThis, {
    get(target, prop) {
      if (prop === "addEventListener" || prop === "removeEventListener") return () => {};
      return target[prop];
    },
  });
}
if (!globalThis.document) {
  globalThis.document = { documentElement: { style: { setProperty() {} } }, addEventListener() {}, readyState: "complete", body: {}, createElement: () => ({ style: {}, append() {}, addEventListener() {} }) };
}
const mem = new Map();
if (!globalThis.localStorage) {
  globalThis.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
    removeItem: (k) => mem.delete(k),
  };
}
if (!globalThis.indexedDB) {
  globalThis.indexedDB = { open: () => ({ result: null, addEventListener() {}, set onerror(fn) {}, set onsuccess(fn) {}, set onupgradeneeded(fn) {} }) };
}

const { filterTxRows, needsAttention, UNCONFIRMED_FILTER, blankTxFilters } = await import("../js/views/transactions.js?v=154");

const budget = {
  accounts: [{ id: "a1", name: "Checking" }],
  creditCards: [{ id: "cc1", name: "Visa" }],
  categories: [{ id: "c1", name: "Groceries" }],
  transactions: [
    { id: "t1", date: "2026-11-02", type: "expense", amount: 12.34, accountId: "a1", categoryId: "c1", originalPayee: "Kroger", reconciled: false },
    { id: "t2", date: "2026-11-03", type: "expense", amount: 20, accountId: "a1", categoryId: "", originalPayee: "Unknown", reconciled: false },
    { id: "t3", date: "2026-11-04", type: "expense", amount: 5, accountId: "a1", categoryId: "c1", originalPayee: "Kroger", reconciled: true },
    { id: "t4", date: "2026-10-15", type: "income", amount: 100, accountId: "a1", originalPayee: "Paycheck", reconciled: false },
  ],
};

test("reconciled rows are hidden by default and shown when enabled", () => {
  const hidden = filterTxRows(budget, { showReconciled: false });
  assert.equal(hidden.some((t) => t.id === "t3"), false);
  assert.equal(hidden.length, 3);
  const shown = filterTxRows(budget, { showReconciled: true });
  assert.equal(shown.some((t) => t.id === "t3"), true);
  assert.equal(shown.length, 4);
});

test("needs-attention banner matches uncategorized expenses", () => {
  assert.equal(needsAttention(budget.transactions[1]), true);
  assert.equal(needsAttention(budget.transactions[0]), false);
  const rows = filterTxRows(budget, { filters: { ...blankTxFilters(), categoryId: UNCONFIRMED_FILTER } });
  assert.deepEqual(rows.map((t) => t.id), ["t2"]);
});

test("search chips filter by payee, month, and amount digits", () => {
  const payee = filterTxRows(budget, { chips: [{ type: "payee", value: "Kroger" }], showReconciled: true });
  assert.deepEqual(payee.map((t) => t.id).sort(), ["t1", "t3"]);
  const month = filterTxRows(budget, { chips: [{ type: "month", value: "2026-10" }] });
  assert.deepEqual(month.map((t) => t.id), ["t4"]);
  const amt = filterTxRows(budget, { chips: [{ type: "amount_digits", value: "1234" }] });
  assert.deepEqual(amt.map((t) => t.id), ["t1"]);
});
