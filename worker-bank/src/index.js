/**
 * toozbudgeting-bank: household accounts, shared budget sync, and Plaid bank sync for ToozBudgeting.
 *
 * People sign in with Google (see auth.js). Each person is a member of one household with a role
 * (owner, member, viewer; see roles.js). The household's budget is stored as records and synced with
 * last-write-wins per record (see sync.js).
 *
 * Bank sync: this Worker holds the Plaid access tokens (encrypted with TOKEN_ENC_KEY), follows Plaid's
 * /transactions/sync cursor for each bank login, and drops new transactions into the household's bank inbox
 * (encrypted at rest with TOKEN_ENC_KEY). One signed-in device claims a batch, applies it to the shared
 * budget, pushes the result, and acks. Only owners can connect, reconnect, or remove banks.
 */
import { sealToken, openToken, randomToken, verifyEs256, jwtHeader, sha256Hex, safeEqual } from "./crypto.js";
import { plaidClient, PlaidError, LOGIN_CODES, slimTx, slimAccount } from "./plaid.js";
import { HttpError, now, corsHeaders, json, readJson, meta, setMeta } from "./http.js";
import {
  authSession, requireAction, signInGoogle, signInRedirect, redeemCode, signOut, meView, updateMe,
  listMembers, createInvite, revokeInvite, updateMember, removeMember, renameHousehold, signInReady, ownerEmailCount, signInStart, lastSignInError, inviteInfo,
  listBudgetAccess, setBudgetAccess,
} from "./auth.js";
import { push, pull } from "./sync.js";
import { purgeDeletedBudgets } from "./activity.js";
import { householdRole, budgetRole, canTakeBankBatch } from "./roles.js";

const VERSION = "2.0.3";
const DEFAULT_CAP = 10;
const CHUNK = 400;
const SYNC_LOCK_MS = 5 * 60000;
const SYNC_NOW_GAP_MS = 30000;
const INBOX_KEEP_DAYS = 45;
const CLAIM_MS = 2 * 60000;
const MAX_ACK_BYTES = 1500 * 1024;
const LINK_SESSION_MS = 30 * 60000; // Plaid link tokens last 4 hours; a bank sign-in should finish well within 30 minutes


function serverBase(env, req) {
  return String(env.PUBLIC_URL || (req ? new URL(req.url).origin : "")).replace(/\/+$/, "");
}

/** Where Plaid sends webhooks for every Item. Needs PUBLIC_URL when there's no request (the cron). */
export const webhookUrl = (env, req) => { const b = serverBase(env, req); return b ? b + "/plaid/webhook" : null; };

/** Point an existing Item at the current webhook URL (/item/webhook/update) if it was registered with another one. */
export async function ensureWebhook(env, plaid, row, url) {
  if (!url || !row || row.webhook_url === url || row.status === "removed") return false;
  try {
    const accessToken = await openToken(env.TOKEN_ENC_KEY, row.item_id, row.access_enc);
    await plaid("/item/webhook/update", { access_token: accessToken, webhook: url });
    await env.DB.prepare("UPDATE items SET webhook_url = ? WHERE item_id = ?").bind(url, row.item_id).run();
    return true;
  } catch { return false; }
}

const inboxAad = (householdId) => "inbox:" + householdId;

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
    lastWebhook: row.last_webhook_code || null,
    accounts: accounts.map((a) => ({ id: a.account_id, name: a.name, officialName: a.official_name, mask: a.mask, type: a.type, subtype: a.subtype })),
  };
}


