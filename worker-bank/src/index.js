/**
 * toozbudgeting-bank: Plaid bank sync for ToozBudgeting.
 *
 * The app stays local-first. This Worker holds the Plaid access tokens (encrypted with TOKEN_ENC_KEY),
 * follows Plaid's /transactions/sync cursor for each bank login, and drops new transactions into a
 * per-device inbox encrypted to that device's public key. The device pulls, applies, and acks.
 */
import {
  randomToken, sha256Hex, safeEqual, sealToken, openToken, checkDeviceKey, sealForDevice,
  verifyEs256, jwtHeader,
} from "./crypto.js";
import { plaidClient, PlaidError, LOGIN_CODES, slimTx, slimAccount } from "./plaid.js";

const VERSION = "1.0.0";
const DEFAULT_CAP = 10;
const MAX_DEVICES = 10;
const CHUNK = 400;
const PAIR_FAILS_PER_HOUR = 10;
const SYNC_LOCK_MS = 5 * 60000;
const SYNC_NOW_GAP_MS = 30000;
const INBOX_KEEP_DAYS = 45;

class HttpError extends Error { constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; } }

const now = () => Date.now();

function allowedOrigins(env) {
  return String(env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim().replace(/\/+$/, "")).filter(Boolean);
}

function corsHeaders(env, req) {
  const origin = req.headers.get("Origin");
  if (!origin || !allowedOrigins(env).includes(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers } });
}

async function readJson(req) {
  const text = await req.text();
  if (text.length > 64 * 1024) throw new HttpError(413, "Body too large");
  if (!text) return {};
  try { return JSON.parse(text); } catch { throw new HttpError(400, "Body must be JSON"); }
}

function serverBase(env, req) {
  return String(env.PUBLIC_URL || new URL(req.url).origin).replace(/\/+$/, "");
}

/* ---------- D1 helpers ---------- */

async function meta(env, k) {
  const row = await env.DB.prepare("SELECT v FROM meta WHERE k = ?").bind(k).first();
  return row ? row.v : null;
}
async function setMeta(env, k, v) {
  await env.DB.prepare("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").bind(k, v == null ? null : String(v)).run();
}

function itemView(row) {
  let accounts = [];
  try { accounts = JSON.parse(row.accounts || "[]"); } catch { /* ignore */ }
  return {
    itemId: row.item_id,
    institutionId: row.institution_id,
    institution: row.institution_name,
    status: row.status,
    error: row.error || null,
    newAccounts: !!row.new_accounts,
    consentExpiresAt: row.consent_expires_at || null,
    createdAt: row.created_at,
    lastSyncAt: row.last_sync_at || null,
    lastWebhookAt: row.last_webhook_at || null,
    accounts: accounts.map((a) => ({ id: a.account_id, name: a.name, officialName: a.official_name, mask: a.mask, type: a.type, subtype: a.subtype })),
  };
}

/* ---------- auth ---------- */

async function authDevice(env, req) {
  const m = /^Bearer\s+([\w-]+)\.([\w-]+)$/.exec(req.headers.get("Authorization") || "");
  if (!m) throw new HttpError(401, "Pair this device first");
  const row = await env.DB.prepare("SELECT * FROM devices WHERE id = ?").bind(m[1]).first();
  if (!row || !(await safeEqual(row.token_hash, await sha256Hex(m[2])))) throw new HttpError(401, "This device isn’t paired");
  if (!row.last_seen || now() - row.last_seen > 3600000) {
    await env.DB.prepare("UPDATE devices SET last_seen = ? WHERE id = ?").bind(now(), row.id).run();
  }
  return row;
}

/* ---------- handlers ---------- */

async function health(env) {
  let db = false; let items = 0; let devices = 0;
  try {
    items = (await env.DB.prepare("SELECT COUNT(*) AS n FROM items WHERE status != 'removed'").first())?.n || 0;
    devices = (await env.DB.prepare("SELECT COUNT(*) AS n FROM devices").first())?.n || 0;
    db = true;
  } catch { db = false; }
  return {
    ok: db && !!env.PLAID_CLIENT_ID && !!env.PLAID_SECRET && !!env.TOKEN_ENC_KEY && !!env.PAIRING_SECRET,
    version: VERSION,
    time: now(),
    db,
    plaidEnv: env.PLAID_ENV || "production",
    plaidKeys: !!env.PLAID_CLIENT_ID && !!env.PLAID_SECRET,
    tokenKey: !!env.TOKEN_ENC_KEY,
    pairingSecret: !!env.PAIRING_SECRET,
    redirectUri: env.REDIRECT_URI || null,
    items, devices,
    itemsCreated: db ? Number(await meta(env, "items_created") || 0) : null,
    itemCap: Number(env.ITEM_CAP || DEFAULT_CAP),
    lastCronAt: db ? Number(await meta(env, "last_cron_at") || 0) || null : null,
    lastCronError: db ? await meta(env, "last_cron_error") : null,
  };
}

