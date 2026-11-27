/** v2.0.1: sign-in reason codes, the installed-app OpenID redirect flow, and Plaid webhooks on /plaid/webhook. */
import test from "node:test";
import assert from "node:assert/strict";
import { setup, idToken, BASE, ORIGIN, CLIENT_ID, OWNER } from "./helpers.mjs";
import { runScheduled } from "../src/index.js";
import { plaidClient } from "../src/plaid.js";
import { b64url, sha256Hex } from "../src/crypto.js";

const post = (t, path, fields) => t.handle(new Request(BASE + path, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields) }), t.env, t.ctx);
const frag = (res) => new URLSearchParams(res.headers.get("Location").split("#")[1]);

test("every sign-in failure carries a reason code (JSON and redirect)", async () => {
  const t = setup();
  const cases = [
    [undefined, "NO_CREDENTIAL"],
    ["junk", "BAD_TOKEN"],
    [await idToken({}, { kid: "other" }), "UNKNOWN_KEY"],
    [await idToken({ aud: "someone-else" }), "WRONG_AUDIENCE"],
    [await idToken({ iss: "evil.example" }), "WRONG_ISSUER"],
    [await idToken({ exp: Math.floor(Date.now() / 1000) - 7200 }), "EXPIRED"],
    [await idToken({ email_verified: false }), "EMAIL_UNVERIFIED"],
    [await idToken({ email: "stranger@example.com", sub: "s-x" }), "NOT_INVITED"],
  ];
  for (const [credential, code] of cases) {
    const r = await t.call("POST", "/auth/google", { credential });
    assert.equal(r.data.code, code, `JSON ${code}`);
  }
  // The exact report: Google's form post arrived with no credential field.
  const res = await post(t, "/auth/google/redirect", { g_csrf_token: "x" });
  assert.equal(res.status, 303);
  const f = frag(res);
  assert.equal(f.get("signin-code"), "NO_CREDENTIAL");
  assert.ok(f.get("signin-error"));
  const h = await t.call("GET", "/health");
  assert.equal(h.data.lastSignInError.code, "NO_CREDENTIAL");
  assert.equal(h.data.lastSignInError.fields, "g_csrf_token", "records field names, never values");
  assert.equal(frag(await post(t, "/auth/google/redirect", { error: "access_denied" })).get("signin-code"), "GOOGLE_ACCESS_DENIED");
});

test("installed-app sign-in: /auth/google/start -> Google id_token form post with a sealed state and nonce", async () => {
  const t = setup({ PUBLIC_URL: BASE });
  const start = await t.handle(new Request(BASE + "/auth/google/start"), t.env, t.ctx);
  assert.equal(start.status, 303);
  const g = new URL(start.headers.get("Location"));
  assert.equal(g.origin + g.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.equal(g.searchParams.get("client_id"), CLIENT_ID);
  assert.equal(g.searchParams.get("redirect_uri"), BASE + "/auth/google/redirect");
  assert.equal(g.searchParams.get("response_type"), "id_token");
  assert.equal(g.searchParams.get("response_mode"), "form_post");
  const nonce = g.searchParams.get("nonce"); const state = g.searchParams.get("state");
  assert.ok(nonce && state && !state.includes(nonce), "nonce is sealed inside state");

  const ok = await post(t, "/auth/google/redirect", { id_token: await idToken({ nonce }), state });
  const code = frag(ok).get("signin");
  assert.ok(code, ok.headers.get("Location"));
  const r = await t.call("POST", "/auth/redeem", { code });
  assert.equal(r.status, 200);
  assert.equal(r.data.me.user.email, OWNER);

  assert.equal(frag(await post(t, "/auth/google/redirect", { id_token: await idToken({ nonce: "other" }), state })).get("signin-code"), "BAD_NONCE");
  assert.equal(frag(await post(t, "/auth/google/redirect", { id_token: await idToken({ nonce }), state: "forged" })).get("signin-code"), "BAD_STATE");
  assert.equal(frag(await post(t, "/auth/google/redirect", { id_token: await idToken({ nonce }) })).get("signin-code"), "BAD_STATE");
  // The Sign in with Google button's own redirect post (credential, no state) still works.
  assert.ok(frag(await post(t, "/auth/google/redirect", { credential: await idToken(), g_csrf_token: "x" })).get("signin"));
});

async function signWebhook(body) {
  const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", kp.publicKey);
  const enc = (o) => b64url(new TextEncoder().encode(JSON.stringify(o)));
  const head = enc({ alg: "ES256", kid: "kid-2", typ: "JWT" });
  const payload = enc({ iat: Math.floor(Date.now() / 1000), request_body_sha256: await sha256Hex(body) });
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, kp.privateKey, new TextEncoder().encode(head + "." + payload)));
  return { jwt: `${head}.${payload}.${b64url(sig)}`, key: { alg: "ES256", crv: "P-256", kid: "kid-2", kty: "EC", use: "sig", x: jwk.x, y: jwk.y, created_at: 1, expired_at: null } };
}

