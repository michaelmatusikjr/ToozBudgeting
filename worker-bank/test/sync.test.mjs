import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, grantAccess } from "./helpers.mjs";

const rec = (id, kind, body, t, extra = {}) => ({ id, kind, budgetId: "b1", body, t, dev: "devA", deleted: false, ...extra });

async function household(t) {
  const owner = await t.signIn();
  for (const [email, role] of [["wife@example.com", "owner"], ["kid@example.com", "viewer"], ["teen@example.com", "member"]]) {
    await t.call("POST", "/household/invites", { email, role }, owner.auth);
  }
  return { owner, wife: await t.signIn("wife@example.com"), kid: await t.signIn("kid@example.com"), teen: await t.signIn("teen@example.com") };
}

test("push then pull: records round-trip and seq only moves forward", async () => {
  const t = setup();
  const { owner, wife } = await household(t);
  const p = await t.call("POST", "/sync/push", { records: [rec("budget:b1", "budget", { id: "b1", name: "Matusik Budget" }, 1000), rec("tx:1", "transaction", { id: "1", amount: 5 }, 1000)] }, owner.auth);
  assert.equal(p.status, 200);
  assert.equal(p.data.applied, 2);
  assert.equal(p.data.seq, 2);
  const pl = await t.call("GET", "/sync/pull?since=0", undefined, wife.auth);
  assert.equal(pl.data.records.length, 2);
  assert.equal(pl.data.seq, 2);
  assert.equal(JSON.parse(pl.data.records.find((r) => r.id === "tx:1").body).amount, 5);
  assert.equal((await t.call("GET", "/sync/pull?since=2", undefined, wife.auth)).data.records.length, 0);
  const me = await t.call("GET", "/me", undefined, owner.auth);
  assert.equal(me.data.household.records, 2, "household Owners see every live record they can read (the app uses this to decide whether to upload)");
  const teen = await t.signIn("teen@example.com");
  const teenMe = await t.call("GET", "/me", undefined, teen.auth);
  assert.equal(teenMe.data.household.records, 0, "members only count records in budgets they can read");
});

test("conflict: two people edit the same transaction; the later edit wins on both devices", async () => {
  const t = setup();
  const { owner, wife } = await household(t);
  await t.call("POST", "/sync/push", { records: [rec("tx:1", "transaction", { amount: 5 }, 1000)] }, owner.auth);
  const late = await t.call("POST", "/sync/push", { records: [rec("tx:1", "transaction", { amount: 7, memo: "wife" }, 3000, { dev: "devW" })] }, wife.auth);
  assert.equal(late.data.applied, 1);
  const early = await t.call("POST", "/sync/push", { records: [rec("tx:1", "transaction", { amount: 6, memo: "mickey" }, 2000)] }, owner.auth);
  assert.equal(early.data.applied, 0, "the older edit loses");
  assert.equal(early.data.current.length, 1, "and the loser gets the winner back right away");
  assert.equal(JSON.parse(early.data.current[0].body).memo, "wife");
  const tie = await t.call("POST", "/sync/push", { records: [rec("tx:1", "transaction", { amount: 8 }, 3000, { dev: "devA" })] }, owner.auth);
  assert.equal(tie.data.applied, 0, "same time: the higher device id wins, the same on every server call");
  const pl = await t.call("GET", "/sync/pull?since=0", undefined, owner.auth);
  assert.equal(JSON.parse(pl.data.records[0].body).amount, 7);
});

test("conflict: different records never collide, and a delete is a tombstone that syncs", async () => {
  const t = setup();
  const { owner, wife } = await household(t);
  await t.call("POST", "/sync/push", { records: [rec("tx:1", "transaction", { amount: 1 }, 1000), rec("tx:2", "transaction", { amount: 2 }, 1000)] }, owner.auth);
  const cursor = (await t.call("GET", "/sync/pull?since=0", undefined, wife.auth)).data.seq;
  await t.call("POST", "/sync/push", { records: [rec("tx:1", "transaction", { amount: 10 }, 2000)] }, owner.auth);
  await t.call("POST", "/sync/push", { records: [rec("tx:2", "transaction", null, 2000, { deleted: true, dev: "devW" })] }, wife.auth);
  const pl = await t.call("GET", `/sync/pull?since=${cursor}`, undefined, owner.auth);
  const byId = Object.fromEntries(pl.data.records.map((r) => [r.id, r]));
  assert.equal(JSON.parse(byId["tx:1"].body).amount, 10);
  assert.equal(byId["tx:2"].deleted, true);
});

