/** Shared test setup: in-memory D1, a fake Plaid, and a fake Google that signs ID tokens with a test RSA key. */
import { makeHandler } from "../src/index.js";
import { b64url } from "../src/crypto.js";
import { GOOGLE_CERTS_URL } from "../src/auth.js";
import { makeD1 } from "./d1-mock.mjs";

export const ORIGIN = "https://michaelmatusikjr.github.io";
export const BASE = "https://bank.test";
export const CLIENT_ID = "1234-test.apps.googleusercontent.com";
export const OWNER = "mickey@example.com";

let rsa = null;
export async function googleKey() {
  if (rsa) return rsa;
  const kp = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const pub = await crypto.subtle.exportKey("jwk", kp.publicKey);
  rsa = { kp, jwk: { kty: "RSA", n: pub.n, e: pub.e, alg: "RS256", use: "sig", kid: "gkid-1" } };
  return rsa;
}

const enc = (o) => b64url(new TextEncoder().encode(JSON.stringify(o)));

/** A Google-style ID token. Override any claim, the kid, or sign with a different key. */
export async function idToken(claims = {}, { kid = "gkid-1", key } = {}) {
  const k = key || (await googleKey()).kp.privateKey;
  const t = Math.floor(Date.now() / 1000);
  const head = enc({ alg: "RS256", kid, typ: "JWT" });
  const payload = enc({
    iss: "https://accounts.google.com", aud: CLIENT_ID, sub: "sub-" + (claims.email || OWNER), email: OWNER, email_verified: true,
    name: "Mickey Matusik", picture: "https://lh3.googleusercontent.com/a/test", iat: t, exp: t + 3600, ...claims,
  });
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", k, new TextEncoder().encode(head + "." + payload)));
  return `${head}.${payload}.${b64url(sig)}`;
}

export function fakePlaid() {
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
  return { calls, state, routes };
}

export function setup(over = {}) {
  const DB = makeD1();
  const env = {
    DB, ALLOWED_ORIGINS: ORIGIN, PLAID_ENV: "production", PLAID_CLIENT_ID: "cid", PLAID_SECRET: "psecret",
    TOKEN_ENC_KEY: b64url(crypto.getRandomValues(new Uint8Array(32))),
    GOOGLE_CLIENT_ID: CLIENT_ID, ALLOWED_OWNER_EMAILS: OWNER, APP_URL: ORIGIN + "/ToozBudgeting/",
    REDIRECT_URI: "https://michaelmatusikjr.github.io/ToozBudgeting/oauth.html", ...over,
  };
  const plaid = fakePlaid();
  const google = { certFetches: 0, keys: null };
  const fetchImpl = async (url, init) => {
    if (String(url) === GOOGLE_CERTS_URL) {
      google.certFetches++;
      const keys = google.keys || [(await googleKey()).jwk];
      return new Response(JSON.stringify({ keys }), { status: 200, headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=21600" } });
    }
    const path = new URL(url).pathname;
    const body = JSON.parse(init.body);
    plaid.calls.push({ path, body });
    const [status, data] = plaid.routes[path](body);
    return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
  };
  plaid.fetchImpl = fetchImpl;
  const handle = makeHandler({ fetchImpl });
  const waits = [];
  const ctx = { waitUntil: (p) => waits.push(p) };
  const call = async (method, path, body, headers = {}) => {
    const res = await handle(new Request(BASE + path, { method, headers: { Origin: ORIGIN, "Content-Type": "application/json", ...headers }, body: body === undefined ? undefined : (typeof body === "string" ? body : JSON.stringify(body)) }), env, ctx);
    let data = null; try { data = await res.clone().json(); } catch { /* empty */ }
    return { status: res.status, data, headers: res.headers, res };
  };
  /** Sign in as someone. Returns { token, me, auth } where auth is the Authorization header. */
  const signIn = async (email = OWNER, extra = {}) => {
    const credential = await idToken({ email, sub: "sub-" + email, name: extra.name || email.split("@")[0], ...extra });
    const r = await call("POST", "/auth/google", { credential, deviceName: "Test" });
    if (r.status !== 200) return { ...r, auth: null };
    return { ...r.data, status: 200, auth: { Authorization: "Bearer " + r.data.token } };
  };
  return { env, plaid, google, call, waits, ctx, DB, handle, signIn };
}

export const tx = (id, amount, extra = {}) => ({ transaction_id: id, account_id: "acc-chk", amount, date: "2026-11-28", name: "SHOP " + id, merchant_name: null, pending: false, personal_finance_category: { primary: "GENERAL_MERCHANDISE", detailed: "GENERAL_MERCHANDISE_OTHER" }, location: { address: "x" }, ...extra });