async function pair(env, req) {
  if (!env.PAIRING_SECRET) throw new HttpError(503, "Pairing isn’t set up on the server");
  const ip = req.headers.get("CF-Connecting-IP") || "unknown";
  const hour = now() - 3600000;
  const fails = (await env.DB.prepare("SELECT COUNT(*) AS n FROM attempts WHERE ip = ? AND at > ?").bind(ip, hour).first())?.n || 0;
  if (fails >= PAIR_FAILS_PER_HOUR) throw new HttpError(429, "Too many tries. Wait an hour.");
  const body = await readJson(req);
  if (!(await safeEqual(String(body.secret || "").trim(), env.PAIRING_SECRET))) {
    await env.DB.prepare("INSERT INTO attempts (ip, at) VALUES (?, ?)").bind(ip, now()).run();
    throw new HttpError(403, "That pairing code isn’t right");
  }
  let pub;
  try { pub = await checkDeviceKey(body.publicKey); } catch (e) { throw new HttpError(400, e.message); }
  const count = (await env.DB.prepare("SELECT COUNT(*) AS n FROM devices").first())?.n || 0;
  if (count >= MAX_DEVICES) throw new HttpError(409, "Too many paired devices. Unpair one first.");
  const id = randomToken(12);
  const token = randomToken(32);
  const name = String(body.name || "Device").slice(0, 60);
  await env.DB.prepare("INSERT INTO devices (id, token_hash, public_key, name, created_at, last_seen) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(id, await sha256Hex(token), JSON.stringify(pub), name, now(), now()).run();
  return { deviceId: id, token: `${id}.${token}` };
}

async function linkToken(env, req, plaid) {
  const body = await readJson(req);
  const cap = Number(env.ITEM_CAP || DEFAULT_CAP);
  const request = {
    client_name: "ToozBudgeting",
    language: "en",
    country_codes: ["US"],
    user: { client_user_id: "toozbudgeting-owner" },
    webhook: serverBase(env, req) + "/bank/webhook",
  };
  let mode = "create";
  if (body.itemId) {
    const row = await env.DB.prepare("SELECT * FROM items WHERE item_id = ? AND status != 'removed'").bind(String(body.itemId)).first();
    if (!row) throw new HttpError(404, "That bank isn’t connected");
    request.access_token = await openToken(env.TOKEN_ENC_KEY, row.item_id, row.access_enc);
    if (row.new_accounts || body.accountSelection) request.update = { account_selection_enabled: true };
    mode = "update";
  } else {
    const used = Number(await meta(env, "items_created") || 0);
    if (used >= cap) throw new HttpError(409, `All ${cap} free bank logins are used. Use Reconnect on an existing bank instead.`, { used, cap });
    request.products = ["transactions"];
    request.transactions = { days_requested: Math.max(1, Math.min(730, Number(env.DAYS_REQUESTED || 30))) };
  }
  if (env.REDIRECT_URI) request.redirect_uri = env.REDIRECT_URI;
  let res; let oauthRedirect = !!request.redirect_uri; let warning = null;
  try {
    res = await plaid("/link/token/create", request);
  } catch (e) {
    if (request.redirect_uri && e instanceof PlaidError && /redirect/i.test(e.message)) {
      delete request.redirect_uri;
      oauthRedirect = false;
      warning = "The OAuth redirect URI isn’t registered in the Plaid dashboard yet, so banks that sign in on their own site may not finish on a phone.";
      res = await plaid("/link/token/create", request);
    } else throw e;
  }
  return { linkToken: res.link_token, expiration: res.expiration, mode, oauthRedirect, warning };
}

async function exchange(env, req, plaid, ctx) {
  const body = await readJson(req);
  const publicToken = String(body.publicToken || "");
  if (!publicToken) throw new HttpError(400, "publicToken is required");
  const inst = body.institution || {};
  const ex = await plaid("/item/public_token/exchange", { public_token: publicToken });
  const itemId = ex.item_id;
  const accessToken = ex.access_token;
  const prior = await env.DB.prepare("SELECT item_id FROM items WHERE item_id = ?").bind(itemId).first();
  if (!prior) await setMeta(env, "items_created", Number(await meta(env, "items_created") || 0) + 1);
  const dupe = inst.institution_id
    ? await env.DB.prepare("SELECT item_id, institution_name FROM items WHERE institution_id = ? AND status != 'removed' AND item_id != ?").bind(String(inst.institution_id), itemId).first()
    : null;
  if (dupe) {
    try { await plaid("/item/remove", { access_token: accessToken }); } catch { /* best effort */ }
    throw new HttpError(409, `${dupe.institution_name || "That bank"} is already connected. Use Reconnect on it instead.`, { itemId: dupe.item_id });
  }
  let accounts = [];
  try { accounts = (await plaid("/accounts/get", { access_token: accessToken })).accounts || []; }
  catch { accounts = Array.isArray(body.accounts) ? body.accounts.map((a) => ({ account_id: a.id, name: a.name, mask: a.mask, type: a.type, subtype: a.subtype })) : []; }
  const sealed = await sealToken(env.TOKEN_ENC_KEY, itemId, accessToken);
  await env.DB.prepare(`INSERT INTO items (item_id, institution_id, institution_name, access_enc, cursor, status, accounts, created_at)
    VALUES (?, ?, ?, ?, '', 'ok', ?, ?)
    ON CONFLICT(item_id) DO UPDATE SET access_enc = excluded.access_enc, status = 'ok', error = NULL, accounts = excluded.accounts`)
    .bind(itemId, inst.institution_id ? String(inst.institution_id) : null, String(inst.name || "Bank").slice(0, 80), sealed, JSON.stringify(accounts.map(slimAccount)), now()).run();
  const row = await env.DB.prepare("SELECT * FROM items WHERE item_id = ?").bind(itemId).first();
  ctx?.waitUntil?.(syncItem(env, plaid, itemId).catch(() => {}));
  return { item: itemView(row) };
}

async function listItems(env) {
  const rows = (await env.DB.prepare("SELECT * FROM items WHERE status != 'removed' ORDER BY created_at").all()).results || [];
  return {
    items: rows.map(itemView),
    used: Number(await meta(env, "items_created") || 0),
    cap: Number(env.ITEM_CAP || DEFAULT_CAP),
  };
}

async function removeItem(env, plaid, itemId) {
  const row = await env.DB.prepare("SELECT * FROM items WHERE item_id = ? AND status != 'removed'").bind(itemId).first();
  if (!row) throw new HttpError(404, "That bank isn’t connected");
  try {
    await plaid("/item/remove", { access_token: await openToken(env.TOKEN_ENC_KEY, row.item_id, row.access_enc) });
  } catch (e) {
    if (!(e instanceof PlaidError) || !/ITEM_NOT_FOUND|INVALID_ACCESS_TOKEN/.test(e.code)) throw e;
  }
  await env.DB.prepare("UPDATE items SET status = 'removed', access_enc = '', cursor = NULL WHERE item_id = ?").bind(itemId).run();
  return { ok: true };
}

/** After Reconnect (Link update mode) succeeds, clear the flags and pull anything that was waiting. */
async function repaired(env, plaid, itemId, ctx) {
  const row = await env.DB.prepare("SELECT * FROM items WHERE item_id = ? AND status != 'removed'").bind(itemId).first();
  if (!row) throw new HttpError(404, "That bank isn’t connected");
  let accounts = null;
  try {
    const res = await plaid("/accounts/get", { access_token: await openToken(env.TOKEN_ENC_KEY, row.item_id, row.access_enc) });
    accounts = JSON.stringify((res.accounts || []).map(slimAccount));
  } catch { /* keep what we had */ }
  await env.DB.prepare("UPDATE items SET status = 'ok', error = NULL, new_accounts = 0, consent_expires_at = NULL, accounts = COALESCE(?, accounts) WHERE item_id = ?").bind(accounts, itemId).run();
  ctx?.waitUntil?.(syncItem(env, plaid, itemId).catch(() => {}));
  const next = await env.DB.prepare("SELECT * FROM items WHERE item_id = ?").bind(itemId).first();
  return { item: itemView(next) };
}

async function syncNow(env, req, plaid) {
  const body = await readJson(req);
  const rows = body.itemId
    ? [await env.DB.prepare("SELECT * FROM items WHERE item_id = ? AND status != 'removed'").bind(String(body.itemId)).first()].filter(Boolean)
    : ((await env.DB.prepare("SELECT * FROM items WHERE status != 'removed'").all()).results || []);
  const results = [];
  for (const row of rows) {
    if (row.last_sync_at && now() - row.last_sync_at < SYNC_NOW_GAP_MS) { results.push({ itemId: row.item_id, skipped: "recent" }); continue; }
    results.push(await syncItem(env, plaid, row.item_id));
  }
  return { results };
}

async function inbox(env, device, url) {
  const after = Number(url.searchParams.get("after") || 0) || 0;
  const rows = (await env.DB.prepare("SELECT id, item_id, created_at, enc FROM inbox WHERE device_id = ? AND id > ? ORDER BY id LIMIT 20").bind(device.id, after).all()).results || [];
  const more = rows.length === 20;
  return { batches: rows.map((r) => ({ id: r.id, itemId: r.item_id, createdAt: r.created_at, enc: r.enc })), more };
}

async function ack(env, device, req) {
  const body = await readJson(req);
  const ids = (Array.isArray(body.ids) ? body.ids : []).map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 200);
  for (const id of ids) await env.DB.prepare("DELETE FROM inbox WHERE device_id = ? AND id = ?").bind(device.id, id).run();
  return { ok: true, acked: ids.length };
}

