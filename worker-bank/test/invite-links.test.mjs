/** v2.0.2: shareable invite links. The link shows who invited you; access still needs the invited Google email. */
import test from "node:test";
import assert from "node:assert/strict";
import { setup, idToken, BASE } from "./helpers.mjs";
import { maskEmail } from "../src/auth.js";

const WIFE = "kmatusik1020@gmail.com";
const post = (t, path, fields) => t.handle(new Request(BASE + path, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields) }), t.env, t.ctx);
const frag = (res) => new URLSearchParams(res.headers.get("Location").split("#")[1]);

async function withInvite(role = "member") {
  const t = setup({ PUBLIC_URL: BASE });
  const owner = await t.signIn(undefined, { name: "Mickey" });
  const r = await t.call("POST", "/household/invites", { email: WIFE, role }, owner.auth);
  assert.equal(r.status, 200);
  return { t, owner, inv: r.data.invite };
}

test("maskEmail hides most of the address", () => {
  assert.equal(maskEmail("kmatusik1020@gmail.com"), "k••••••@gmail.com");
  assert.equal(maskEmail("ab@x.io"), "a•••@x.io");
  assert.equal(maskEmail("nope"), "");
});

test("GET /auth/invite/<id> shows who invited you, without a session and without the full email", async () => {
  const { t, inv } = await withInvite();
  const r = await t.call("GET", `/auth/invite/${inv.id}`);
  assert.equal(r.status, 200);
  assert.equal(r.data.invite.invitedBy, "Mickey");
  assert.equal(r.data.invite.household, "Our household");
  assert.equal(r.data.invite.role, "member");
  assert.equal(r.data.invite.emailHint, "k••••••@gmail.com");
  assert.ok(!JSON.stringify(r.data).includes(WIFE), "full email isn't exposed by the link");
  assert.equal((await t.call("GET", "/auth/invite/i_doesnotexist")).data.code, "INVITE_NOT_FOUND");
  assert.equal((await t.call("GET", "/auth/invite/garbage")).data.code, "INVITE_NOT_FOUND");
});

test("the link alone grants nothing: a different Google account is refused with a clear code", async () => {
  const { t, inv } = await withInvite();
  const cred = await idToken({ email: "stranger@example.com", sub: "s-stranger" });
  const r = await t.call("POST", "/auth/google", { credential: cred, invite: inv.id });
  assert.equal(r.status, 403);
  assert.equal(r.data.code, "INVITE_EMAIL_MISMATCH");
  assert.match(r.data.error, /k••••••@gmail\.com/);
  // No user row or membership was created for the stranger, and the invite is still open.
  const users = t.DB.raw.prepare("SELECT COUNT(*) AS n FROM users WHERE email = 'stranger@example.com'").get();
  assert.equal(users.n, 0);
  assert.equal((await t.call("GET", `/auth/invite/${inv.id}`)).status, 200);
  // Without the link it's the usual NOT_INVITED.
  assert.equal((await t.call("POST", "/auth/google", { credential: cred })).data.code, "NOT_INVITED");
});

test("the invited Google account joins through the link; then the link is used up", async () => {
  const { t, owner, inv } = await withInvite("viewer");
  const cred = await idToken({ email: WIFE, sub: "s-wife", name: "Kristen" });
  const r = await t.call("POST", "/auth/google", { credential: cred, invite: inv.id, deviceName: "iPhone" });
  assert.equal(r.status, 200);
  assert.equal(r.data.joined, "invite");
  assert.equal(r.data.me.role, "viewer");
  assert.equal(r.data.me.household.id, owner.me.household.id);
  assert.equal((await t.call("GET", `/auth/invite/${inv.id}`)).data.code, "INVITE_USED");
  // Signing in again later with the old link still works for her (the stale link doesn't block a member).
  assert.equal((await t.call("POST", "/auth/google", { credential: cred, invite: inv.id })).status, 200);
});

test("canceled and expired invite links say so", async () => {
  const { t, owner, inv } = await withInvite();
  await t.call("DELETE", `/household/invites/${inv.id}`, undefined, owner.auth);
  assert.equal((await t.call("GET", `/auth/invite/${inv.id}`)).data.code, "INVITE_REVOKED");
  const r2 = await t.call("POST", "/household/invites", { email: "kid@example.com", role: "viewer" }, owner.auth);
  t.DB.raw.exec(`UPDATE invites SET expires_at = 1 WHERE id = '${r2.data.invite.id}'`);
  assert.equal((await t.call("GET", `/auth/invite/${r2.data.invite.id}`)).data.code, "INVITE_EXPIRED");
});

test("installed iPhone app: /auth/google/start?invite= carries the invite through Google and checks the email", async () => {
  const { t, inv } = await withInvite();
  const start = await t.handle(new Request(BASE + `/auth/google/start?invite=${inv.id}`), t.env, t.ctx);
  const g = new URL(start.headers.get("Location"));
  const nonce = g.searchParams.get("nonce"); const state = g.searchParams.get("state");
  assert.ok(!state.includes(inv.id), "invite id is sealed in state");
  const wrong = await post(t, "/auth/google/redirect", { id_token: await idToken({ nonce, email: "other@example.com", sub: "s-o" }), state });
  assert.equal(frag(wrong).get("signin-code"), "INVITE_EMAIL_MISMATCH");
  const ok = await post(t, "/auth/google/redirect", { id_token: await idToken({ nonce, email: WIFE, sub: "s-wife" }), state });
  const code = frag(ok).get("signin");
  assert.ok(code);
  const r = await t.call("POST", "/auth/redeem", { code });
  assert.equal(r.data.me.user.email, WIFE);
});
