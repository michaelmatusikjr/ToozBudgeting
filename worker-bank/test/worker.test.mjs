import { test } from "node:test";
import assert from "node:assert/strict";
import { makeHandler, syncItem, runScheduled } from "../src/index.js";
import { plaidClient } from "../src/plaid.js";
import { b64url, openForDevice, sha256Hex, sealToken } from "../src/crypto.js";
import { makeD1 } from "./d1-mock.mjs";

const ORIGIN = "https://michaelmatusikjr.github.io";
const BASE = "https://bank.test";

function fakePlaid() {
  const calls = [];
  const state = { syncPages: [], linkFailRedirect: false, itemSeq: 0, accounts: [{ account_id: "acc-chk", name: "Checking", mask: "3769", type: "depository", subtype: "checking", balances: { current: 10 } }], whKey: null, syncError: null, mutateOnce: false };
  const routes = {
    "/link/token/create": (b) => {
      if (state.linkFailRedirect && b.redirect_uri) return [400, { error_code: "INVALID_FIELD", error_message: "OAuth redirect URI must be configured in the developer dashboard" }];
      return [200, { link_token: "link-production-abc", expiration: "2026-11-27T20:00:00Z" }];
    },
    "/item/public_token/exchange": () => { state.itemSeq++; return [200, { item_id: "item-" + state.itemSeq, access_token: "access-production-SECRET" + state.itemSeq }]; },
    "/accounts/get": () => [200, { accounts: state.accounts }],
    "/item/remove": () => [200, { removed: true }],
    "/transactions/sync": (b) => {
      if (state.syncError) return [400, { error_code: state.syncError, error_message: "the login details of this item have changed" }];
      if (state.mutateOnce && b.cursor === "p1") { state.mutateOnce = false; return [400, { error_code: "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION", error_message: "mutation" }]; }
      const page = state.syncPages.find((p) => (p.cursor || "") === (b.cursor || ""));
      if (!page) return [200, { added: [], modified: [], removed: [], next_cursor: b.cursor || "", has_more: false, accounts: state.accounts }];
      return [200, { ...page.res, accounts: state.accounts }];
    },
    "/webhook_verification_key/get": () => [200, { key: state.whKey }],
  };
  const fetchImpl = async (url, init) => {
    const path = new URL(url).pathname;
    const body = JSON.parse(init.body);
    calls.push({ path, body });
    const [status, data] = routes[path](body);
    return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
  };
  return { calls, state, fetchImpl };
}

function setup(over = {}) {
  const DB = makeD1();
  const env = {
    DB, ALLOWED_ORIGINS: ORIGIN, PLAID_ENV: "production", PLAID_CLIENT_ID: "cid", PLAID_SECRET: "psecret",
    TOKEN_ENC_KEY: b64url(crypto.getRandomValues(new Uint8Array(32))), PAIRING_SECRET: "pair-me-123",
    REDIRECT_URI: "https://michaelmatusikjr.github.io/ToozBudgeting/oauth.html", ...over,
  };
  const plaid = fakePlaid();
  const handle = makeHandler({ fetchImpl: plaid.fetchImpl });
  const waits = [];
  const ctx = { waitUntil: (p) => waits.push(p) };
  const call = async (method, path, body, headers = {}) => {
    const res = await handle(new Request(BASE + path, { method, headers: { Origin: ORIGIN, "Content-Type": "application/json", ...headers }, body: body === undefined ? undefined : (typeof body === "string" ? body : JSON.stringify(body)) }), env, ctx);
    let data = null; try { data = await res.json(); } catch { /* empty */ }
    return { status: res.status, data, headers: res.headers };
  };
  return { env, plaid, call, waits, ctx, DB };
}

async function paired(t) {
  const keys = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  const pub = await crypto.subtle.exportKey("jwk", keys.publicKey);
  const r = await t.call("POST", "/bank/pair", { secret: "pair-me-123", publicKey: pub, name: "Test phone" });
  assert.equal(r.status, 200);
  return { ...r.data, keys, auth: { Authorization: "Bearer " + r.data.token } };
}

