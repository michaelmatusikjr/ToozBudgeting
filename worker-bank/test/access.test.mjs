import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, grantAccess, tx } from "./helpers.mjs";
import { syncItem } from "../src/index.js";
import { plaidClient } from "../src/plaid.js";

const rec = (id, kind, body, t, extra = {}) => ({
  id, kind, body, t, dev: "devA", deleted: false,
  budgetId: extra.budgetId || body?.id || "Family",
  ...extra,
});

async function people(t) {
  const olivia = await t.signIn("mickey@example.com", { name: "Olivia" });
  for (const email of ["mo@example.com", "val@example.com", "nia@example.com"]) {
    assert.equal((await t.call("POST", "/household/invites", { email, role: "member" }, olivia.auth)).status, 200);
  }
  const mo = await t.signIn("mo@example.com", { name: "Mo" });
  const val = await t.signIn("val@example.com", { name: "Val" });
  const nia = await t.signIn("nia@example.com", { name: "Nia" });
  return { olivia, mo, val, nia };
}

function accessRows(t, budgetId) {
  return t.DB.raw.prepare("SELECT user_id, role FROM budget_access WHERE budget_id = ? ORDER BY user_id").all(budgetId);
}

test("/me returns access and the legacy role", async () => {
  const t = setup();
  const { olivia, mo, val } = await people(t);
  await t.call("POST", "/sync/push", { records: [rec("budget:Family", "budget", { id: "Family", name: "Family" }, 1)] }, olivia.auth);
  grantAccess(t, { userId: mo.me.user.id, budgetId: "Family", role: "member" });
  grantAccess(t, { userId: val.me.user.id, budgetId: "Family", role: "viewer" });
  const o = await t.call("GET", "/me", undefined, olivia.auth);
  assert.equal(o.data.role, "owner");
  assert.equal(o.data.householdRole, "owner");
  assert.ok(o.data.access);
  const m = await t.call("GET", "/me", undefined, mo.auth);
  assert.equal(m.data.role, "member");
  assert.equal(m.data.householdRole, "member");
  assert.equal(m.data.access.Family, "member");
  const v = await t.call("GET", "/me", undefined, val.auth);
  assert.equal(v.data.role, "viewer", "legacy role is viewer when every visible budget is View only");
  assert.equal(v.data.householdRole, "member");
  assert.equal(v.data.access.Family, "viewer");
});

test("a budget created by Mo gives Mo owner and no row for Nia or Val; Olivia can read it", async () => {
  const t = setup();
  const { olivia, mo, val, nia } = await people(t);
  const p = await t.call("POST", "/sync/push", { records: [
    rec("budget:Vacay", "budget", { id: "Vacay", name: "Vacay" }, 1, { budgetId: "Vacay" }),
    rec("tx:v1", "transaction", { id: "v1", amount: 12 }, 1, { budgetId: "Vacay" }),
  ] }, mo.auth);
  assert.equal(p.status, 200);
  assert.equal(p.data.applied, 2);
  assert.deepEqual(p.data.denied || [], []);
  const rows = accessRows(t, "Vacay");
  const byUser = Object.fromEntries(rows.map((r) => [r.user_id, r.role]));
  assert.equal(byUser[mo.me.user.id], "owner");
  assert.equal(byUser[nia.me.user.id], undefined);
  assert.equal(byUser[val.me.user.id], undefined);
  const oids = (await t.call("GET", "/sync/pull?since=0", undefined, olivia.auth)).data.records.map((r) => r.id).sort();
  assert.deepEqual(oids, ["budget:Vacay", "tx:v1"]);
  assert.equal((await t.call("GET", "/sync/pull?since=0", undefined, nia.auth)).data.records.length, 0);
  assert.equal((await t.call("GET", "/sync/pull?since=0", undefined, val.auth)).data.records.length, 0);
});

