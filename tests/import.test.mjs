import { test } from "node:test";
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

const { prepareImportRows } = await import("../js/views/transactions.js?v=154");
const { guessColumnMapping } = await import("../js/csv.js?v=154");

const headers = ["Date", "Description", "Amount"];
const mapping = { dateCol: "Date", payeeCol: "Description", amountCol: "Amount", amountMode: "single", signConvention: "neg-expense", debitCol: "", creditCol: "" };
const rows = [
  headers,
  ["2026-11-01", "Kroger", "-12.34"],
  ["2026-11-02", "Payroll", "1000"],
  ["2026-11-03", "Target", "-20"],
  ["2026-11-04", "Costco", "-40"],
  ["2026-11-05", "Walmart", "-8"],
  ["2026-11-06", "Shell", "-30"],
  ["2026-11-07", "Netflix", "-15"],
  ["2026-11-08", "Spotify", "-10"],
  ["2026-11-09", "Amazon", "-22"],
  ["2026-11-10", "Uber", "-9"],
  ["2026-11-11", "Lyft", "-7"],
  ["2026-11-12", "Starbucks", "-6"],
  ["2026-11-13", "Chipotle", "-14"],
];

test("every CSV row is reviewable, not just the first 12", () => {
  const parsed = prepareImportRows(rows, headers, mapping, [], "a1");
  assert.equal(parsed.length, 13);
  assert.equal(parsed[12].payee, "Chipotle");
});

test("an existing transaction is flagged as a duplicate and pre-skipped", () => {
  const existing = [{ accountId: "a1", date: "2026-11-01", amount: 12.34, originalPayee: "Kroger", payee: "Kroger" }];
  const parsed = prepareImportRows(rows, headers, mapping, existing, "a1");
  const kroger = parsed.find((p) => p.payee === "Kroger");
  assert.equal(kroger.duplicate, true);
  assert.equal(kroger.skip, true);
  const target = parsed.find((p) => p.payee === "Target");
  assert.equal(target.duplicate, false);
  assert.equal(target.skip, false);
});

test("a saved column mapping still matches the file headers next time", () => {
  const guessed = guessColumnMapping(headers);
  const saved = { dateCol: "Date", payeeCol: "Description", amountCol: "Amount", amountMode: "single", signConvention: "neg-expense" };
  const needed = [saved.dateCol, saved.payeeCol, saved.amountCol];
  assert.ok(needed.every((col) => headers.includes(col)));
  assert.equal(guessed.dateCol, "Date");
  assert.equal(guessed.payeeCol, "Description");
  assert.equal(guessed.amountCol, "Amount");
});
