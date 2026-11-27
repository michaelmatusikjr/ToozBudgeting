import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, grantAccess } from "./helpers.mjs";
import { purgeDeletedBudgets, ACTIVITY_KEEP_DAYS } from "../src/activity.js";

const rec = (id, kind, body, t, extra = {}) => ({
  id, kind, body, t, dev: extra.dev || "devA", deleted: extra.deleted || false,
  budgetId: extra.budgetId || body?.id || "Private",
  ...extra,
});

async function people(t) {
  const olivia = await t.signIn("mickey@example.com", { name: "Olivia" });
  for (const email of ["mo@example.com", "val@example.com", "nia@example.com"]) {
    await t.call("POST", "/household/invites", { email, role: "member" }, olivia.auth);
  }
  const mo = await t.signIn("mo@example.com", { name: "Mo" });
  const val = await t.signIn("val@example.com", { name: "Val" });
  const nia = await t.signIn("nia@example.com", { name: "Nia" });
  await t.call("POST", "/sync/push", { records: [
    rec("budget:Private", "budget", { id: "Private", name: "Private" }, 1, { budgetId: "Private" }),
    rec("tx:p1", "transaction", { id: "p1", payee: "Coffee", amount: 5, categoryId: "dining", accountId: "chk" }, 2, { budgetId: "Private" }),
    rec("tx:p2", "transaction", { id: "p2", payee: 'Shop, "Inc"', amount: 9, categoryId: "groceries", accountId: "sav", note: "=1+1" }, 3, { budgetId: "Private" }),
  ] }, mo.auth);
  grantAccess(t, { userId: val.me.user.id, budgetId: "Private", role: "viewer" });
  grantAccess(t, { userId: nia.me.user.id, budgetId: "Private", role: "member" });
  return { olivia, mo, val, nia };
}

test("Mo and Olivia can read Private activity; Val, Nia and other Members get 404", async () => {
  const t = setup();
  const { olivia, mo, val, nia } = await people(t);
  const o = await t.call("GET", "/budgets/Private/activity", undefined, olivia.auth);
  const m = await t.call("GET", "/budgets/Private/activity", undefined, mo.auth);
  assert.equal(o.status, 200);
  assert.equal(m.status, 200);
  assert.ok(o.data.events.length >= 2);
  assert.ok(m.data.events.length >= 2);
  assert.equal((await t.call("GET", "/budgets/Private/activity", undefined, val.auth)).status, 404);
  assert.equal((await t.call("GET", "/budgets/Private/activity", undefined, nia.auth)).status, 404);
  assert.equal((await t.call("GET", "/budgets/Private/activity.csv", undefined, nia.auth)).status, 404);
  assert.equal((await t.call("GET", "/budgets/missing/activity", undefined, mo.auth)).status, 404);
});

test("every filter works alone and combined; paging returns each row once", async () => {
  const t = setup();
  const { mo } = await people(t);
  const all = (await t.call("GET", "/budgets/Private/activity?limit=100", undefined, mo.auth)).data.events;
  const byAction = (await t.call("GET", "/budgets/Private/activity?action=categorized", undefined, mo.auth)).data.events;
  assert.ok(byAction.every((e) => e.action === "categorized") || byAction.length === 0);
  const added = (await t.call("GET", "/budgets/Private/activity?action=transaction-added", undefined, mo.auth)).data.events;
  assert.ok(added.length >= 2);
  assert.ok(added.every((e) => e.action === "transaction-added"));

  const byUser = (await t.call("GET", `/budgets/Private/activity?user=${mo.me.user.id}`, undefined, mo.auth)).data.events;
  assert.ok(byUser.length);
  assert.ok(byUser.every((e) => e.userId === mo.me.user.id));

  const byCat = (await t.call("GET", "/budgets/Private/activity?category=dining", undefined, mo.auth)).data.events;
  assert.ok(byCat.length);
  assert.ok(byCat.every((e) => e.categoryId === "dining"));

  const byAcct = (await t.call("GET", "/budgets/Private/activity?account=sav", undefined, mo.auth)).data.events;
  assert.ok(byAcct.every((e) => e.accountId === "sav"));

  const byTarget = (await t.call("GET", "/budgets/Private/activity?target=p1", undefined, mo.auth)).data.events;
  assert.ok(byTarget.every((e) => e.targetId === "p1"));

  const times = all.map((e) => e.at);
  const mid = times[Math.floor(times.length / 2)];
  const fromF = (await t.call("GET", `/budgets/Private/activity?from=${Math.min(...times)}`, undefined, mo.auth)).data.events;
  const toF = (await t.call("GET", `/budgets/Private/activity?to=${mid}`, undefined, mo.auth)).data.events;
  assert.ok(fromF.length);
  assert.ok(toF.every((e) => e.at <= mid));

  const combined = (await t.call("GET", `/budgets/Private/activity?action=transaction-added&user=${mo.me.user.id}&account=chk`, undefined, mo.auth)).data.events;
  assert.ok(combined.every((e) => e.action === "transaction-added" && e.userId === mo.me.user.id && e.accountId === "chk"));

  const page1 = await t.call("GET", "/budgets/Private/activity?limit=1", undefined, mo.auth);
  assert.equal(page1.data.events.length, 1);
  assert.equal(page1.data.more, true);
  assert.ok(page1.data.next);
  const seen = new Set([page1.data.events[0].id]);
  let cursor = page1.data.next;
  let pages = 1;
  while (cursor && pages < 50) {
    const p = await t.call("GET", `/budgets/Private/activity?limit=1&before=${cursor}`, undefined, mo.auth);
    for (const e of p.data.events) {
      assert.equal(seen.has(e.id), false, "row repeated across pages");
      seen.add(e.id);
    }
    cursor = p.data.next;
    pages++;
    if (!p.data.more) break;
  }
  assert.equal(seen.size, all.length);
});