/** Plaid account id -> budget ids, from live budget header bankLinks. */
async function plaidAccountIndex(env, householdId) {
  const rows = (await env.DB.prepare(
    "SELECT id, budget_id, body FROM records WHERE household_id = ? AND kind = 'budget' AND deleted = 0"
  ).bind(householdId).all()).results || [];
  const mapped = new Map(); // plaidId -> Set of budgetIds with a real target
  const mentioned = new Map(); // plaidId -> Set of budgetIds that list the account at all
  for (const row of rows) {
    let body = {};
    try { body = JSON.parse(row.body || "{}") || {}; } catch { body = {}; }
    const bid = row.budget_id || body.id || (String(row.id).startsWith("budget:") ? row.id.slice(7) : row.id);
    const accounts = body.bankLinks?.accounts || {};
    for (const [plaidId, link] of Object.entries(accounts)) {
      if (!plaidId) continue;
      if (!mentioned.has(plaidId)) mentioned.set(plaidId, new Set());
      mentioned.get(plaidId).add(bid);
      const target = link && typeof link === "object" ? link.target : link;
      if (target && target !== "skip") {
        if (!mapped.has(plaidId)) mapped.set(plaidId, new Set());
        mapped.get(plaidId).add(bid);
      }
    }
  }
  return { mapped, mentioned };
}

function plaidIdsInBatch(batch) {
  const ids = new Set();
  for (const t of [...(batch?.added || []), ...(batch?.modified || []), ...(batch?.removed || [])]) {
    const id = t?.account_id || t?.accountId;
    if (id) ids.add(id);
  }
  return ids;
}

function batchTargets(batch, index) {
  const plaidIds = plaidIdsInBatch(batch);
  const budgetIds = new Set();
  let unmapped = !plaidIds.size;
  for (const id of plaidIds) {
    const hits = index.mapped.get(id);
    if (!hits || !hits.size) unmapped = true;
    else for (const b of hits) budgetIds.add(b);
  }
  return { budgetIds: [...budgetIds], unmapped };
}

/* ---------- handlers ---------- */

async function health(env) {
  let db = false; let items = 0; let households = 0; let users = 0;
  try {
    items = (await env.DB.prepare("SELECT COUNT(*) AS n FROM items WHERE status != 'removed'").first())?.n || 0;
    households = (await env.DB.prepare("SELECT COUNT(*) AS n FROM households").first())?.n || 0;
    users = (await env.DB.prepare("SELECT COUNT(*) AS n FROM users").first())?.n || 0;
    db = true;
  } catch { db = false; }
  return {
    ok: db && !!env.PLAID_CLIENT_ID && !!env.PLAID_SECRET && !!env.TOKEN_ENC_KEY && signInReady(env),
    version: VERSION,
    time: now(),
    db,
    plaidEnv: env.PLAID_ENV || "production",
    plaidKeys: !!env.PLAID_CLIENT_ID && !!env.PLAID_SECRET,
    tokenKey: !!env.TOKEN_ENC_KEY,
    googleSignIn: signInReady(env),
    ownerEmails: ownerEmailCount(env) > 0,
    redirectUri: env.REDIRECT_URI || null,
    items, households, users,
    itemsCreated: db ? Number(await meta(env, "items_created") || 0) : null,
    itemCap: Number(env.ITEM_CAP || DEFAULT_CAP),
    lastCronAt: db ? Number(await meta(env, "last_cron_at") || 0) || null : null,
    lastCronError: db ? await meta(env, "last_cron_error") : null,
    lastSignInError: db ? await lastSignInError(env) : null,
    lastWebhookAt: db ? Number(await meta(env, "last_webhook_at") || 0) || null : null,
  };
}

/** Public settings the app needs before sign-in. The Google client ID is not a secret. */
function authConfig(env) {
  const id = String(env.GOOGLE_CLIENT_ID || "").split(",").map((s) => s.trim()).filter(Boolean)[0] || null;
  return { googleClientId: id, ready: !!id };
}

async function householdItem(env, session, itemId) {
  const row = await env.DB.prepare("SELECT * FROM items WHERE item_id = ? AND household_id = ? AND status != 'removed'").bind(String(itemId), session.householdId).first();
  if (!row) throw new HttpError(404, "That bank isn’t connected");
  return row;
}