test("health reports config without leaking secrets", async () => {
  const t = setup();
  const r = await t.call("GET", "/bank/health");
  assert.equal(r.status, 200);
  assert.equal(r.data.ok, true);
  assert.equal(r.data.plaidKeys, true);
  assert.equal(r.headers.get("Access-Control-Allow-Origin"), ORIGIN);
  const text = JSON.stringify(r.data);
  for (const s of ["psecret", "pair-me-123", t.env.TOKEN_ENC_KEY]) assert.ok(!text.includes(s));
});

test("CORS blocks other origins", async () => {
  const t = setup();
  const r = await t.call("GET", "/bank/health", undefined, { Origin: "https://evil.example" });
  assert.equal(r.status, 403);
  assert.equal(r.headers.get("Access-Control-Allow-Origin"), null);
  const pre = await t.call("OPTIONS", "/bank/items", undefined, { Origin: "https://evil.example" });
  assert.equal(pre.status, 403);
  const ok = await t.call("OPTIONS", "/bank/items");
  assert.equal(ok.status, 204);
});

test("pairing checks the secret, rate limits, and issues a token", async () => {
  const t = setup();
  const keys = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const pub = await crypto.subtle.exportKey("jwk", keys.publicKey);
  const bad = await t.call("POST", "/bank/pair", { secret: "nope", publicKey: pub });
  assert.equal(bad.status, 403);
  const priv = await crypto.subtle.exportKey("jwk", keys.privateKey);
  const leaky = await t.call("POST", "/bank/pair", { secret: "pair-me-123", publicKey: priv });
  assert.equal(leaky.status, 400, "refuses a JWK with a private part");
  const good = await t.call("POST", "/bank/pair", { secret: "pair-me-123", publicKey: pub });
  assert.equal(good.status, 200);
  assert.match(good.data.token, /^[\w-]+\.[\w-]+$/);
  const row = t.DB.raw.prepare("SELECT token_hash FROM devices").get();
  assert.notEqual(row.token_hash, good.data.token.split(".")[1]);
  for (let i = 0; i < 9; i++) await t.call("POST", "/bank/pair", { secret: "x" + i, publicKey: pub });
  const locked = await t.call("POST", "/bank/pair", { secret: "pair-me-123", publicKey: pub });
  assert.equal(locked.status, 429);
});

test("API needs a paired device", async () => {
  const t = setup();
  assert.equal((await t.call("GET", "/bank/items")).status, 401);
  assert.equal((await t.call("GET", "/bank/items", undefined, { Authorization: "Bearer abc.def" })).status, 401);
});

test("link token: webhook, redirect, transactions, and the redirect fallback", async () => {
  const t = setup();
  const d = await paired(t);
  const r = await t.call("POST", "/bank/link-token", {}, d.auth);
  assert.equal(r.status, 200);
  assert.equal(r.data.linkToken, "link-production-abc");
  assert.equal(r.data.oauthRedirect, true);
  const sent = t.plaid.calls.at(-1).body;
  assert.equal(sent.webhook, BASE + "/bank/webhook");
  assert.deepEqual(sent.products, ["transactions"]);
  assert.equal(sent.redirect_uri, t.env.REDIRECT_URI);
  assert.equal(sent.transactions.days_requested, 30);
  assert.ok(!JSON.stringify(r.data).includes("psecret"));
  t.plaid.state.linkFailRedirect = true;
  const r2 = await t.call("POST", "/bank/link-token", {}, d.auth);
  assert.equal(r2.status, 200);
  assert.equal(r2.data.oauthRedirect, false);
  assert.ok(r2.data.warning);
});

test("link token refuses new logins at the cap but allows reconnect", async () => {
  const t = setup({ ITEM_CAP: "1" });
  const d = await paired(t);
  const ex = await t.call("POST", "/bank/exchange", { publicToken: "public-1", institution: { institution_id: "ins_usaa", name: "USAA" } }, d.auth);
  assert.equal(ex.status, 200);
  const r = await t.call("POST", "/bank/link-token", {}, d.auth);
  assert.equal(r.status, 409);
  assert.equal(r.data.used, 1);
  const up = await t.call("POST", "/bank/link-token", { itemId: ex.data.item.itemId }, d.auth);
  assert.equal(up.status, 200);
  assert.equal(up.data.mode, "update");
  const sent = t.plaid.calls.at(-1).body;
  assert.equal(sent.access_token, "access-production-SECRET1");
  assert.equal(sent.products, undefined);
});