async function unpair(env, device) {
  await env.DB.prepare("DELETE FROM inbox WHERE device_id = ?").bind(device.id).run();
  await env.DB.prepare("DELETE FROM devices WHERE id = ?").bind(device.id).run();
  return { ok: true };
}

/* ---------- sync ---------- */

async function deliver(env, itemRow, payload) {
  const devices = (await env.DB.prepare("SELECT id, public_key FROM devices").all()).results || [];
  if (!devices.length) return 0;
  const chunks = [];
  const all = [
    ...payload.added.map((t) => ["added", t]),
    ...payload.modified.map((t) => ["modified", t]),
    ...payload.removed.map((t) => ["removed", t]),
  ];
  for (let i = 0; i < Math.max(1, all.length); i += CHUNK) {
    const part = all.slice(i, i + CHUNK);
    chunks.push({
      v: 1,
      itemId: itemRow.item_id,
      institution: itemRow.institution_name,
      accounts: payload.accounts,
      added: part.filter((x) => x[0] === "added").map((x) => x[1]),
      modified: part.filter((x) => x[0] === "modified").map((x) => x[1]),
      removed: part.filter((x) => x[0] === "removed").map((x) => x[1]),
      at: now(),
    });
  }
  for (const d of devices) {
    const jwk = JSON.parse(d.public_key);
    for (const c of chunks) {
      await env.DB.prepare("INSERT INTO inbox (device_id, item_id, created_at, enc) VALUES (?, ?, ?, ?)")
        .bind(d.id, itemRow.item_id, now(), await sealForDevice(jwk, c)).run();
    }
  }
  return devices.length;
}

