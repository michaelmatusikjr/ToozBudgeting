import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, idToken, OWNER, CLIENT_ID, BASE, ORIGIN } from "./helpers.mjs";

test("Google ID token: a valid one signs in and bootstraps the owner's household", async () => {
  const t = setup();
  const r = await t.signIn();
  assert.equal(r.status, 200);
  assert.equal(r.joined, "created");
  assert.equal(r.me.role, "owner");
  assert.equal(r.me.user.email, OWNER);
  assert.equal(r.me.user.picture, "https://lh3.googleusercontent.com/a/test");
  assert.match(r.token, /^s_[\w-]+\.[\w-]+$/);
  const row = t.DB.raw.prepare("SELECT token_hash FROM sessions").get();
  assert.ok(!r.token.includes(row.token_hash) && row.token_hash.length === 64, "only a hash is stored");
  const me = await t.call("GET", "/me", undefined, r.auth);
  assert.equal(me.status, 200);
  assert.equal(me.data.household.id, r.me.household.id);
  const again = await t.signIn();
  assert.equal(again.joined, null, "second sign-in reuses the membership");
  assert.equal(again.me.household.id, r.me.household.id);
  assert.equal(t.DB.raw.prepare("SELECT COUNT(*) AS n FROM households").get().n, 1);
});

test("Google ID token: wrong audience, issuer, expiry, signature, kid, or unverified email are refused", async () => {
  const t = setup();
  const send = async (credential) => t.call("POST", "/auth/google", { credential });
  const now = Math.floor(Date.now() / 1000);
  assert.equal((await send(await idToken({ aud: "someone-else.apps.googleusercontent.com" }))).status, 401);
  assert.equal((await send(await idToken({ iss: "https://evil.example" }))).status, 401);
  assert.equal((await send(await idToken({ exp: now - 3600, iat: now - 7200 }))).status, 401);
  assert.equal((await send(await idToken({ email_verified: false }))).status, 403);
  const other = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign"]);
  assert.equal((await send(await idToken({}, { key: other.privateKey }))).status, 401, "signed by a key Google didn't publish");
  const before = t.google.certFetches;
  assert.equal((await send(await idToken({}, { kid: "unknown-kid" }))).status, 401);
  assert.equal(t.google.certFetches, before + 1, "an unknown kid refetches Google's keys once");
  const good = await idToken();
  const parts = good.split(".");
  const tampered = [parts[0], Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(parts[1], "base64url")), email: "attacker@example.com" })).toString("base64url"), parts[2]].join(".");
  assert.equal((await send(tampered)).status, 401);
  assert.equal((await send("not-a-jwt")).status, 401);
  assert.equal(t.DB.raw.prepare("SELECT COUNT(*) AS n FROM users").get().n, 0);
});

test("Google keys are cached by max-age", async () => {
  const t = setup();
  await t.signIn();
  await t.signIn();
  assert.equal(t.google.certFetches, 1);
});

test("sign-in isn't possible until GOOGLE_CLIENT_ID is set; config tells the app", async () => {
  const t = setup({ GOOGLE_CLIENT_ID: "" });
  const cfg = await t.call("GET", "/auth/config");
  assert.deepEqual(cfg.data, { googleClientId: null, ready: false });
  assert.equal((await t.call("POST", "/auth/google", { credential: await idToken() })).status, 503);
  const t2 = setup();
  assert.equal((await t2.call("GET", "/auth/config")).data.googleClientId, CLIENT_ID);
  assert.equal((await t2.call("GET", "/health")).data.googleSignIn, true);
});

test("nobody joins without an invite, and with no owner emails nobody can bootstrap", async () => {
  const t = setup();
  const stranger = await t.signIn("stranger@example.com");
  assert.equal(stranger.status, 403);
  assert.equal(stranger.data.code, "NOT_INVITED");
  const locked = setup({ ALLOWED_OWNER_EMAILS: "" });
  assert.equal((await locked.signIn()).status, 403);
});

test("invites: an owner invites his wife as an owner; she signs in and is an owner of the same household", async () => {
  const t = setup();
  const mickey = await t.signIn();
  const inv = await t.call("POST", "/household/invites", { email: "Wife@Example.com", role: "owner" }, mickey.auth);
  assert.equal(inv.status, 200);
  assert.equal(inv.data.invite.email, "wife@example.com");
  const list = await t.call("GET", "/household/members", undefined, mickey.auth);
  assert.equal(list.data.invites.length, 1);
  const wife = await t.signIn("wife@example.com", { name: "Wife" });
  assert.equal(wife.status, 200);
  assert.equal(wife.joined, "invite");
  assert.equal(wife.me.role, "owner");
  assert.equal(wife.me.household.id, mickey.me.household.id);
  const after = await t.call("GET", "/household/members", undefined, mickey.auth);
  assert.equal(after.data.members.length, 2);
  assert.equal(after.data.invites.length, 0, "accepted invites drop off the list");
  const dup = await t.call("POST", "/household/invites", { email: "wife@example.com", role: "member" }, mickey.auth);
  assert.equal(dup.status, 409);
});

