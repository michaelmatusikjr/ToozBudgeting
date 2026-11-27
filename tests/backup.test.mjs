import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { importData, exportData } from "../js/store.js?v=154";

const ref = JSON.parse(readFileSync(new URL("../../ref-testdata.json", import.meta.url), "utf8"));

test("importTemplates in a JSX backup become csvMappings", () => {
  const template = { columns: ["date", "payee", "amount"], dateFormat: "ymd" };
  const parsed = {
    budgets: [{
      id: "b1", name: "Demo", accounts: [], creditCards: [], categoryGroups: [],
      categories: [], transactions: [], payees: [],
      importTemplates: { checking: template },
    }],
  };
  const state = importData(parsed);
  assert.deepEqual(state.budgets[0].csvMappings.checking, template);
});

test("ref-testdata.json imports and round-trips through export/import", () => {
  const first = importData(ref);
  assert.ok(first.budgets.length >= 1);
  assert.equal(first.setupComplete, true);
  const snapshot = exportData(first);
  const second = importData(snapshot);
  assert.equal(second.budgets.length, first.budgets.length);
  assert.equal(second.budgets[0].id, first.budgets[0].id);
  assert.equal(second.budgets[0].transactions.length, first.budgets[0].transactions.length);
  assert.deepEqual(second.budgets[0].csvMappings || {}, first.budgets[0].csvMappings || {});
});