test("exchange encrypts the token at rest and refuses a second login at the same bank", async () => {
  const t = setup();
  const d = await paired(t);
  const ex = await t.call("POST", "/bank/exchange", { publicToken: "public-1", institution: { institution_id: "ins_usaa", name: "USAA" } }, d.auth);
  assert.equal(ex.status, 200);
  assert.equal(ex.data.item.institution, "USAA");
  assert.equal(ex.data.item.accounts[0].mask, "3769");
  assert.ok(!JSON.stringify(ex.data).includes("access-production"));
  const row = t.DB.raw.prepare("SELECT access_enc FROM items").get();
  assert.ok(row.access_enc.startsWith("v1."));
  assert.ok(!row.access_enc.includes("access-production"));
  const dup = await t.call("POST", "/bank/exchange", { publicToken: "public-2", institution: { institution_id: "ins_usaa", name: "USAA" } }, d.auth);
  assert.equal(dup.status, 409);
  assert.ok(t.plaid.calls.some((c) => c.path === "/item/remove" && c.body.access_token === "access-production-SECRET2"));
  const items = await t.call("GET", "/bank/items", undefined, d.auth);
  assert.equal(items.data.items.length, 1);
  assert.equal(items.data.used, 2, "the refused login still counts against the cap");
});

const tx = (id, amount, extra = {}) => ({ transaction_id: id, account_id: "acc-chk", amount, date: "2026-11-28", name: "SHOP " + id, merchant_name: null, pending: false, personal_finance_category: { primary: "GENERAL_MERCHANDISE", detailed: "GENERAL_MERCHANDISE_OTHER" }, location: { address: "x" }, ...extra });

test("sync pages through Plaid, encrypts per device, advances the cursor, and acks", async () => {
  const t = setup();
  const d = await paired(t);
  const ex = await t.call("POST", "/bank/exchange", { publicToken: "public-1", institution: { institution_id: "ins_usaa", name: "USAA" } }, d.auth);
  await Promise.all(t.waits.splice(0));
  t.DB.raw.exec("UPDATE items SET cursor = '', last_sync_at = NULL; DELETE FROM inbox");
  t.plaid.state.syncPages = [
    { cursor: "", res: { added: [tx("t1", 12.5), tx("t2", -100)], modified: [], removed: [], next_cursor: "p1", has_more: true } },
    { cursor: "p1", res: { added: [tx("t3", 4)], modified: [tx("t0", 9)], removed: [{ transaction_id: "tx-gone", account_id: "acc-chk" }], next_cursor: "p2", has_more: false } },
  ];
  const plaid = plaidClient(t.env, t.plaid.fetchImpl);
  const res = await syncItem(t.env, plaid, ex.data.item.itemId);
  assert.deepEqual([res.added, res.modified, res.removed], [3, 1, 1]);
  assert.equal(t.DB.raw.prepare("SELECT cursor FROM items").get().cursor, "p2");
  const ib = await t.call("GET", "/bank/inbox", undefined, d.auth);
  assert.equal(ib.data.batches.length, 1);
  assert.ok(!ib.data.batches[0].enc.includes("SHOP"), "inbox is ciphertext");
  const batch = await openForDevice(d.keys.privateKey, ib.data.batches[0].enc);
  assert.equal(batch.institution, "USAA");
  assert.deepEqual(batch.added.map((x) => x.transaction_id), ["t1", "t2", "t3"]);
  assert.equal(batch.added[0].pfc.primary, "GENERAL_MERCHANDISE");
  assert.equal(batch.added[0].location, undefined, "slimmed");
  assert.equal(batch.removed[0].transaction_id, "tx-gone");
  const ack = await t.call("POST", "/bank/ack", { ids: [ib.data.batches[0].id] }, d.auth);
  assert.equal(ack.data.acked, 1);
  assert.equal((await t.call("GET", "/bank/inbox", undefined, d.auth)).data.batches.length, 0);
});

test("sync restarts on mutation during pagination", async () => {
  const t = setup();
  const d = await paired(t);
  const ex = await t.call("POST", "/bank/exchange", { publicToken: "public-1", institution: { institution_id: "ins_usaa", name: "USAA" } }, d.auth);
  await Promise.all(t.waits.splice(0));
  t.DB.raw.exec("UPDATE items SET cursor = ''; DELETE FROM inbox");
  t.plaid.state.mutateOnce = true;
  t.plaid.state.syncPages = [
    { cursor: "", res: { added: [tx("t1", 1)], modified: [], removed: [], next_cursor: "p1", has_more: true } },
    { cursor: "p1", res: { added: [tx("t2", 2)], modified: [], removed: [], next_cursor: "p2", has_more: false } },
  ];
  const res = await syncItem(t.env, plaidClient(t.env, t.plaid.fetchImpl), ex.data.item.itemId);
  assert.equal(res.added, 2, "no duplicates from the aborted pass");
});