test("invites: only owners can invite; bad roles, revoked and expired invites are refused", async () => {
  const t = setup();
  const owner = await t.signIn();
  assert.equal((await t.call("POST", "/household/invites", { email: "x@example.com", role: "admin" }, owner.auth)).status, 400);
  assert.equal((await t.call("POST", "/household/invites", { email: "nope", role: "member" }, owner.auth)).status, 400);
  await t.call("POST", "/household/invites", { email: "kid@example.com", role: "viewer", scopes: { budgets: ["b1"] } }, owner.auth);
  const kid = await t.signIn("kid@example.com");
  assert.equal(kid.me.role, "member", "household viewer is retired; leftover viewer memberships are household members");
  assert.equal((await t.call("POST", "/household/invites", { email: "friend@example.com", role: "owner" }, kid.auth)).status, 403);
  const inv = await t.call("POST", "/household/invites", { email: "late@example.com", role: "member" }, owner.auth);
  await t.call("DELETE", `/household/invites/${inv.data.invite.id}`, undefined, owner.auth);
  assert.equal((await t.signIn("late@example.com")).status, 403, "revoked");
  await t.call("POST", "/household/invites", { email: "old@example.com", role: "member" }, owner.auth);
  t.DB.raw.exec("UPDATE invites SET expires_at = 1 WHERE email = 'old@example.com'");
  assert.equal((await t.signIn("old@example.com")).status, 403, "expired");
});

test("members: owners change roles and remove people; the last owner stays an owner", async () => {
  const t = setup();
  const owner = await t.signIn();
  await t.call("POST", "/household/invites", { email: "kid@example.com", role: "member" }, owner.auth);
  const kid = await t.signIn("kid@example.com");
  const kidId = kid.me.user.id;
  const ch = await t.call("PATCH", `/household/members/${kidId}`, { role: "viewer", scopes: { categories: { b1: ["c1"] } } }, owner.auth);
  assert.equal(ch.status, 200);
  const me = await t.call("GET", "/me", undefined, kid.auth);
  assert.equal(me.data.role, "member", "legacy /me role is member unless every visible budget is view-only");
  assert.equal(me.data.accessRev, 2, "access changes bump accessRev so the app re-pulls");
  assert.equal((await t.call("PATCH", `/household/members/${kidId}`, { role: "owner" }, kid.auth)).status, 403);
  assert.equal((await t.call("PATCH", `/household/members/${owner.me.user.id}`, { role: "member" }, owner.auth)).status, 409);
  assert.equal((await t.call("DELETE", `/household/members/${owner.me.user.id}`, undefined, owner.auth)).status, 409);
  assert.equal((await t.call("DELETE", `/household/members/${kidId}`, undefined, owner.auth)).status, 200);
  assert.equal((await t.call("GET", "/me", undefined, kid.auth)).status, 401, "their sessions end");
});

test("sessions: sign out ends this device; garbage and expired tokens are refused", async () => {
  const t = setup();
  const a = await t.signIn();
  const b = await t.signIn();
  assert.equal((await t.call("POST", "/auth/logout", {}, a.auth)).status, 200);
  assert.equal((await t.call("GET", "/me", undefined, a.auth)).status, 401);
  assert.equal((await t.call("GET", "/me", undefined, b.auth)).status, 200);
  assert.equal((await t.call("GET", "/me", undefined, { Authorization: "Bearer s_abc.def" })).status, 401);
  assert.equal((await t.call("GET", "/me", undefined, { Authorization: b.auth.Authorization + "x" })).status, 401);
  t.DB.raw.exec("UPDATE sessions SET expires_at = 1");
  assert.equal((await t.call("GET", "/me", undefined, b.auth)).status, 401);
});

test("profiles: each person has their own display name", async () => {
  const t = setup();
  const a = await t.signIn();
  const r = await t.call("PATCH", "/me", { displayName: "Mickey" }, a.auth);
  assert.equal(r.data.user.displayName, "Mickey");
  assert.equal((await t.call("GET", "/household/members", undefined, a.auth)).data.members[0].name, "Mickey");
});

test("redirect sign-in for the installed iPhone app: form post, one-time code, redeem once", async () => {
  const t = setup();
  const form = new URLSearchParams({ credential: await idToken(), g_csrf_token: "x" });
  const res = await t.handle(new Request(BASE + "/auth/google/redirect", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form }), t.env, t.ctx);
  assert.equal(res.status, 303);
  const loc = res.headers.get("Location");
  assert.ok(loc.startsWith(ORIGIN + "/ToozBudgeting/#signin="));
  const code = loc.split("#signin=")[1];
  const r = await t.call("POST", "/auth/redeem", { code });
  assert.equal(r.status, 200);
  assert.equal(r.data.me.role, "owner");
  assert.equal((await t.call("POST", "/auth/redeem", { code })).status, 401, "codes work once");
  const bad = await t.handle(new Request(BASE + "/auth/google/redirect", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ credential: "junk" }) }), t.env, t.ctx);
  assert.match(bad.headers.get("Location"), /#signin-error=/);
});

test("sign-in failures are rate limited per IP", async () => {
  const t = setup();
  for (let i = 0; i < 20; i++) await t.call("POST", "/auth/google", { credential: "bad.bad.bad" });
  assert.equal((await t.call("POST", "/auth/google", { credential: await idToken() })).status, 429);
});