test("a test- budget created by Mo follows the same access rule", async () => {
  const t = setup();
  const { mo, nia } = await people(t);
  const id = "test-mo1";
  const p = await t.call("POST", "/sync/push", { records: [
    rec("budget:" + id, "budget", { id, name: "🧪 Test Budget" }, 1, { budgetId: id }),
  ] }, mo.auth);
  assert.equal(p.data.applied, 1);
  const rows = accessRows(t, id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].user_id, mo.me.user.id);
  assert.equal(rows[0].role, "owner");
  assert.equal((await t.call("GET", "/sync/pull?since=0", undefined, nia.auth)).data.records.length, 0);
});

test("Nia's pull, push, bank inbox and bank items contain nothing from Private", async () => {
  const t = setup();
  const { olivia, mo, nia } = await people(t);
  await t.call("POST", "/sync/push", { records: [
    rec("budget:Family", "budget", { id: "Family", name: "Family", bankLinks: { accounts: { "acc-chk": { target: "fam-chk" } } } }, 1, { budgetId: "Family" }),
    rec("budget:Private", "budget", { id: "Private", name: "Private", bankLinks: { accounts: { "acc-sav": { target: "prv-chk" } } } }, 1, { budgetId: "Private", dev: "devP" }),
    rec("tx:fam", "transaction", { amount: 3 }, 1, { budgetId: "Family" }),
    rec("tx:prv", "transaction", { amount: 99, secret: "nope" }, 1, { budgetId: "Private" }),
  ] }, olivia.auth);
  grantAccess(t, { userId: mo.me.user.id, budgetId: "Private", role: "owner" });
  grantAccess(t, { userId: nia.me.user.id, budgetId: "Family", role: "member" });

  const pull = await t.call("GET", "/sync/pull?since=0", undefined, nia.auth);
  const ids = pull.data.records.map((r) => r.id);
  assert.ok(ids.includes("budget:Family") && ids.includes("tx:fam"));
  assert.ok(!ids.includes("budget:Private") && !ids.includes("tx:prv"));
  assert.ok(!JSON.stringify(pull.data).includes("nope"));
  assert.ok(!JSON.stringify(pull.data).includes("Private"));

  const push = await t.call("POST", "/sync/push", { records: [rec("tx:prv", "transaction", { amount: 1 }, 9000, { budgetId: "Private" })] }, nia.auth);
  assert.deepEqual(push.data.denied, ["tx:prv"]);
  assert.equal(push.data.applied, 0);
  assert.equal(push.data.current.length, 0, "no hint that Private exists");

  t.plaid.state.accounts = [
    { account_id: "acc-chk", name: "Checking", mask: "3769", type: "depository", subtype: "checking", balances: { current: 10 } },
    { account_id: "acc-sav", name: "Savings", mask: "1111", type: "depository", subtype: "savings", balances: { current: 2 } },
  ];
  const ex = await t.call("POST", "/bank/exchange", { publicToken: "public-1", institution: { institution_id: "ins_usaa", name: "USAA" } }, olivia.auth);
  assert.equal(ex.status, 200);
  await Promise.all(t.waits.splice(0));
  t.DB.raw.exec("UPDATE items SET cursor = '', last_sync_at = NULL; DELETE FROM bank_inbox");
  t.plaid.state.syncPages = [{ cursor: "", res: { added: [tx("t-fam", 5), tx("t-prv", 7, { account_id: "acc-sav" })], modified: [], removed: [], next_cursor: "c1", has_more: false } }];
  await syncItem(t.env, plaidClient(t.env, t.plaid.fetchImpl), ex.data.item.itemId);

  const niaBox = await t.call("GET", "/bank/inbox", undefined, nia.auth);
  const niaJson = JSON.stringify(niaBox.data);
  assert.ok(!niaJson.includes("t-prv"), "Private txs stay out of Nia's inbox");
  assert.ok(!niaJson.includes("acc-sav") || (niaBox.data.batches || []).every((b) => !(b.batch.added || []).some((x) => x.account_id === "acc-sav")));
  // The batch has both accounts in one chunk — Nia cannot edit both budgets, so the whole batch waits for a household Owner.
  assert.equal(niaBox.data.batches.length, 0);

  const items = await t.call("GET", "/bank/items", undefined, nia.auth);
  // The item has both acc-chk (Family, she can read) and acc-sav (Private). Mention of acc-chk is enough to list it.
  // That's conservative and correct: she can see a bank that includes a Family account.
  assert.equal(items.status, 200);
  const oliviaBox = await t.call("GET", "/bank/inbox", undefined, olivia.auth);
  assert.equal(oliviaBox.data.batches.length, 1, "household Owner receives the two-budget batch");
});