test("pull pages by seq without skipping", async () => {
  const t = setup();
  const { owner, wife } = await household(t);
  const many = Array.from({ length: 30 }, (_, i) => rec("tx:" + i, "transaction", { i }, 1000 + i));
  await t.call("POST", "/sync/push", { records: many }, owner.auth);
  const seen = new Set();
  let since = 0;
  for (;;) {
    const r = await t.call("GET", `/sync/pull?since=${since}&limit=7`, undefined, wife.auth);
    r.data.records.forEach((x) => seen.add(x.id));
    since = r.data.seq;
    if (!r.data.more) break;
  }
  assert.equal(seen.size, 30);
});

test("viewers are read-only on the server", async () => {
  const t = setup();
  const { owner, kid } = await household(t);
  await t.call("POST", "/sync/push", { records: [rec("tx:1", "transaction", { amount: 1 }, 1000)] }, owner.auth);
  grantAccess(t, { userId: kid.me.user.id, budgetId: "b1", role: "viewer" });
  const w = await t.call("POST", "/sync/push", { records: [rec("tx:1", "transaction", { amount: 999 }, 9000)] }, kid.auth);
  assert.equal(w.status, 200);
  assert.deepEqual(w.data.denied, ["tx:1"]);
  assert.equal(w.data.applied, 0);
  const pl = await t.call("GET", "/sync/pull?since=0", undefined, kid.auth);
  assert.equal(JSON.parse(pl.data.records[0].body).amount, 1, "unchanged, and viewers can still read");
});

test("category scopes are retired: a budget member sees and edits every category (D11)", async () => {
  const t = setup();
  const { owner, teen } = await household(t);
  await t.call("POST", "/sync/push", { records: [
    rec("category:fun", "category", { id: "fun", name: "Fun money" }, 1000),
    rec("category:rent", "category", { id: "rent", name: "Rent" }, 1000),
    rec("tx:a", "transaction", { id: "a", categoryId: "fun", amount: 10 }, 1000),
    rec("tx:b", "transaction", { id: "b", categoryId: "rent", amount: 2000 }, 1000),
    rec("tx:c", "transaction", { id: "c", splits: [{ categoryId: "rent", amount: 1 }, { categoryId: "fun", amount: 2 }] }, 1000),
    rec("account:chk", "account", { id: "chk" }, 1000),
  ] }, owner.auth);
  grantAccess(t, { userId: teen.me.user.id, budgetId: "b1", role: "member" });
  const ids = (await t.call("GET", "/sync/pull?since=0", undefined, teen.auth)).data.records.map((r) => r.id).sort();
  assert.deepEqual(ids, ["account:chk", "category:fun", "category:rent", "tx:a", "tx:b", "tx:c"]);
  const w = await t.call("POST", "/sync/push", { records: [rec("tx:b", "transaction", { id: "b", categoryId: "rent", amount: 1 }, 5000), rec("tx:a", "transaction", { id: "a", categoryId: "fun", amount: 11 }, 5000)] }, teen.auth);
  assert.equal(w.status, 200);
  assert.deepEqual(w.data.denied || [], []);
  assert.equal(w.data.applied, 2);
});

test("budget-limited viewers don't see other budgets", async () => {
  const t = setup();
  const owner = await t.signIn();
  await t.call("POST", "/household/invites", { email: "kid@example.com", role: "member" }, owner.auth);
  const kid = await t.signIn("kid@example.com");
  await t.call("POST", "/sync/push", { records: [rec("budget:b1", "budget", { id: "b1" }, 1), rec("budget:kids", "budget", { id: "kids" }, 1, { budgetId: "kids" })] }, owner.auth);
  grantAccess(t, { userId: kid.me.user.id, budgetId: "kids", role: "viewer" });
  const ids = (await t.call("GET", "/sync/pull?since=0", undefined, kid.auth)).data.records.map((r) => r.id);
  assert.deepEqual(ids, ["budget:kids"]);
});

