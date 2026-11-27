import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, grantAccess, tx } from "./helpers.mjs";
import { syncItem } from "../src/index.js";
import { plaidClient } from "../src/plaid.js";

const rec = (id, kind, body, t, extra = {}) => ({
  id, kind, body, t, dev: extra.dev || "devA", deleted: false,
  budgetId: extra.budgetId || body?.id,
  ...extra,
});

const SECRETS = {
  Private: { name: "Private", payee: "SECRET-PRIVATE-PAYEE", amount: 12345.67, id: "Private" },
  "test-mo": { name: "🧪 Test Budget", payee: "SECRET-TEST-PAYEE", amount: 777.77, id: "test-mo" },
  Family: { name: "Family", payee: "FAMILY-PAYEE", amount: 1.23, id: "Family" },
};

function leaks(data, budgetKeys) {
  const text = JSON.stringify(data);
  const found = [];
  for (const key of budgetKeys) {
    const s = SECRETS[key];
    if (text.includes(s.payee)) found.push(`${key} payee`);
    if (text.includes(String(s.amount))) found.push(`${key} amount`);
    if (key !== "Family" && (text.includes(`"${s.id}"`) || text.includes(`budget:${s.id}`) || text.includes(s.name))) {
      // "Private" / test-mo name or id
      if (text.includes(s.payee) || text.includes(String(s.amount)) || text.includes(s.name) || new RegExp(`budget:${s.id}|="${s.id}"|:"${s.id}"`).test(text)) {
        if (text.includes(s.name) || text.includes(s.payee) || text.includes(String(s.amount))) found.push(`${key} name/id`);
      }
    }
  }
  return [...new Set(found)];
}

function assertNoLeak(data, unread, label) {
  const found = [];
  const text = typeof data === "string" ? data : JSON.stringify(data);
  for (const key of unread) {
    const s = SECRETS[key];
    if (text.includes(s.payee)) found.push(`${key} payee`);
    if (text.includes(String(s.amount))) found.push(`${key} amount`);
    if (text.includes(s.name) && s.name !== "Family") found.push(`${key} name`);
  }
  assert.deepEqual(found, [], `${label} leaked ${found.join(", ")}: ${text.slice(0, 300)}`);
}

async function fixture(t) {
  const olivia = await t.signIn("mickey@example.com", { name: "Olivia" });
  for (const email of ["mo@example.com", "val@example.com", "nia@example.com"]) {
    await t.call("POST", "/household/invites", { email, role: "member" }, olivia.auth);
  }
  const mo = await t.signIn("mo@example.com", { name: "Mo" });
  const val = await t.signIn("val@example.com", { name: "Val" });
  const nia = await t.signIn("nia@example.com", { name: "Nia" });

  await t.call("POST", "/sync/push", { records: [
    rec("budget:Family", "budget", { id: "Family", name: "Family" }, 1, { budgetId: "Family" }),
    rec("tx:fam", "transaction", { id: "fam", payee: SECRETS.Family.payee, amount: SECRETS.Family.amount }, 1, { budgetId: "Family" }),
  ] }, olivia.auth);
  await t.call("POST", "/sync/push", { records: [
    rec("budget:Private", "budget", { id: "Private", name: "Private" }, 2, { budgetId: "Private" }),
    rec("tx:prv", "transaction", { id: "prv", payee: SECRETS.Private.payee, amount: SECRETS.Private.amount }, 2, { budgetId: "Private" }),
    rec("budget:test-mo", "budget", { id: "test-mo", name: "🧪 Test Budget" }, 3, { budgetId: "test-mo" }),
    rec("tx:tst", "transaction", { id: "tst", payee: SECRETS["test-mo"].payee, amount: SECRETS["test-mo"].amount }, 3, { budgetId: "test-mo" }),
  ] }, mo.auth);
  grantAccess(t, { userId: mo.me.user.id, budgetId: "Family", role: "member" });
  grantAccess(t, { userId: val.me.user.id, budgetId: "Family", role: "viewer" });
  grantAccess(t, { userId: nia.me.user.id, budgetId: "Family", role: "member" });

  return { olivia, mo, val, nia };
}