async function linkToken(env, req, plaid, session) {
  requireAction(session, "bank.manage", "Only a household owner can connect banks");
  const body = await readJson(req);
  const cap = Number(env.ITEM_CAP || DEFAULT_CAP);
  const request = {
    client_name: "ToozBudgeting",
    language: "en",
    country_codes: ["US"],
    user: { client_user_id: session.householdId },
    webhook: webhookUrl(env, req),
  };
  let mode = "create";
  if (body.itemId) {
    const row = await householdItem(env, session, body.itemId);
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
  // Keep the session server-side: a bank's sign-in (Chase OAuth) can return in another browser (the iPhone
  // home-screen app's return opens in Safari), which needs the same link token to finish.
  const id = "l_" + randomToken(12);
  await env.DB.prepare(`INSERT INTO link_sessions (id, household_id, user_id, link_token_enc, mode, item_id, status, oauth_redirect, created_at, updated_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)`)
    .bind(id, session.householdId, session.user.id, await sealToken(env.TOKEN_ENC_KEY, "link:" + id, res.link_token), mode, body.itemId ? String(body.itemId) : null,
      oauthRedirect ? 1 : 0, now(), now(), now() + LINK_SESSION_MS).run();
  console.log("link_token", JSON.stringify({ mode, oauthRedirect, linkSession: id }));
  return { linkToken: res.link_token, expiration: res.expiration, mode, oauthRedirect, warning, linkSessionId: id };
}

function linkSessionView(row) {
  let result = null;
  try { result = row.result ? JSON.parse(row.result) : null; } catch { result = null; }
  return { id: row.id, mode: row.mode, itemId: row.item_id || null, status: row.status, result, createdAt: row.created_at, expiresAt: row.expires_at };
}

/** GET /bank/link/pending: the household's latest unfinished Link session, with its link token, to resume after a bank OAuth return. */
async function pendingLink(env, session) {
  requireAction(session, "bank.manage", "Only a household owner can connect banks");
  const row = await env.DB.prepare("SELECT * FROM link_sessions WHERE household_id = ? AND status IN ('open', 'oauth') AND expires_at > ? ORDER BY created_at DESC LIMIT 1")
    .bind(session.householdId, now()).first();
  if (!row) throw new HttpError(404, "There’s no bank connection waiting to finish. Start again from Settings › Bank sync.", { code: "LINK_NOT_FOUND" });
  return { link: { ...linkSessionView(row), linkToken: await openToken(env.TOKEN_ENC_KEY, "link:" + row.id, row.link_token_enc) } };
}

/** GET /bank/link/<id>: status only (the app polls it while Link waits on a bank sign-in elsewhere). */
async function linkStatus(env, session, id) {
  requireAction(session, "bank.view");
  const row = await env.DB.prepare("SELECT * FROM link_sessions WHERE id = ? AND household_id = ?").bind(String(id), session.householdId).first();
  if (!row) throw new HttpError(404, "Unknown bank connection", { code: "LINK_NOT_FOUND" });
  return { link: linkSessionView(row) };
}

/** POST /bank/link/<id>/event { status: "oauth" | "exited", reason }: Link's progress, for status checks and logs. */
async function linkEvent(env, req, session, id) {
  requireAction(session, "bank.manage", "Only a household owner can connect banks");
  const body = await readJson(req);
  const status = ["oauth", "exited"].includes(body.status) ? body.status : null;
  if (!status) throw new HttpError(400, "status must be oauth or exited");
  await env.DB.prepare("UPDATE link_sessions SET status = ?, result = COALESCE(?, result), updated_at = ? WHERE id = ? AND household_id = ? AND status IN ('open', 'oauth')")
    .bind(status, body.reason ? JSON.stringify({ reason: String(body.reason).slice(0, 120) }) : null, now(), String(id), session.householdId).run();
  console.log("link_event", JSON.stringify({ id, status, reason: body.reason || null }));
  return linkStatus(env, session, id);
}

async function finishLinkSession(env, session, id, result) {
  if (!id) return;
  await env.DB.prepare("UPDATE link_sessions SET status = 'done', result = ?, updated_at = ? WHERE id = ? AND household_id = ?")
    .bind(JSON.stringify(result), now(), String(id), session.householdId).run();
}

async function exchange(env, req, plaid, ctx, session) {
  requireAction(session, "bank.manage", "Only a household owner can connect banks");
  const body = await readJson(req);
  const publicToken = String(body.publicToken || "");
  if (!publicToken) throw new HttpError(400, "publicToken is required");
  const inst = body.institution || {};
  const ex = await plaid("/item/public_token/exchange", { public_token: publicToken });
  const itemId = ex.item_id;
  const accessToken = ex.access_token;
  const prior = await env.DB.prepare("SELECT item_id, household_id FROM items WHERE item_id = ?").bind(itemId).first();
  if (prior && prior.household_id && prior.household_id !== session.householdId) throw new HttpError(409, "That bank login belongs to another household");
  if (!prior) await setMeta(env, "items_created", Number(await meta(env, "items_created") || 0) + 1);
  const dupe = inst.institution_id
    ? await env.DB.prepare("SELECT item_id, institution_name FROM items WHERE institution_id = ? AND household_id = ? AND status != 'removed' AND item_id != ?").bind(String(inst.institution_id), session.householdId, itemId).first()
    : null;
  if (dupe) {
    try { await plaid("/item/remove", { access_token: accessToken }); } catch { /* best effort */ }
    throw new HttpError(409, `${dupe.institution_name || "That bank"} is already connected. Use Reconnect on it instead.`, { itemId: dupe.item_id });
  }
  let accounts = [];
  try { accounts = (await plaid("/accounts/get", { access_token: accessToken })).accounts || []; }
  catch { accounts = Array.isArray(body.accounts) ? body.accounts.map((a) => ({ account_id: a.id, name: a.name, mask: a.mask, type: a.type, subtype: a.subtype })) : []; }
  const sealed = await sealToken(env.TOKEN_ENC_KEY, itemId, accessToken);
  await env.DB.prepare(`INSERT INTO items (item_id, household_id, institution_id, institution_name, access_enc, cursor, status, accounts, created_at, added_by)
    VALUES (?, ?, ?, ?, ?, '', 'ok', ?, ?, ?)
    ON CONFLICT(item_id) DO UPDATE SET access_enc = excluded.access_enc, status = 'ok', error = NULL, accounts = excluded.accounts, household_id = excluded.household_id`)
    .bind(itemId, session.householdId, inst.institution_id ? String(inst.institution_id) : null, String(inst.name || "Bank").slice(0, 80), sealed, JSON.stringify(accounts.map(slimAccount)), now(), session.user.id).run();
  // Link set the webhook from the link token; record it so the cron doesn't re-register it.
  await env.DB.prepare("UPDATE items SET webhook_url = ? WHERE item_id = ?").bind(webhookUrl(env, req), itemId).run();
  const row = await env.DB.prepare("SELECT * FROM items WHERE item_id = ?").bind(itemId).first();
  ctx?.waitUntil?.(syncItem(env, plaid, itemId).catch(() => {}));
  await finishLinkSession(env, session, body.linkSessionId, { itemId, institution: row.institution_name });
  return { item: itemView(row) };
}

async function listItems(env, session) {
  requireAction(session, "bank.view");
  const rows = (await env.DB.prepare("SELECT * FROM items WHERE household_id = ? AND status != 'removed' ORDER BY created_at").bind(session.householdId).all()).results || [];
  let visible = rows;
  if (householdRole(session) !== "owner") {
    const index = await plaidAccountIndex(env, session.householdId);
    visible = rows.filter((row) => {
      let accounts = [];
      try { accounts = JSON.parse(row.accounts || "[]"); } catch { accounts = []; }
      const ids = accounts.map((a) => a.account_id || a.id).filter(Boolean);
      if (row.item_id) ids.push(row.item_id);
      return ids.some((id) => {
        const budgets = index.mentioned.get(id);
        return budgets && [...budgets].some((b) => budgetRole(session, b) != null);
      });
    });
  }
  return {
    items: visible.map(itemView),
    used: Number(await meta(env, "items_created") || 0),
    cap: Number(env.ITEM_CAP || DEFAULT_CAP),
    canManage: householdRole(session) === "owner",
  };
}

async function removeItem(env, plaid, session, itemId) {
  requireAction(session, "bank.manage", "Only a household owner can disconnect banks");
  const row = await householdItem(env, session, itemId);
  try {
    await plaid("/item/remove", { access_token: await openToken(env.TOKEN_ENC_KEY, row.item_id, row.access_enc) });
  } catch (e) {
    if (!(e instanceof PlaidError) || !/ITEM_NOT_FOUND|INVALID_ACCESS_TOKEN/.test(e.code)) throw e;
  }
  await env.DB.prepare("UPDATE items SET status = 'removed', access_enc = '', cursor = NULL WHERE item_id = ?").bind(itemId).run();
  return { ok: true };
}

/** After Reconnect (Link update mode) succeeds, clear the flags and pull anything that was waiting. */
async function repaired(env, plaid, session, itemId, ctx, req) {
  requireAction(session, "bank.manage", "Only a household owner can reconnect banks");
  let body = {};
  try { body = req ? await readJson(req) : {}; } catch { body = {}; }
  const row = await householdItem(env, session, itemId);
  let accounts = null;
  try {
    const res = await plaid("/accounts/get", { access_token: await openToken(env.TOKEN_ENC_KEY, row.item_id, row.access_enc) });
    accounts = JSON.stringify((res.accounts || []).map(slimAccount));
  } catch { /* keep what we had */ }
  await env.DB.prepare("UPDATE items SET status = 'ok', error = NULL, new_accounts = 0, consent_expires_at = NULL, accounts = COALESCE(?, accounts) WHERE item_id = ?").bind(accounts, itemId).run();
  ctx?.waitUntil?.(syncItem(env, plaid, itemId).catch(() => {}));
  const next = await env.DB.prepare("SELECT * FROM items WHERE item_id = ?").bind(itemId).first();
  await finishLinkSession(env, session, body.linkSessionId, { itemId, institution: next.institution_name, repaired: true });
  return { item: itemView(next) };
}

async function syncNow(env, req, plaid, session) {
  requireAction(session, "bank.apply", "You have view-only access");
  const body = await readJson(req);
  const rows = body.itemId
    ? [await householdItem(env, session, body.itemId)]
    : ((await env.DB.prepare("SELECT * FROM items WHERE household_id = ? AND status != 'removed'").bind(session.householdId).all()).results || []);
  const results = [];
  for (const row of rows) {
    await ensureWebhook(env, plaid, row, webhookUrl(env, req));
    if (row.last_sync_at && now() - row.last_sync_at < SYNC_NOW_GAP_MS) { results.push({ itemId: row.item_id, skipped: "recent" }); continue; }
    results.push(await syncItem(env, plaid, row.item_id));
  }
  return { results };
}

/**
 * GET /bank/inbox: claim up to 20 waiting batches for this session for 2 minutes, so two devices don't
 * apply the same bank transactions at once. Batches come back decrypted, over TLS, to a signed-in member.
 */
async function inbox(env, session) {
  requireAction(session, "bank.apply", "You have view-only access");
  const hid = session.householdId;
  const sid = session.sessionId;
  await env.DB.prepare(`UPDATE bank_inbox SET claimed_by = ?, claim_until = ? WHERE id IN (
      SELECT id FROM bank_inbox WHERE household_id = ? AND (claim_until IS NULL OR claim_until < ? OR claimed_by = ?) ORDER BY id LIMIT 20)`)
    .bind(sid, now() + CLAIM_MS, hid, now(), sid).run();
  const rows = (await env.DB.prepare("SELECT id, item_id, created_at, enc, held FROM bank_inbox WHERE household_id = ? AND claimed_by = ? AND claim_until > ? ORDER BY id")
    .bind(hid, sid, now()).all()).results || [];
  const waiting = (await env.DB.prepare("SELECT COUNT(*) AS n FROM bank_inbox WHERE household_id = ?").bind(hid).first())?.n || 0;
  const claimed = [];
  for (const r of rows) {
    try { claimed.push({ id: r.id, itemId: r.item_id, createdAt: r.created_at, held: !!r.held, batch: JSON.parse(await openToken(env.TOKEN_ENC_KEY, inboxAad(hid), r.enc)) }); }
    catch { await env.DB.prepare("DELETE FROM bank_inbox WHERE id = ?").bind(r.id).run(); }
  }
  const index = await plaidAccountIndex(env, hid);
  const batches = [];
  const release = [];
  for (const b of claimed) {
    const { budgetIds, unmapped } = batchTargets(b.batch, index);
    if (canTakeBankBatch(session, budgetIds, unmapped)) batches.push(b);
    else release.push(b.id);
  }
  if (release.length) {
    await env.DB.prepare("UPDATE bank_inbox SET claimed_by = NULL, claim_until = NULL WHERE household_id = ? AND id IN (SELECT value FROM json_each(?))")
      .bind(hid, JSON.stringify(release)).run();
  }
  return { batches, more: waiting > batches.length };
}

/**
 * POST /bank/ack { ids: [done], release: [still waiting, unchanged], held: [remainder batches to keep] }
 * held batches are for bank accounts nobody has chosen a home for yet. They go back in the household inbox
 * so whichever device maps the account first brings them in.
 */
async function ack(env, req, session) {
  requireAction(session, "bank.apply", "You have view-only access");
  const body = await readJson(req, MAX_ACK_BYTES);
  const hid = session.householdId;
  const nums = (a) => (Array.isArray(a) ? a : []).map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 200);
  const ids = nums(body.ids);
  const release = nums(body.release);
  const held = (Array.isArray(body.held) ? body.held : []).slice(0, 50);
  const stmts = [];
  if (ids.length) stmts.push(env.DB.prepare("DELETE FROM bank_inbox WHERE household_id = ? AND id IN (SELECT value FROM json_each(?))").bind(hid, JSON.stringify(ids)));
  if (release.length) stmts.push(env.DB.prepare("UPDATE bank_inbox SET claimed_by = NULL, claim_until = NULL WHERE household_id = ? AND id IN (SELECT value FROM json_each(?))").bind(hid, JSON.stringify(release)));
  for (const b of held) {
    if (!b || typeof b !== "object") continue;
    stmts.push(env.DB.prepare("INSERT INTO bank_inbox (household_id, item_id, created_at, enc, held) VALUES (?, ?, ?, ?, 1)")
      .bind(hid, b.itemId ? String(b.itemId) : null, now(), await sealToken(env.TOKEN_ENC_KEY, inboxAad(hid), JSON.stringify(b))));
  }
  if (stmts.length) await env.DB.batch(stmts);
  return { ok: true, acked: ids.length, released: release.length, held: held.length };
}