test("members can't change bank links or delete a budget; owners can", async () => {
  const t = setup();
  const owner = await t.signIn();
  await t.call("POST", "/household/invites", { email: "helper@example.com", role: "member" }, owner.auth);
  const helper = await t.signIn("helper@example.com");
  await t.call("POST", "/sync/push", { records: [rec("budget:b1", "budget", { id: "b1", name: "B", bankLinks: { accounts: { x: { target: "chk" } } } }, 1000)] }, owner.auth);
  grantAccess(t, { userId: helper.me.user.id, budgetId: "b1", role: "member" });
  await t.call("POST", "/sync/push", { records: [rec("budget:b1", "budget", { id: "b1", name: "Renamed", bankLinks: {} }, 2000, { dev: "devH" })] }, helper.auth);
  const body = JSON.parse((await t.call("GET", "/sync/pull?since=0", undefined, owner.auth)).data.records[0].body);
  assert.equal(body.name, "Renamed");
  assert.deepEqual(body.bankLinks, { accounts: { x: { target: "chk" } } }, "bank links kept");
  const del = await t.call("POST", "/sync/push", { records: [rec("budget:b1", "budget", null, 3000, { deleted: true })] }, helper.auth);
  assert.deepEqual(del.data.denied, ["budget:b1"]);
  const odel = await t.call("POST", "/sync/push", { records: [rec("budget:b1", "budget", null, 3000, { deleted: true })] }, owner.auth);
  assert.equal(odel.data.applied, 1);
});

test("push validation: unknown kinds, device-only records, and future clocks", async () => {
  const t = setup();
  const owner = await t.signIn();
  const r = await t.call("POST", "/sync/push", { records: [
    { id: "app", kind: "app", body: {}, t: 1, dev: "d" },
    { id: "user:x", kind: "user", body: { passwordHash: "x" }, t: 1, dev: "d" },
    { id: "tx:f", kind: "transaction", body: { a: 1 }, t: Date.now() + 10 * 86400000, dev: "d" },
  ] }, owner.auth);
  assert.equal(r.data.invalid, 2, "device-only records never leave the device");
  assert.equal(r.data.current.length, 1, "a far-future clock is clamped and the device gets the clamped copy");
  assert.ok(r.data.current[0].t <= Date.now() + 61000);
});

test("households are isolated", async () => {
  const t = setup({ ALLOWED_OWNER_EMAILS: "mickey@example.com" });
  const a = await t.signIn();
  await t.call("POST", "/sync/push", { records: [rec("tx:1", "transaction", { secret: 1 }, 1)] }, a.auth);
  t.DB.raw.exec("INSERT INTO households (id, name, created_at, seq) VALUES ('h_two', 'Two', 2, 0)");
  t.DB.raw.exec("UPDATE memberships SET household_id = 'h_two'; UPDATE sessions SET household_id = 'h_two'");
  assert.equal((await t.call("GET", "/sync/pull?since=0", undefined, a.auth)).data.records.length, 0);
});

test("push reports where it started, so a device can skip pulling its own changes back", async () => {
  const t = setup();
  const { owner, wife } = await household(t);
  const a = await t.call("POST", "/sync/push", { records: [rec("tx:1", "transaction", { a: 1 }, 1), rec("tx:2", "transaction", { a: 2 }, 1)] }, owner.auth);
  assert.equal(a.data.from, 0);
  assert.equal(a.data.seq, 2);
  await t.call("POST", "/sync/push", { records: [rec("tx:3", "transaction", { a: 3 }, 1, { dev: "devW" })] }, wife.auth);
  const b = await t.call("POST", "/sync/push", { records: [rec("tx:4", "transaction", { a: 4 }, 1)] }, owner.auth);
  assert.equal(b.data.from, 3, "someone else wrote at seq 3, so the owner's cursor (2) doesn't match and it pulls");
});