/**
 * Follow /transactions/sync from the saved cursor and deliver every change to each paired device.
 * The cursor only moves after the changes are in the inbox, so a failure re-sends instead of losing.
 */
export async function syncItem(env, plaid, itemId) {
  const lockUntil = now() + SYNC_LOCK_MS;
  const got = await env.DB.prepare("UPDATE items SET sync_lock = ? WHERE item_id = ? AND status != 'removed' AND (sync_lock IS NULL OR sync_lock < ?)").bind(lockUntil, itemId, now()).run();
  if (!got?.meta?.changes) return { itemId, skipped: "busy" };
  const row = await env.DB.prepare("SELECT * FROM items WHERE item_id = ?").bind(itemId).first();
  try {
    const accessToken = await openToken(env.TOKEN_ENC_KEY, row.item_id, row.access_enc);
    const start = row.cursor || "";
    let tries = 0;
    for (;;) {
      let cursor = start;
      const added = []; const modified = []; const removed = [];
      let accounts = null;
      try {
        for (let page = 0; page < 60; page++) {
          const res = await plaid("/transactions/sync", { access_token: accessToken, cursor: cursor || undefined, count: 500 });
          added.push(...(res.added || []).map(slimTx));
          modified.push(...(res.modified || []).map(slimTx));
          removed.push(...(res.removed || []).map((r) => ({ transaction_id: r.transaction_id, account_id: r.account_id || null })));
          if (Array.isArray(res.accounts) && res.accounts.length) accounts = res.accounts.map(slimAccount);
          cursor = res.next_cursor;
          if (!res.has_more) break;
        }
      } catch (e) {
        if (e instanceof PlaidError && e.code === "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION" && tries++ < 3) continue;
        throw e;
      }
      const changes = added.length + modified.length + removed.length;
      let delivered = 1;
      if (changes) {
        delivered = await deliver(env, row, { accounts: accounts || JSON.parse(row.accounts || "[]"), added, modified, removed });
      }
      const nextCursor = delivered ? cursor : start;
      await env.DB.prepare(`UPDATE items SET cursor = ?, last_sync_at = ?, accounts = COALESCE(?, accounts),
          status = CASE WHEN status IN ('login_required', 'error') THEN 'ok' ELSE status END,
          error = CASE WHEN status IN ('login_required', 'error') THEN NULL ELSE error END, sync_lock = NULL WHERE item_id = ?`)
        .bind(nextCursor || "", now(), accounts ? JSON.stringify(accounts) : null, itemId).run();
      return { itemId, added: added.length, modified: modified.length, removed: removed.length, delivered: !!delivered };
    }
  } catch (e) {
    const code = e instanceof PlaidError ? e.code : "ERROR";
    const status = LOGIN_CODES.has(code) ? "login_required" : "error";
    await env.DB.prepare("UPDATE items SET status = ?, error = ?, sync_lock = NULL WHERE item_id = ?").bind(status, `${code}: ${String(e.message).slice(0, 200)}`, itemId).run();
    return { itemId, error: code };
  }
}