test("sync with no paired devices keeps the cursor so nothing is lost", async () => {
  const t = setup();
  const d = await paired(t);
  const ex = await t.call("POST", "/bank/exchange", { publicToken: "public-1", institution: { institution_id: "ins_usaa", name: "USAA" } }, d.auth);
  await Promise.all(t.waits.splice(0));
  t.DB.raw.exec("UPDATE items SET cursor = 'c0'; DELETE FROM devices");
  t.plaid.state.syncPages = [{ cursor: "c0", res: { added: [tx("t1", 1)], modified: [], removed: [], next_cursor: "c1", has_more: false } }];
  await syncItem(t.env, plaidClient(t.env, t.plaid.fetchImpl), ex.data.item.itemId);
  assert.equal(t.DB.raw.prepare("SELECT cursor FROM items").get().cursor, "c0");
});

test("ITEM_LOGIN_REQUIRED during sync flags the item; Reconnect clears it", async () => {
  const t = setup();
  const d = await paired(t);
  const ex = await t.call("POST", "/bank/exchange", { publicToken: "public-1", institution: { institution_id: "ins_usaa", name: "USAA" } }, d.auth);
  await Promise.all(t.waits.splice(0));
  t.plaid.state.syncError = "ITEM_LOGIN_REQUIRED";
  const res = await syncItem(t.env, plaidClient(t.env, t.plaid.fetchImpl), ex.data.item.itemId);
  assert.equal(res.error, "ITEM_LOGIN_REQUIRED");
  let items = await t.call("GET", "/bank/items", undefined, d.auth);
  assert.equal(items.data.items[0].status, "login_required");
  t.plaid.state.syncError = null;
  const rep = await t.call("POST", `/bank/items/${ex.data.item.itemId}/repaired`, {}, d.auth);
  assert.equal(rep.data.item.status, "ok");
});

async function signWebhook(body, { iat = Math.floor(Date.now() / 1000), tamper = false } = {}) {
  const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", kp.publicKey);
  const enc = (o) => b64url(new TextEncoder().encode(JSON.stringify(o)));
  const head = enc({ alg: "ES256", kid: "kid-1", typ: "JWT" });
  const payload = enc({ iat, request_body_sha256: await sha256Hex(tamper ? body + " " : body) });
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, kp.privateKey, new TextEncoder().encode(head + "." + payload)));
  return { jwt: `${head}.${payload}.${b64url(sig)}`, key: { alg: "ES256", crv: "P-256", kid: "kid-1", kty: "EC", use: "sig", x: jwk.x, y: jwk.y, created_at: 1, expired_at: null } };
}

test("webhooks: verified SYNC_UPDATES_AVAILABLE syncs; forged, tampered, or stale ones are refused", async () => {
  const t = setup();
  const d = await paired(t);
  const ex = await t.call("POST", "/bank/exchange", { publicToken: "public-1", institution: { institution_id: "ins_usaa", name: "USAA" } }, d.auth);
  await Promise.all(t.waits.splice(0));
  const itemId = ex.data.item.itemId;
  const body = JSON.stringify({ webhook_type: "TRANSACTIONS", webhook_code: "SYNC_UPDATES_AVAILABLE", item_id: itemId, initial_update_complete: true });
  const good = await signWebhook(body);
  t.plaid.state.whKey = good.key;
  const ok = await t.call("POST", "/bank/webhook", body, { "Plaid-Verification": good.jwt, Origin: "" });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.action, "sync");
  assert.equal(t.waits.length, 1);
  assert.equal((await t.call("POST", "/bank/webhook", body, { Origin: "" })).status, 401, "missing header");
  const tampered = await signWebhook(body, { tamper: true });
  t.DB.raw.exec("DELETE FROM meta WHERE k LIKE 'wh_key:%'");
  t.plaid.state.whKey = tampered.key;
  assert.equal((await t.call("POST", "/bank/webhook", body, { "Plaid-Verification": tampered.jwt, Origin: "" })).status, 401);
  const stale = await signWebhook(body, { iat: Math.floor(Date.now() / 1000) - 3600 });
  t.DB.raw.exec("DELETE FROM meta WHERE k LIKE 'wh_key:%'");
  t.plaid.state.whKey = stale.key;
  assert.equal((await t.call("POST", "/bank/webhook", body, { "Plaid-Verification": stale.jwt, Origin: "" })).status, 401);
  const forged = await signWebhook(body);
  assert.equal((await t.call("POST", "/bank/webhook", body, { "Plaid-Verification": forged.jwt, Origin: "" })).status, 401, "signed by a key Plaid didn't issue");
});