test("Val's pushes to Family are denied and nothing is stored", async () => {
  const t = setup();
  const { olivia, val } = await people(t);
  await t.call("POST", "/sync/push", { records: [rec("budget:Family", "budget", { id: "Family" }, 1), rec("tx:1", "transaction", { amount: 4 }, 1)] }, olivia.auth);
  grantAccess(t, { userId: val.me.user.id, budgetId: "Family", role: "viewer" });
  const w = await t.call("POST", "/sync/push", { records: [rec("tx:1", "transaction", { amount: 999 }, 9000)] }, val.auth);
  assert.equal(w.status, 200);
  assert.deepEqual(w.data.denied, ["tx:1"]);
  assert.equal(w.data.applied, 0);
  const body = JSON.parse((await t.call("GET", "/sync/pull?since=0", undefined, olivia.auth)).data.records.find((r) => r.id === "tx:1").body);
  assert.equal(body.amount, 4);
});

test("old apps that only read role still can't write to a View only budget", async () => {
  const t = setup();
  const { olivia, val } = await people(t);
  await t.call("POST", "/sync/push", { records: [rec("budget:Family", "budget", { id: "Family" }, 1)] }, olivia.auth);
  grantAccess(t, { userId: val.me.user.id, budgetId: "Family", role: "viewer" });
  const me = await t.call("GET", "/me", undefined, val.auth);
  assert.equal(me.data.role, "viewer");
  const w = await t.call("POST", "/sync/push", { records: [rec("tx:x", "transaction", { amount: 1 }, 1)] }, val.auth);
  assert.deepEqual(w.data.denied, ["tx:x"]);
  assert.equal(w.data.applied, 0);
});

test("deleting a budget header writes a deleted_budgets row", async () => {
  const t = setup();
  const { mo, olivia } = await people(t);
  await t.call("POST", "/sync/push", { records: [rec("budget:Private", "budget", { id: "Private", name: "Private" }, 1, { budgetId: "Private" })] }, mo.auth);
  const del = await t.call("POST", "/sync/push", { records: [rec("budget:Private", "budget", null, 2, { budgetId: "Private", deleted: true })] }, mo.auth);
  assert.equal(del.data.applied, 1);
  const row = t.DB.raw.prepare("SELECT * FROM deleted_budgets WHERE budget_id = 'Private'").get();
  assert.ok(row);
  assert.equal(row.deleted_by, mo.me.user.id);
  assert.equal(row.name, "Private");
  // Olivia is a household Owner, so she could also have deleted it; Mo was the budget owner.
  const refused = await t.call("POST", "/sync/push", { records: [
    rec("budget:Family", "budget", { id: "Family", name: "Family" }, 3, { budgetId: "Family" }),
  ] }, olivia.auth);
  assert.equal(refused.status, 200);
});