/* ---------- webhooks ---------- */

async function verificationKey(env, plaid, kid) {
  const cached = await meta(env, "wh_key:" + kid);
  if (cached) {
    const k = JSON.parse(cached);
    if (!k.expired_at) return k;
  }
  const res = await plaid("/webhook_verification_key/get", { key_id: kid });
  await setMeta(env, "wh_key:" + kid, JSON.stringify(res.key));
  return res.key;
}

/** Verify Plaid's signed webhook: ES256 JWT, fresh iat, and a SHA-256 of the exact body. */
export async function verifyWebhook(env, plaid, rawBody, jwt) {
  if (!jwt) throw new HttpError(401, "Missing Plaid-Verification");
  let header;
  try { header = jwtHeader(jwt); } catch { throw new HttpError(401, "Bad Plaid-Verification"); }
  if (header.alg !== "ES256" || !header.kid) throw new HttpError(401, "Bad Plaid-Verification");
  const key = await verificationKey(env, plaid, header.kid);
  if (key.expired_at) throw new HttpError(401, "Expired webhook key");
  let payload;
  try { payload = await verifyEs256(jwt, key); } catch { throw new HttpError(401, "Bad webhook signature"); }
  if (!payload.iat || Math.abs(now() / 1000 - payload.iat) > 300) throw new HttpError(401, "Stale webhook");
  if (!(await safeEqual(payload.request_body_sha256, await sha256Hex(rawBody)))) throw new HttpError(401, "Webhook body mismatch");
  return true;
}

async function webhook(env, req, plaid, ctx) {
  const raw = await req.text();
  await verifyWebhook(env, plaid, raw, req.headers.get("Plaid-Verification"));
  let body;
  try { body = JSON.parse(raw); } catch { throw new HttpError(400, "Body must be JSON"); }
  const itemId = String(body.item_id || "");
  const row = itemId ? await env.DB.prepare("SELECT * FROM items WHERE item_id = ? AND status != 'removed'").bind(itemId).first() : null;
  if (!row) return { ok: true, ignored: true };
  await env.DB.prepare("UPDATE items SET last_webhook_at = ? WHERE item_id = ?").bind(now(), itemId).run();
  const type = body.webhook_type; const code = body.webhook_code;
  let action = "none";
  if (type === "TRANSACTIONS" && code === "SYNC_UPDATES_AVAILABLE") {
    action = "sync";
    ctx?.waitUntil?.(syncItem(env, plaid, itemId).catch(() => {}));
  } else if (type === "ITEM") {
    if (code === "ERROR") {
      const ec = body.error?.error_code || "ERROR";
      await env.DB.prepare("UPDATE items SET status = ?, error = ? WHERE item_id = ?")
        .bind(LOGIN_CODES.has(ec) ? "login_required" : "error", `${ec}: ${String(body.error?.error_message || "").slice(0, 200)}`, itemId).run();
      action = "flagged";
    } else if (code === "PENDING_EXPIRATION" || code === "PENDING_DISCONNECT") {
      await env.DB.prepare("UPDATE items SET status = 'expiring', consent_expires_at = ?, error = ? WHERE item_id = ?")
        .bind(body.consent_expiration_time || null, code, itemId).run();
      action = "flagged";
    } else if (code === "USER_PERMISSION_REVOKED" || code === "USER_ACCOUNT_REVOKED") {
      await env.DB.prepare("UPDATE items SET status = 'login_required', error = ? WHERE item_id = ?").bind(code, itemId).run();
      action = "flagged";
    } else if (code === "LOGIN_REPAIRED") {
      await env.DB.prepare("UPDATE items SET status = 'ok', error = NULL, consent_expires_at = NULL WHERE item_id = ?").bind(itemId).run();
      action = "sync";
      ctx?.waitUntil?.(syncItem(env, plaid, itemId).catch(() => {}));
    } else if (code === "NEW_ACCOUNTS_AVAILABLE") {
      await env.DB.prepare("UPDATE items SET new_accounts = 1 WHERE item_id = ?").bind(itemId).run();
      action = "flagged";
    }
  }
  return { ok: true, action };
}