test("webhooks flag ITEM_LOGIN_REQUIRED and PENDING_EXPIRATION", async () => {
  const t = setup();
  const d = await paired(t);
  const ex = await t.call("POST", "/bank/exchange", { publicToken: "public-1", institution: { institution_id: "ins_usaa", name: "USAA" } }, d.auth);
  await Promise.all(t.waits.splice(0));
  const itemId = ex.data.item.itemId;
  const send = async (obj) => {
    const body = JSON.stringify(obj);
    const s = await signWebhook(body);
    t.DB.raw.exec("DELETE FROM meta WHERE k LIKE 'wh_key:%'");
    t.plaid.state.whKey = s.key;
    return t.call("POST", "/bank/webhook", body, { "Plaid-Verification": s.jwt, Origin: "" });
  };
  await send({ webhook_type: "ITEM", webhook_code: "ERROR", item_id: itemId, error: { error_code: "ITEM_LOGIN_REQUIRED", error_message: "login changed" } });
  let items = (await t.call("GET", "/bank/items", undefined, d.auth)).data.items;
  assert.equal(items[0].status, "login_required");
  await send({ webhook_type: "ITEM", webhook_code: "PENDING_EXPIRATION", item_id: itemId, consent_expiration_time: "2026-12-20T00:00:00Z" });
  items = (await t.call("GET", "/bank/items", undefined, d.auth)).data.items;
  assert.equal(items[0].status, "expiring");
  assert.equal(items[0].consentExpiresAt, "2026-12-20T00:00:00Z");
  const unknown = await send({ webhook_type: "TRANSACTIONS", webhook_code: "SYNC_UPDATES_AVAILABLE", item_id: "nope" });
  assert.equal(unknown.data.ignored, true);
});

test("scheduled run syncs healthy items and records the time", async () => {
  const t = setup();
  const d = await paired(t);
  await t.call("POST", "/bank/exchange", { publicToken: "public-1", institution: { institution_id: "ins_usaa", name: "USAA" } }, d.auth);
  await Promise.all(t.waits.splice(0));
  const before = t.plaid.calls.filter((c) => c.path === "/transactions/sync").length;
  await runScheduled(t.env, plaidClient(t.env, t.plaid.fetchImpl));
  assert.equal(t.plaid.calls.filter((c) => c.path === "/transactions/sync").length, before + 1);
  const h = await t.call("GET", "/bank/health");
  assert.ok(h.data.lastCronAt);
  assert.equal(h.data.lastCronError, null);
});

test("remove and unpair", async () => {
  const t = setup();
  const d = await paired(t);
  const ex = await t.call("POST", "/bank/exchange", { publicToken: "public-1", institution: { institution_id: "ins_usaa", name: "USAA" } }, d.auth);
  await Promise.all(t.waits.splice(0));
  const rm = await t.call("DELETE", `/bank/items/${ex.data.item.itemId}`, undefined, d.auth);
  assert.equal(rm.status, 200);
  assert.equal(t.DB.raw.prepare("SELECT access_enc FROM items").get().access_enc, "");
  assert.equal((await t.call("DELETE", "/bank/device", undefined, d.auth)).status, 200);
  assert.equal((await t.call("GET", "/bank/items", undefined, d.auth)).status, 401);
});

test("sealed tokens are bound to their item", async () => {
  const key = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const sealed = await sealToken(key, "item-a", "access-x");
  const { openToken } = await import("../src/crypto.js");
  assert.equal(await openToken(key, "item-a", sealed), "access-x");
  await assert.rejects(openToken(key, "item-b", sealed));
});