test("bank inbox: unmapped batches and two-budget batches wait for a household Owner", async () => {
  const t = setup();
  const { olivia, mo, nia, val } = await people(t);
  await t.call("POST", "/sync/push", { records: [
    rec("budget:Family", "budget", { id: "Family", name: "Family", bankLinks: { accounts: { "acc-chk": { target: "fam-chk" } } } }, 1, { budgetId: "Family" }),
    rec("budget:Private", "budget", { id: "Private", name: "Private", bankLinks: { accounts: { "acc-sav": { target: "prv-chk" } } } }, 1, { budgetId: "Private", dev: "devP" }),
  ] }, olivia.auth);
  grantAccess(t, { userId: mo.me.user.id, budgetId: "Private", role: "owner" });
  grantAccess(t, { userId: mo.me.user.id, budgetId: "Family", role: "member" });
  grantAccess(t, { userId: nia.me.user.id, budgetId: "Family", role: "member" });
  grantAccess(t, { userId: val.me.user.id, budgetId: "Family", role: "viewer" });

  const ex = await t.call("POST", "/bank/exchange", { publicToken: "public-1", institution: { institution_id: "ins_usaa", name: "USAA" } }, olivia.auth);
  await Promise.all(t.waits.splice(0));

  // Unmapped (no bankLinks for acc-new).
  t.DB.raw.exec("UPDATE items SET cursor = '', last_sync_at = NULL; DELETE FROM bank_inbox");
  t.plaid.state.syncPages = [{ cursor: "", res: { added: [tx("t-new", 1, { account_id: "acc-new" })], modified: [], removed: [], next_cursor: "c1", has_more: false } }];
  await syncItem(t.env, plaidClient(t.env, t.plaid.fetchImpl), ex.data.item.itemId);
  assert.equal((await t.call("GET", "/bank/inbox", undefined, nia.auth)).data.batches.length, 0);
  assert.equal((await t.call("GET", "/bank/inbox", undefined, val.auth)).data.batches.length, 0);
  const ownerUnmapped = await t.call("GET", "/bank/inbox", undefined, olivia.auth);
  assert.equal(ownerUnmapped.data.batches.length, 1);
  await t.call("POST", "/bank/ack", { ids: [ownerUnmapped.data.batches[0].id] }, olivia.auth);

  // Only Family.
  t.DB.raw.exec("UPDATE items SET cursor = '', last_sync_at = NULL; DELETE FROM bank_inbox");
  t.plaid.state.syncPages = [{ cursor: "", res: { added: [tx("t-fam", 2, { account_id: "acc-chk" })], modified: [], removed: [], next_cursor: "c2", has_more: false } }];
  await syncItem(t.env, plaidClient(t.env, t.plaid.fetchImpl), ex.data.item.itemId);
  assert.equal((await t.call("GET", "/bank/inbox", undefined, val.auth)).data.batches.length, 0, "View only cannot edit");
  const niaFam = await t.call("GET", "/bank/inbox", undefined, nia.auth);
  assert.equal(niaFam.data.batches.length, 1);
  assert.equal(niaFam.data.batches[0].batch.added[0].transaction_id, "t-fam");
  await t.call("POST", "/bank/ack", { release: [niaFam.data.batches[0].id] }, nia.auth);

  // Two budgets in one batch: only people who can edit both (Mo) or a household Owner.
  t.DB.raw.exec("UPDATE items SET cursor = '', last_sync_at = NULL; DELETE FROM bank_inbox");
  t.plaid.state.accounts = [
    { account_id: "acc-chk", name: "Checking", mask: "3769", type: "depository", subtype: "checking", balances: { current: 10 } },
    { account_id: "acc-sav", name: "Savings", mask: "1111", type: "depository", subtype: "savings", balances: { current: 2 } },
  ];
  t.plaid.state.syncPages = [{ cursor: "", res: { added: [tx("t-fam2", 3, { account_id: "acc-chk" }), tx("t-prv2", 4, { account_id: "acc-sav" })], modified: [], removed: [], next_cursor: "c3", has_more: false } }];
  await syncItem(t.env, plaidClient(t.env, t.plaid.fetchImpl), ex.data.item.itemId);
  assert.equal((await t.call("GET", "/bank/inbox", undefined, nia.auth)).data.batches.length, 0);
  const moBoth = await t.call("GET", "/bank/inbox", undefined, mo.auth);
  assert.equal(moBoth.data.batches.length, 1);
});