const can = {
  Olivia: { Family: "owner", Private: "owner", "test-mo": "owner", household: "owner" },
  Mo: { Family: "member", Private: "owner", "test-mo": "owner", household: "member" },
  Val: { Family: "viewer", Private: null, "test-mo": null, household: "member" },
  Nia: { Family: "member", Private: null, "test-mo": null, household: "member" },
};
const unread = (name) => Object.entries(can[name]).filter(([k, v]) => k !== "household" && !v).map(([k]) => k);
const canEdit = (name, b) => can[name][b] === "owner" || can[name][b] === "member";
const canOwn = (name, b) => can[name][b] === "owner";

test("access matrix: Olivia, Mo, Val, Nia × Family, Private, test budget × every endpoint, with no leaks", async () => {
  const t = setup();
  const people = await fixture(t);

  const titled = { olivia: "Olivia", mo: "Mo", val: "Val", nia: "Nia" };
  for (const [key, session] of Object.entries(people)) {
    const name = titled[key] || key;
    const auth = session.auth;
    const unreadBudgets = unread(name);

    // /me
    const me = await t.call("GET", "/me", undefined, auth);
    assert.equal(me.status, 200, `${name} /me`);
    const access = me.data.access || {};
    if (can[name].household === "owner") {
      // household Owners are owners everywhere, even with no row; access map is just stored rows
    } else {
      for (const b of unreadBudgets) assert.equal(access[b], undefined, `${name} /me.access must not list ${b}`);
    }
    assertNoLeak(me.data, unreadBudgets, `${name} /me`);

    // pull
    const pull = await t.call("GET", "/sync/pull?since=0", undefined, auth);
    assert.equal(pull.status, 200, `${name} pull`);
    const ids = (pull.data.records || []).map((r) => r.id);
    for (const b of unreadBudgets) {
      assert.equal(ids.includes("budget:" + b), false, `${name} pull has budget:${b}`);
    }
    assertNoLeak(pull.data, unreadBudgets, `${name} pull`);

    // push to each budget
    for (const b of ["Family", "Private", "test-mo"]) {
      const r = await t.call("POST", "/sync/push", { records: [rec(`tx:probe-${name}-${b === "Family" ? "fam" : b === "Private" ? "prv" : "tst"}`, "transaction", { id: `probe-${name}`, amount: 0.01, payee: "Probe" }, Date.now(), { budgetId: b })] }, auth);
      assert.equal(r.status, 200, `${name} push ${b} status`);
      if (canEdit(name, b)) {
        assert.equal(r.data.applied, 1, `${name} should write ${b}`);
        assert.deepEqual(r.data.denied || [], []);
      } else {
        assert.equal(r.data.applied, 0, `${name} must not write ${b}`);
        assert.ok((r.data.denied || []).length);
        assert.equal((r.data.current || []).length, 0, `${name} push ${b} current must not hint`);
        assertNoLeak(r.data, unreadBudgets, `${name} push ${b}`);
      }
    }

    // activity + csv + access
    for (const b of ["Family", "Private", "test-mo"]) {
      const act = await t.call("GET", `/budgets/${b}/activity`, undefined, auth);
      const csv = await t.call("GET", `/budgets/${b}/activity.csv`, undefined, auth);
      const acc = await t.call("GET", `/budgets/${b}/access`, undefined, auth);
      const put = await t.call("PUT", `/budgets/${b}/access`, { access: {} }, auth);
      const expect = canOwn(name, b) ? 200 : 404;
      assert.equal(act.status, expect, `${name} activity ${b}`);
      assert.equal(csv.status, expect, `${name} csv ${b}`);
      assert.equal(acc.status, expect, `${name} access GET ${b}`);
      assert.equal(put.status, expect, `${name} access PUT ${b}`);
      if (expect === 404) {
        assertNoLeak(act.data, unreadBudgets, `${name} activity 404 ${b}`);
        const csvText = csv.res ? await csv.res.clone().text() : JSON.stringify(csv.data);
        assertNoLeak(csvText, unreadBudgets, `${name} csv 404 ${b}`);
        assertNoLeak(acc.data, unreadBudgets, `${name} access 404 ${b}`);
        assertNoLeak(put.data, unreadBudgets, `${name} put 404 ${b}`);
      }
    }

    // deleted
    const deleted = await t.call("GET", "/budgets/deleted", undefined, auth);
    assert.equal(deleted.status, 200);
    assertNoLeak(deleted.data, unreadBudgets, `${name} deleted`);

    // members + invites
    const members = await t.call("GET", "/household/members", undefined, auth);
    assert.equal(members.status, 200, `${name} members`);
    assertNoLeak(members.data, unreadBudgets, `${name} members`);
    const invite = await t.call("POST", "/household/invites", { email: `${name.toLowerCase()}-friend@example.com`, householdRole: "member" }, auth);
    if (can[name].household === "owner") assert.equal(invite.status, 200, `${name} invite`);
    else assert.equal(invite.status, 403, `${name} invite refused`);
    assertNoLeak(invite.data, unreadBudgets, `${name} invite`);
  }

  // bank inbox + items with a Private-only account and a Family account
  const { olivia, mo, val, nia } = people;
  await t.call("POST", "/sync/push", { records: [rec("budget:Family", "budget", { id: "Family", name: "Family", bankLinks: { accounts: { "acc-chk": { target: "fam-chk" } } } }, Date.now(), { budgetId: "Family" })] }, olivia.auth);
  await t.call("POST", "/sync/push", { records: [rec("budget:Private", "budget", { id: "Private", name: "Private", bankLinks: { accounts: { "acc-sav": { target: "prv-chk" } } } }, Date.now(), { budgetId: "Private" })] }, mo.auth);
  t.plaid.state.accounts = [
    { account_id: "acc-chk", name: "Checking", mask: "3769", type: "depository", subtype: "checking", balances: { current: 10 } },
    { account_id: "acc-sav", name: "SECRET-BANK", mask: "9999", type: "depository", subtype: "savings", balances: { current: SECRETS.Private.amount } },
  ];
  const ex = await t.call("POST", "/bank/exchange", { publicToken: "public-1", institution: { institution_id: "ins_usaa", name: "USAA" } }, olivia.auth);
  await Promise.all(t.waits.splice(0));
  t.DB.raw.exec("UPDATE items SET cursor = '', last_sync_at = NULL; DELETE FROM bank_inbox");
  t.plaid.state.syncPages = [{ cursor: "", res: { added: [tx("t-fam", 2, { account_id: "acc-chk" }), tx("t-prv", SECRETS.Private.amount, { account_id: "acc-sav", name: SECRETS.Private.payee })], modified: [], removed: [], next_cursor: "c1", has_more: false } }];
  await syncItem(t.env, plaidClient(t.env, t.plaid.fetchImpl), ex.data.item.itemId);

  for (const [key, session] of Object.entries(people)) {
    const name = titled[key] || key;
    const box = await t.call("GET", "/bank/inbox", undefined, session.auth);
    const items = await t.call("GET", "/bank/items", undefined, session.auth);
    assert.equal(box.status, 200, `${name} inbox`);
    assert.equal(items.status, 200, `${name} items`);
    const unreadBudgets = unread(name);
    assertNoLeak(box.data, unreadBudgets, `${name} inbox`);
    const itemText = JSON.stringify(items.data);
    if (!can[name].Private) {
      assert.equal(itemText.includes("SECRET-BANK"), false, `${name} items listed a Private bank account`);
    }
    assertNoLeak(items.data, unreadBudgets, `${name} items`);
  }
});
