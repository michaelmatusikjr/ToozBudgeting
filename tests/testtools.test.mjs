import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isTestBudget,
  safeCommit,
  buildTestBudget,
  applyLoadSignedIn,
  applyResetTestBudget,
  applyDeleteTestBudget,
  applyLoadGuest,
  testBudgetFromState,
} from "../js/dev/testtools.js?v=154";
import { importData } from "../js/store.js?v=154";

function realBudget(id = "real-home") {
  return { id, name: "Home", accounts: [], creditCards: [], categoryGroups: [], categories: [], transactions: [], payees: [] };
}

function mockCtx(state) {
  const ctx = {
    state,
    commits: [],
    account: { token: "t" },
    readOnly: () => false,
    commit(next, _opts) {
      ctx.commits.push(next);
      ctx.state = next;
      return next;
    },
    restore(next) {
      ctx.state = next;
    },
  };
  return ctx;
}

test("buildTestBudget returns a JSX-shaped backup with a test- id", () => {
  const backup = buildTestBudget();
  assert.equal(backup.setupComplete, true);
  assert.ok(Array.isArray(backup.budgets) && backup.budgets.length === 1);
  const b = backup.budgets[0];
  assert.equal(b.name, "🧪 Test Budget");
  assert.ok(String(b.id).startsWith("test-"));
  assert.equal(backup.activeBudgetId, b.id);
  assert.ok((b.transactions || []).length > 0);
  assert.ok((b.accounts || []).length > 0);
  assert.ok((b.categories || []).length > 0);
});

test("the test backup imports through importData", () => {
  const state = importData(buildTestBudget());
  assert.equal(state.budgets.length, 1);
  assert.ok(isTestBudget(state.budgets[0]));
  assert.equal(state.setupComplete, true);
});

test("isTestBudget only matches test- ids", () => {
  assert.equal(isTestBudget({ id: "test-abc" }), true);
  assert.equal(isTestBudget({ id: "real-home" }), false);
  assert.equal(isTestBudget(null), false);
});

test("safeCommit throws if a real budget would change", () => {
  const real = realBudget();
  const ctx = mockCtx({ budgets: [real], activeBudgetId: real.id });
  const changed = { ...real, name: "Hacked" };
  assert.throws(
    () => safeCommit(ctx, { budgets: [changed] }),
    /real budget changed/,
  );
  assert.equal(ctx.commits.length, 0);
});

test("safeCommit throws if a real budget would be added or removed", () => {
  const real = realBudget();
  const ctx = mockCtx({ budgets: [real], activeBudgetId: real.id });
  assert.throws(
    () => safeCommit(ctx, { budgets: [] }),
    /added or removed/,
  );
  const extra = realBudget("real-other");
  assert.throws(
    () => safeCommit(ctx, { budgets: [real, extra] }),
    /added or removed/,
  );
  assert.equal(ctx.commits.length, 0);
});

test("safeCommit allows adding or replacing a test budget", () => {
  const real = realBudget();
  const ctx = mockCtx({ budgets: [real], activeBudgetId: real.id, setupComplete: true });
  const testB = { id: "test-1", name: "🧪 Test Budget" };
  safeCommit(ctx, { ...ctx.state, budgets: [real, testB], activeBudgetId: testB.id });
  assert.equal(ctx.state.budgets.length, 2);
  assert.equal(ctx.state.budgets[0], real);
});

test("signed-in Load Test Data twice still leaves exactly one test budget", () => {
  const real = realBudget();
  const ctx = mockCtx({ budgets: [real], activeBudgetId: real.id, setupComplete: true, sv: 1 });
  applyLoadSignedIn(ctx);
  applyLoadSignedIn(ctx);
  const tests = ctx.state.budgets.filter(isTestBudget);
  assert.equal(tests.length, 1);
  assert.equal(ctx.state.budgets.filter((b) => !isTestBudget(b)).length, 1);
  assert.equal(ctx.state.budgets.find((b) => !isTestBudget(b)), real);
});

test("Test Wizard leaves every real budget byte-for-byte the same", () => {
  const real = realBudget();
  const snapshot = structuredClone(real);
  const ctx = mockCtx({ budgets: [real], activeBudgetId: real.id, setupComplete: true, sv: 1 });
  applyLoadSignedIn(ctx);
  applyResetTestBudget(ctx);
  const after = ctx.state.budgets.filter((b) => !isTestBudget(b));
  assert.equal(after.length, 1);
  assert.equal(after[0], real);
  assert.deepEqual(after[0], snapshot);
  assert.equal(ctx.state.setupComplete, false);
  assert.equal(ctx.state._testWizard, true);
});

test("Delete Test Budget leaves every real budget byte-for-byte the same", () => {
  const real = realBudget();
  const snapshot = structuredClone(real);
  const ctx = mockCtx({ budgets: [real], activeBudgetId: real.id, setupComplete: true, sv: 1 });
  applyLoadSignedIn(ctx);
  applyDeleteTestBudget(ctx);
  assert.equal(ctx.state.budgets.length, 1);
  assert.equal(ctx.state.budgets[0], real);
  assert.deepEqual(ctx.state.budgets[0], snapshot);
  assert.equal(isTestBudget(ctx.state.budgets[0]), false);
});

test("guest Load Test Data restores a test backup", () => {
  const ctx = mockCtx({ budgets: [], setupComplete: false });
  applyLoadGuest(ctx);
  assert.equal(ctx.state.budgets.length, 1);
  assert.ok(isTestBudget(ctx.state.budgets[0]));
  assert.equal(ctx.state.setupComplete, true);
});