test("Plaid webhooks: /plaid/webhook is set on link, verified, syncs, and records ITEM events", async () => {
  const t = setup({ PUBLIC_URL: BASE });
  const d = await t.signIn();
  await t.call("POST", "/bank/link-token", {}, d.auth);
  assert.equal(t.plaid.calls.at(-1).body.webhook, BASE + "/plaid/webhook");
  const ex = await t.call("POST", "/bank/exchange", { publicToken: "public-1", institution: { institution_id: "ins_1", name: "USAA" } }, d.auth);
  await Promise.all(t.waits.splice(0));
  const itemId = ex.data.item.itemId;
  const send = async (obj) => {
    const body = JSON.stringify(obj);
    const s = await signWebhook(body);
    t.DB.raw.exec("DELETE FROM meta WHERE k LIKE 'wh_key:%'");
    t.plaid.state.whKey = s.key;
    return t.call("POST", "/plaid/webhook", body, { "Plaid-Verification": s.jwt, Origin: "" });
  };
  const syncs = () => t.plaid.calls.filter((c) => c.path === "/transactions/sync").length;
  const before = syncs();
  const r = await send({ webhook_type: "TRANSACTIONS", webhook_code: "SYNC_UPDATES_AVAILABLE", item_id: itemId });
  assert.equal(r.data.action, "sync");
  await Promise.all(t.waits.splice(0));
  assert.equal(syncs(), before + 1, "ran /transactions/sync for that Item");
  let item = (await t.call("GET", "/bank/items", undefined, d.auth)).data.items[0];
  assert.equal(item.lastWebhook, "TRANSACTIONS:SYNC_UPDATES_AVAILABLE");
  assert.ok(item.lastWebhookAt);
  await send({ webhook_type: "ITEM", webhook_code: "ERROR", item_id: itemId, error: { error_code: "ITEM_LOGIN_REQUIRED", error_message: "x" } });
  item = (await t.call("GET", "/bank/items", undefined, d.auth)).data.items[0];
  assert.equal(item.status, "login_required");
  assert.equal(item.lastWebhook, "ITEM:ERROR");
  await send({ webhook_type: "ITEM", webhook_code: "PENDING_EXPIRATION", item_id: itemId, consent_expiration_time: "2027-01-01T00:00:00Z" });
  item = (await t.call("GET", "/bank/items", undefined, d.auth)).data.items[0];
  assert.equal(item.status, "expiring");
  // Unsigned is refused.
  assert.equal((await t.call("POST", "/plaid/webhook", JSON.stringify({ item_id: itemId }), { Origin: "" })).status, 401);
  assert.ok((await t.call("GET", "/health")).data.lastWebhookAt);
});

test("existing Items registered with the old webhook URL get /item/webhook/update from the cron", async () => {
  const t = setup({ PUBLIC_URL: BASE });
  const d = await t.signIn();
  const ex = await t.call("POST", "/bank/exchange", { publicToken: "public-1", institution: { institution_id: "ins_1", name: "USAA" } }, d.auth);
  await Promise.all(t.waits.splice(0));
  t.DB.raw.exec(`UPDATE items SET webhook_url = NULL`); // linked before webhooks moved
  await runScheduled(t.env, plaidClient(t.env, t.plaid.fetchImpl));
  const upd = t.plaid.calls.filter((c) => c.path === "/item/webhook/update");
  assert.equal(upd.length, 1);
  assert.equal(upd[0].body.webhook, BASE + "/plaid/webhook");
  assert.ok(upd[0].body.access_token.startsWith("access-production-"));
  await runScheduled(t.env, plaidClient(t.env, t.plaid.fetchImpl));
  assert.equal(t.plaid.calls.filter((c) => c.path === "/item/webhook/update").length, 1, "only once");
  assert.ok(ex.data.item.itemId);
});
