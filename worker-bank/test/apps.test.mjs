import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, idToken, OWNER, BASE, ORIGIN } from "./helpers.mjs";

const K = (c) => c.repeat(43);
const link = { username: "matusik", authKey: K("a"), kek: K("b") };

async function household(t) {
  const owner = await t.signIn();
  await t.call("POST", "/household/invites", { email: "wife@example.com", role: "owner" }, owner.auth);
  await t.call("POST", "/household/invites", { email: "kid@example.com", role: "viewer" }, owner.auth);
  await t.call("POST", "/household/invites", { email: "teen@example.com", role: "member" }, owner.auth);
  const wife = await t.signIn("wife@example.com");
  const kid = await t.signIn("kid@example.com");
  const teen = await t.signIn("teen@example.com");
  return { owner, wife, kid, teen };
}

test("apps: an owner links Daily Tracker once; owners and members get the keys, viewers don't", async () => {
  const t = setup();
  const { owner, wife, kid, teen } = await household(t);
  const st0 = await t.call("GET", "/apps/daily-tracker", undefined, owner.auth);
  assert.equal(st0.status, 200);
  assert.equal(st0.data.linked, false);
  assert.equal(st0.data.canManage, true);
  const nl = await t.call("GET", "/apps/daily-tracker/keys", undefined, wife.auth);
  assert.equal(nl.status, 404);
  assert.equal(nl.data.code, "NOT_LINKED");

  assert.equal((await t.call("POST", "/apps/daily-tracker/link", link, teen.auth)).status, 403, "members can't link");
  const set = await t.call("POST", "/apps/daily-tracker/link", link, owner.auth);
  assert.equal(set.status, 200);
  assert.equal(set.data.linked, true);
  assert.equal(set.data.username, "matusik");
  assert.ok(!JSON.stringify(set.data).includes(K("a")), "status never includes the keys");

  const row = t.DB.raw.prepare("SELECT * FROM app_links").get();
  assert.ok(!row.sealed.includes(K("a")) && !row.sealed.includes(K("b")), "sealed at rest");

  for (const who of [owner, wife, teen]) {
    const k = await t.call("GET", "/apps/daily-tracker/keys", undefined, who.auth);
    assert.equal(k.status, 200);
    assert.deepEqual({ username: k.data.username, authKey: k.data.authKey, kek: k.data.kek }, link);
    assert.equal(k.headers.get("Cache-Control"), "no-store");
  }
  const v = await t.call("GET", "/apps/daily-tracker/keys", undefined, kid.auth);
  assert.equal(v.status, 403);
  const vs = await t.call("GET", "/apps/daily-tracker", undefined, kid.auth);
  assert.equal(vs.data.canUse, false);
  assert.equal(vs.data.linked, true);

  // Re-link after a password change replaces it.
  await t.call("POST", "/apps/daily-tracker/link", { ...link, authKey: K("c") }, wife.auth);
  assert.equal((await t.call("GET", "/apps/daily-tracker/keys", undefined, teen.auth)).data.authKey, K("c"));
  // Unlink.
  assert.equal((await t.call("DELETE", "/apps/daily-tracker/link", undefined, teen.auth)).status, 403);
  assert.equal((await t.call("DELETE", "/apps/daily-tracker/link", undefined, owner.auth)).data.linked, false);
  assert.equal((await t.call("GET", "/apps/daily-tracker/keys", undefined, owner.auth)).status, 404);
});

test("apps: link input is validated; unknown apps and signed-out calls are refused", async () => {
  const t = setup();
  const { owner } = await household(t);
  for (const bad of [{ ...link, username: "No Spaces" }, { ...link, authKey: "short" }, { ...link, kek: K("!") }, {}]) {
    assert.equal((await t.call("POST", "/apps/daily-tracker/link", bad, owner.auth)).status, 400);
  }
  assert.equal((await t.call("GET", "/apps/nope", undefined, owner.auth)).status, 404);
  assert.equal((await t.call("GET", "/apps/toozbudgeting/keys", undefined, owner.auth)).status, 404, "ToozBudgeting has no linked account");
  assert.equal((await t.call("GET", "/apps/daily-tracker/keys")).status, 401);
});