test("CSV has the right columns and escapes commas, quotes, newlines and formula characters", async () => {
  const t = setup();
  const { mo } = await people(t);
  const hid = mo.me.household.id;
  t.DB.raw.prepare(`
    INSERT INTO activity (household_id, budget_id, at, client_t, user_id, device, source, action, label, target_kind, target_id, category_id, account_id, amount, before, after)
    VALUES (?, 'Private', ?, ?, ?, ?, 'app', 'transaction-edited', 'edited', 'transaction', ?, 'groceries', 'sav', 9, ?, ?)
  `).run(hid, Date.now() + 1000, Date.now(), mo.me.user.id, "@Desk", "hello, \"world\"", "=1+1", "+cmd\n@x");

  const res = await t.call("GET", "/budgets/Private/activity.csv", undefined, mo.auth);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") || "", /text\/csv/);
  const text = await res.res.text();
  const header = text.split(/\r?\n/)[0];
  assert.equal(header, "Date/time,Person,Action,Target,Category,Account,Amount,Before,After,Device,Source");
  assert.match(text, /"hello, ""world"""/);
  assert.match(text, /'=1\+1/);
  assert.match(text, /"'\+cmd\n@x"/);
  assert.match(text, /'@Desk/);
  assert.match(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/);
});

test("a deleted budget's log is exportable for 30 days, then 404", async () => {
  const t = setup();
  const { mo, olivia, nia } = await people(t);
  const del = await t.call("POST", "/sync/push", { records: [rec("budget:Private", "budget", null, 99, { budgetId: "Private", deleted: true })] }, mo.auth);
  assert.equal(del.data.applied, 1);

  const still = await t.call("GET", "/budgets/Private/activity", undefined, mo.auth);
  assert.equal(still.status, 200);
  assert.ok(still.data.events.length);
  assert.equal((await t.call("GET", "/budgets/Private/activity.csv", undefined, olivia.auth)).status, 200);
  assert.equal((await t.call("GET", "/budgets/Private/activity", undefined, nia.auth)).status, 404);

  const listed = await t.call("GET", "/budgets/deleted", undefined, mo.auth);
  assert.equal(listed.status, 200);
  assert.ok(listed.data.budgets.some((b) => b.id === "Private"));
  assert.ok(listed.data.budgets.find((b) => b.id === "Private").daysLeft <= 30);
  assert.equal((await t.call("GET", "/budgets/deleted", undefined, nia.auth)).data.budgets.length, 0);

  const now = Date.now();
  t.DB.raw.prepare("UPDATE deleted_budgets SET deleted_at = ? WHERE budget_id = 'Private'").run(now - (ACTIVITY_KEEP_DAYS + 1) * 86400000);
  await purgeDeletedBudgets(t.env, now);
  assert.equal((await t.call("GET", "/budgets/Private/activity", undefined, mo.auth)).status, 404);
  assert.equal((await t.call("GET", "/budgets/Private/activity.csv", undefined, olivia.auth)).status, 404);
  assert.equal((await t.call("GET", "/budgets/deleted", undefined, mo.auth)).data.budgets.length, 0);
});