/* ---------- sync ---------- */

async function deliver(env, itemRow, payload) {
  const hid = itemRow.household_id;
  if (!hid) return 0;
  const all = [
    ...payload.added.map((t) => ["added", t]),
    ...payload.modified.map((t) => ["modified", t]),
    ...payload.removed.map((t) => ["removed", t]),
  ];
  const stmts = [];
  for (let i = 0; i < Math.max(1, all.length); i += CHUNK) {
    const part = all.slice(i, i + CHUNK);
    const chunk = {
      v: 1,
      itemId: itemRow.item_id,
      institution: itemRow.institution_name,
      accounts: payload.accounts,
      added: part.filter((x) => x[0] === "added").map((x) => x[1]),
      modified: part.filter((x) => x[0] === "modified").map((x) => x[1]),
      removed: part.filter((x) => x[0] === "removed").map((x) => x[1]),
      at: now(),
    };
    stmts.push(env.DB.prepare("INSERT INTO bank_inbox (household_id, item_id, created_at, enc, held) VALUES (?, ?, ?, ?, 0)")
      .bind(hid, itemRow.item_id, now(), await sealToken(env.TOKEN_ENC_KEY, inboxAad(hid), JSON.stringify(chunk))));
  }
  await env.DB.batch(stmts);
  return 1;
}