test("apps: a link belongs to one household and can't be opened under another", async () => {
  const t = setup({ ALLOWED_OWNER_EMAILS: OWNER });
  const { owner } = await household(t);
  await t.call("POST", "/apps/daily-tracker/link", link, owner.auth);
  // Move the sealed blob to another household id: the AAD binding refuses it.
  t.DB.raw.prepare("INSERT INTO households (id, name, created_at, created_by, seq) VALUES ('h_other', 'x', 0, 'u', 0)").run();
  t.DB.raw.prepare("INSERT INTO app_links (household_id, app, sealed, label, updated_by, updated_at) SELECT 'h_other', app, sealed, label, updated_by, updated_at FROM app_links").run();
  t.DB.raw.prepare("UPDATE sessions SET household_id = 'h_other'").run();
  t.DB.raw.prepare("UPDATE memberships SET household_id = 'h_other'").run();
  const r = await t.call("GET", "/apps/daily-tracker/keys", undefined, owner.auth);
  assert.equal(r.status, 409);
  assert.equal(r.data.code, "LINK_BROKEN");
});

test("apps: per-person preferences are private to each person and removed with them", async () => {
  const t = setup();
  const { owner, wife } = await household(t);
  assert.deepEqual((await t.call("GET", "/apps/daily-tracker/prefs", undefined, owner.auth)).data.prefs, {});
  await t.call("POST", "/apps/daily-tracker/prefs", { prefs: { profileId: "p-mickey" } }, owner.auth);
  await t.call("POST", "/apps/daily-tracker/prefs", { prefs: { profileId: "p-kay" } }, wife.auth);
  assert.equal((await t.call("GET", "/apps/daily-tracker/prefs", undefined, owner.auth)).data.prefs.profileId, "p-mickey");
  assert.equal((await t.call("GET", "/apps/daily-tracker/prefs", undefined, wife.auth)).data.prefs.profileId, "p-kay");
  assert.equal((await t.call("POST", "/apps/daily-tracker/prefs", { prefs: [1] }, owner.auth)).status, 400);
  assert.equal((await t.call("POST", "/apps/daily-tracker/prefs", { prefs: { x: "y".repeat(5000) } }, owner.auth)).status, 413);
  const wifeId = wife.me.user.id;
  await t.call("DELETE", "/household/members/" + wifeId, undefined, owner.auth);
  assert.equal(t.DB.raw.prepare("SELECT COUNT(*) AS n FROM app_prefs WHERE user_id = ?").get(wifeId).n, 0);
});

test("installed-app sign-in returns to the app that started it (sealed in the state), else ToozBudgeting", async () => {
  const t = setup({ PUBLIC_URL: BASE });
  const start = async (q) => new URL((await t.handle(new Request(BASE + "/auth/google/start" + q), t.env, t.ctx)).headers.get("Location"));
  const post = async (fields) => t.handle(new Request(BASE + "/auth/google/redirect", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields) }), t.env, t.ctx);
  let g = await start("?app=daily-tracker");
  assert.equal(g.searchParams.get("redirect_uri"), BASE + "/auth/google/redirect", "same Google redirect URI for every app");
  let r = await post({ id_token: await idToken({ nonce: g.searchParams.get("nonce") }), state: g.searchParams.get("state") });
  assert.match(r.headers.get("Location"), /^https:\/\/michaelmatusikjr\.github\.io\/Daily-tracker\/#signin=[\w-]+$/, "GitHub Pages path is case-sensitive (repo Daily-tracker)");
  const red = await t.call("POST", "/auth/redeem", { code: r.headers.get("Location").split("#signin=")[1] });
  assert.equal(red.status, 200);
  // A failure after a Daily Tracker start still goes back to Daily Tracker.
  r = await post({ id_token: await idToken({ nonce: "wrong" }), state: g.searchParams.get("state") });
  assert.match(r.headers.get("Location"), /\/Daily-tracker\/#signin-error=.*signin-code=BAD_NONCE/);
  // No app, an unknown app, or a URL: ToozBudgeting.
  for (const q of ["", "?app=nope", "?app=" + encodeURIComponent("https://evil.example/")]) {
    g = await start(q);
    r = await post({ id_token: await idToken({ nonce: g.searchParams.get("nonce") }), state: g.searchParams.get("state") });
    assert.match(r.headers.get("Location"), /^https:\/\/michaelmatusikjr\.github\.io\/ToozBudgeting\/#signin=/, q);
  }
  // Not configured: the error goes back to the app that asked.
  const t2 = setup({ GOOGLE_CLIENT_ID: "" });
  const nc = await t2.handle(new Request(BASE + "/auth/google/start?app=daily-tracker"), t2.env, t2.ctx);
  assert.match(nc.headers.get("Location"), /\/Daily-tracker\/#signin-error=.*NOT_CONFIGURED/);
  void ORIGIN;
});