/* ---------- scheduled ---------- */

export async function runScheduled(env, plaid) {
  try {
    const rows = (await env.DB.prepare("SELECT item_id FROM items WHERE status IN ('ok', 'expiring', 'error')").all()).results || [];
    for (const r of rows) await syncItem(env, plaid, r.item_id);
    await env.DB.prepare("DELETE FROM inbox WHERE created_at < ?").bind(now() - INBOX_KEEP_DAYS * 86400000).run();
    await env.DB.prepare("DELETE FROM attempts WHERE at < ?").bind(now() - 86400000).run();
    await setMeta(env, "last_cron_at", now());
    await setMeta(env, "last_cron_error", null);
  } catch (e) {
    await setMeta(env, "last_cron_error", String(e?.message || e).slice(0, 200));
  }
}

/* ---------- router ---------- */

export function makeHandler({ fetchImpl } = {}) {
  return async function handle(req, env, ctx) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const cors = corsHeaders(env, req);
    const origin = req.headers.get("Origin");
    if (req.method === "OPTIONS") return new Response(null, { status: Object.keys(cors).length ? 204 : 403, headers: cors });
    try {
      const plaid = plaidClient(env, fetchImpl || fetch);
      if (path === "/bank/webhook" && req.method === "POST") return json(await webhook(env, req, plaid, ctx));
      if (origin && !Object.keys(cors).length) throw new HttpError(403, "Origin not allowed");
      if ((path === "/" || path === "/health" || path === "/bank/health") && req.method === "GET") return json(await health(env), 200, cors);
      if (path === "/bank/pair" && req.method === "POST") return json(await pair(env, req), 200, cors);
      const device = await authDevice(env, req);
      let out;
      if (path === "/bank/link-token" && req.method === "POST") out = await linkToken(env, req, plaid);
      else if (path === "/bank/exchange" && req.method === "POST") out = await exchange(env, req, plaid, ctx);
      else if (path === "/bank/items" && req.method === "GET") out = await listItems(env);
      else if (/^\/bank\/items\/[^/]+\/repaired$/.test(path) && req.method === "POST") out = await repaired(env, plaid, decodeURIComponent(path.split("/")[3]), ctx);
      else if (path.startsWith("/bank/items/") && req.method === "DELETE") out = await removeItem(env, plaid, decodeURIComponent(path.slice(12)));
      else if (path === "/bank/sync" && req.method === "POST") out = await syncNow(env, req, plaid);
      else if (path === "/bank/inbox" && req.method === "GET") out = await inbox(env, device, url);
      else if (path === "/bank/ack" && req.method === "POST") out = await ack(env, device, req);
      else if (path === "/bank/device" && req.method === "DELETE") out = await unpair(env, device);
      else throw new HttpError(404, "Not found");
      return json(out, 200, cors);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message, ...(e.extra || {}) }, e.status, cors);
      if (e instanceof PlaidError) return json({ error: e.message, code: e.code, requestId: e.requestId }, 502, cors);
      return json({ error: "Server error" }, 500, cors);
    }
  };
}

const handle = makeHandler();

export default {
  fetch: (req, env, ctx) => handle(req, env, ctx),
  scheduled: (event, env, ctx) => { ctx.waitUntil(runScheduled(env, plaidClient(env))); },
};
