/** WU-41: two-layer household + budget roles. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { budgetRole, can, canReadRecord, canWriteRecord, householdRole, legacyRole, parseScopes } from "../src/roles.js";

const rec = (kind, budgetId, extra = {}) => ({ id: `${kind}:${extra.id || budgetId}`, kind, budgetId, body: extra.body ?? { id: extra.id || budgetId }, deleted: !!extra.deleted, ...extra });

function person(household, access) {
  return {
    access,
    member: { householdRole: household, role: household, access },
  };
}

// Olivia: household Owner. Mo: member, Owner of Private, Member of Family.
// Val: member, View only on Family. Nia: member, Member of Family, No access to Private.
const Olivia = person("owner", {});
const Mo = person("member", { Family: "owner", Private: "owner" });
const Val = person("member", { Family: "viewer" });
const Nia = person("member", { Family: "member" });

const ACTIONS = ["household.read", "household.manage", "bank.manage", "bank.apply", "budget.read", "budget.write"];

test("household actions: everyone can read; only Owners manage the household and banks", () => {
  for (const p of [Olivia, Mo, Val, Nia]) assert.equal(can(p, "household.read"), true);
  assert.equal(can(Olivia, "household.manage"), true);
  assert.equal(can(Olivia, "bank.manage"), true);
  for (const p of [Mo, Val, Nia]) {
    assert.equal(can(p, "household.manage"), false);
    assert.equal(can(p, "bank.manage"), false);
    assert.equal(can(p, "bank.apply"), true);
  }
  assert.equal(householdRole(Olivia), "owner");
  for (const p of [Mo, Val, Nia]) assert.equal(householdRole(p), "member");
});

test("budgetRole: household Owners are owner everywhere, even with no budget_access row", () => {
  assert.equal(budgetRole(Olivia, "Family"), "owner");
  assert.equal(budgetRole(Olivia, "Private"), "owner");
  assert.equal(budgetRole(Olivia, "brand-new"), "owner");
  assert.equal(budgetRole(Mo, "Private"), "owner");
  assert.equal(budgetRole(Mo, "Family"), "owner");
  assert.equal(budgetRole(Val, "Family"), "viewer");
  assert.equal(budgetRole(Val, "Private"), null);
  assert.equal(budgetRole(Nia, "Family"), "member");
  assert.equal(budgetRole(Nia, "Private"), null);
});

test("person × budget × action table (read, write, delete header, change bankLinks)", () => {
  const people = { Olivia, Mo, Val, Nia };
  const budgets = ["Family", "Private"];
  const expected = {
    // read, write, deleteHeader, changeBankLinks (household Owner only)
    Olivia: { Family: [true, true, true, true], Private: [true, true, true, true] },
    Mo:     { Family: [true, true, true, false], Private: [true, true, true, false] },
    Val:    { Family: [true, false, false, false], Private: [false, false, false, false] },
    Nia:    { Family: [true, true, false, false], Private: [false, false, false, false] },
  };
  for (const [name, p] of Object.entries(people)) {
    for (const budget of budgets) {
      const tx = rec("transaction", budget, { id: "t1", body: { id: "t1", amount: 5 } });
      const header = rec("budget", budget, { id: budget, body: { id: budget, name: budget } });
      const tombstone = rec("budget", budget, { id: budget, body: { id: budget }, deleted: true });
      const [expRead, expWrite, expDel, expBank] = expected[name][budget];
      assert.equal(canReadRecord(p, tx), expRead, `${name} read tx on ${budget}`);
      assert.equal(canReadRecord(p, header), expRead, `${name} read header on ${budget}`);
      assert.equal(canWriteRecord(p, tx), expWrite, `${name} write tx on ${budget}`);
      assert.equal(canWriteRecord(p, header), expWrite, `${name} write header on ${budget}`);
      assert.equal(canWriteRecord(p, tombstone), expDel, `${name} delete header on ${budget}`);
      assert.equal(householdRole(p) === "owner", expBank, `${name} change bankLinks (household Owner)`);
    }
  }
});

test("Nia gets false for everything on Private", () => {
  const tx = rec("transaction", "Private", { id: "t", body: { amount: 9 } });
  const header = rec("budget", "Private", { id: "Private", body: { id: "Private", name: "Private" } });
  const tombstone = rec("budget", "Private", { deleted: true, body: { id: "Private" } });
  assert.equal(canReadRecord(Nia, tx), false);
  assert.equal(canReadRecord(Nia, header), false);
  assert.equal(canWriteRecord(Nia, tx), false);
  assert.equal(canWriteRecord(Nia, header), false);
  assert.equal(canWriteRecord(Nia, tombstone), false);
  assert.equal(budgetRole(Nia, "Private"), null);
});

test("legacyRole: owner / viewer-only / member", () => {
  assert.equal(legacyRole(Olivia), "owner");
  assert.equal(legacyRole(Val), "viewer");
  assert.equal(legacyRole(Mo), "member");
  assert.equal(legacyRole(Nia), "member");
  assert.equal(legacyRole(person("member", { Family: "viewer", Private: "member" })), "member");
});

test("parseScopes no longer reads category scopes (D11)", () => {
  assert.equal(parseScopes({ categories: { Family: ["c1"] } }), null);
  assert.deepEqual(parseScopes({ budgets: ["Family"], categories: { Family: ["c1"] } }), { budgets: ["Family"] });
  assert.equal(parseScopes(null), null);
});

// Silence unused
void ACTIONS;