/**
 * Follow /transactions/sync from the saved cursor and deliver every change to the household's bank inbox.
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
  const type = body.webhook_type; const code = body.webhook_code;
  await env.DB.prepare("UPDATE items SET last_webhook_at = ?, last_webhook_code = ? WHERE item_id = ?").bind(now(), `${type || "?"}:${code || "?"}`.slice(0, 60), itemId).run();
  await setMeta(env, "last_webhook_at", now());
  let action = "none";
  if (type === "TRANSACTIONS" && (code === "SYNC_UPDATES_AVAILABLE" || code === "INITIAL_UPDATE" || code === "HISTORICAL_UPDATE" || code === "DEFAULT_UPDATE")) {
    action = "sync";
    ctx?.waitUntil?.(syncItem(env, plaid, itemId).catch(() => {}));
  } else if (type === "ITEM") {
    if (code === "ERROR") {
      const ec = body.error?.error_code || "ERROR";
      await env.DB.prepare("UPDATE items SET status = ?, error = ? WHERE item_id = ?")
        .bind(LOGIN_CODES.has(ec) ? "login_required" : "error", `${ec}: ${String(body.error?.error_message || "").slice(0, 200)}`, itemId).run();
      action = "flagged";
    } else if (code === "WEBHOOK_UPDATE_ACKNOWLEDGED") {
      if (body.new_webhook_url) await env.DB.prepare("UPDATE items SET webhook_url = ? WHERE item_id = ?").bind(String(body.new_webhook_url), itemId).run();
      action = "noted";
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
    const url = webhookUrl(env, null);
    if (url) {
      const all = (await env.DB.prepare("SELECT * FROM items WHERE status != 'removed' AND (webhook_url IS NULL OR webhook_url != ?)").bind(url).all()).results || [];
      for (const r of all) await ensureWebhook(env, plaid, r, url);
    }
    // Backup to webhooks: catch anything a missed webhook would have brought.
    const rows = (await env.DB.prepare("SELECT item_id FROM items WHERE status IN ('ok', 'expiring', 'error')").all()).results || [];
    for (const r of rows) await syncItem(env, plaid, r.item_id);
    await env.DB.prepare("DELETE FROM bank_inbox WHERE created_at < ? AND held = 0").bind(now() - INBOX_KEEP_DAYS * 86400000).run();
    await env.DB.prepare("DELETE FROM attempts WHERE at < ?").bind(now() - 86400000).run();
    await env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(now()).run();
    await env.DB.prepare("DELETE FROM login_codes WHERE expires_at < ?").bind(now()).run();
    await env.DB.prepare("DELETE FROM link_sessions WHERE expires_at < ?").bind(now() - 86400000).run();
    await purgeDeletedBudgets(env);
    await setMeta(env, "last_cron_at", now());
    await setMeta(env, "last_cron_error", null);
  } catch (e) {
    await setMeta(env, "last_cron_error", String(e?.message || e).slice(0, 200));
  }
}

/* ---------- router ---------- */

export function makeHandler({ fetchImpl } = {}) {
  const doFetch = fetchImpl || ((...a) => fetch(...a));
  return async function handle(req, env, ctx) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const cors = corsHeaders(env, req);
    const origin = req.headers.get("Origin");
    const m = req.method;
    if (m === "OPTIONS") return new Response(null, { status: Object.keys(cors).length ? 204 : 403, headers: cors });
    try {
      const plaid = plaidClient(env, doFetch);
      if ((path === "/plaid/webhook" || path === "/bank/webhook") && m === "POST") return json(await webhook(env, req, plaid, ctx));
      if (path === "/auth/google/redirect" && m === "POST") return await signInRedirect(env, req, doFetch);
      if (path === "/auth/google/start" && m === "GET") return await signInStart(env, req);
      if (origin && !Object.keys(cors).length) throw new HttpError(403, "Origin not allowed");
      if ((path === "/" || path === "/health" || path === "/bank/health") && m === "GET") return json(await health(env), 200, cors);
      if (path === "/auth/config" && m === "GET") return json(authConfig(env), 200, cors);
      if (path === "/auth/google" && m === "POST") return json(await signInGoogle(env, req, doFetch), 200, cors);
      if (path === "/auth/redeem" && m === "POST") return json(await redeemCode(env, req), 200, cors);
      if (/^\/auth\/invite\/[^/]+$/.test(path) && m === "GET") return json(await inviteInfo(env, decodeURIComponent(path.split("/")[3])), 200, cors);
      if (path === "/bank/pair") throw new HttpError(410, "Pairing was replaced by Sign in with Google. Update the app.");
      const s = await authSession(env, req);
      let out;
      if (path === "/me" && m === "GET") out = await meView(env, s);
      else if (path === "/me" && m === "PATCH") out = await updateMe(env, req, s);
      else if (path === "/auth/logout" && m === "POST") out = await signOut(env, s, url.searchParams.get("all") === "1");
      else if (path === "/household" && m === "PATCH") out = await renameHousehold(env, req, s);
      else if (path === "/household/members" && m === "GET") out = await listMembers(env, s);
      else if (/^\/household\/members\/[^/]+$/.test(path) && m === "PATCH") out = await updateMember(env, req, s, decodeURIComponent(path.split("/")[3]));
      else if (/^\/household\/members\/[^/]+$/.test(path) && m === "DELETE") out = await removeMember(env, s, decodeURIComponent(path.split("/")[3]));
      else if (path === "/household/invites" && m === "POST") out = await createInvite(env, req, s);
      else if (/^\/household\/invites\/[^/]+$/.test(path) && m === "DELETE") out = await revokeInvite(env, s, decodeURIComponent(path.split("/")[3]));
      else if (/^\/budgets\/[^/]+\/access$/.test(path) && m === "GET") out = await listBudgetAccess(env, s, decodeURIComponent(path.split("/")[2]));
      else if (/^\/budgets\/[^/]+\/access$/.test(path) && m === "PUT") out = await setBudgetAccess(env, req, s, decodeURIComponent(path.split("/")[2]));
      else if (path === "/sync/pull" && m === "GET") out = await pull(env, url, s);
      else if (path === "/sync/push" && m === "POST") out = await push(env, req, s);
      else if (path === "/bank/link-token" && m === "POST") out = await linkToken(env, req, plaid, s);
      else if (path === "/bank/exchange" && m === "POST") out = await exchange(env, req, plaid, ctx, s);
      else if (path === "/bank/items" && m === "GET") out = await listItems(env, s);
      else if (/^\/bank\/items\/[^/]+\/repaired$/.test(path) && m === "POST") out = await repaired(env, plaid, s, decodeURIComponent(path.split("/")[3]), ctx, req);
      else if (path.startsWith("/bank/items/") && m === "DELETE") out = await removeItem(env, plaid, s, decodeURIComponent(path.slice(12)));
      else if (path === "/bank/link/pending" && m === "GET") out = await pendingLink(env, s);
      else if (/^\/bank\/link\/l_[\w-]+$/.test(path) && m === "GET") out = await linkStatus(env, s, path.split("/")[3]);
      else if (/^\/bank\/link\/l_[\w-]+\/event$/.test(path) && m === "POST") out = await linkEvent(env, req, s, path.split("/")[3]);
      else if (path === "/bank/sync" && m === "POST") out = await syncNow(env, req, plaid, s);
      else if (path === "/bank/inbox" && m === "GET") out = await inbox(env, s);
      else if (path === "/bank/ack" && m === "POST") out = await ack(env, req, s);
      else throw new HttpError(404, "Not found");
      return json(out, 200, cors);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message, ...(e.extra || {}) }, e.status, cors);
      console.log("server_error", path, String(e?.stack || e).slice(0, 500));
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
