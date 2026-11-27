/**
 * Bank sync client. Talks to the toozbudgeting-bank Worker with the household session (Sign in with Google),
 * opens Plaid Link, and applies what the Worker delivers through ctx.commit so it can be undone.
 *
 * New bank transactions wait in the household's bank inbox on the server. One signed-in device at a time
 * claims them, applies them to the shared budget, pushes the result, and acks. Transaction ids come from
 * Plaid (plaid-<id>), so applying the same batch twice never makes a duplicate.
 */
import { deviceGet, deviceSet } from "./store.js?v=152";
import { applyBankBatch, rememberBankAccounts, sumStats, statsLine } from "./bankmap.js?v=152";
import { api, account, serverUrl, SERVER_DEFAULT, ApiError } from "./account.js?v=152";
import { syncNow } from "./sync.js?v=152";

export const BANK_DEFAULTS = { serverUrl: SERVER_DEFAULT };
export const PLAID_LINK_SRC = "https://cdn.plaid.com/link/v2/stable/link-initialize.js";
const LINK_KEY = "toozbudgeting:bank:link";
const OAUTH_KEY = "toozbudgeting:bank:oauth";
const listeners = new Set();

export function onBankChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
const changed = () => listeners.forEach((fn) => { try { fn(); } catch { /* ignore */ } });

export async function bankConfig() { return { serverUrl: await serverUrl() }; }
export async function setBankConfig(patch) {
  const next = { ...(await deviceGet("bankConfig")), ...patch };
  next.serverUrl = String(next.serverUrl || "").trim().replace(/\/+$/, "") || BANK_DEFAULTS.serverUrl;
  await deviceSet("bankConfig", next);
  changed();
}
export async function bankState() { return (await deviceGet("bankState")) || {}; }
async function saveBankState(patch) {
  const s = { ...(await bankState()), ...patch };
  await deviceSet("bankState", s);
  changed();
  return s;
}
/** Held batches from before household accounts (v1 kept them on the device). Sent back to the server on next pull. */
export async function heldBatches() { return (await deviceGet("bankHeld")) || []; }
export const heldCount = (held) => (held || []).reduce((n, b) => n + (b.added?.length || 0) + (b.removed?.length || 0), 0);
const batchCount = (b) => (b?.added?.length || 0) + (b?.modified?.length || 0) + (b?.removed?.length || 0);

export const BankError = ApiError;

/** Signed in with a role that can see bank sync. */
export async function bankAccess() {
  const a = await account();
  if (!a?.token) return { signedIn: false, role: null, canManage: false, canApply: false };
  const role = a.me?.role || null;
  return { signedIn: true, role, canManage: role === "owner", canApply: role === "owner" || role === "member" };
}
export const isPaired = async () => (await bankAccess()).signedIn;

export async function bankHealth() {
  try { return { reachable: true, ...(await api("GET", "/bank/health", undefined, { auth: false })) }; }
  catch (e) { return { reachable: false, error: e.message }; }
}

/** Server's list of connected banks. Cached so Settings can show something offline. */
export async function listItems() {
  const res = await api("GET", "/bank/items");
  await saveBankState({ items: res, itemsAt: Date.now() });
  return res;
}
export const linkToken = (itemId) => api("POST", "/bank/link-token", itemId ? { itemId } : {});
export const exchangePublicToken = (publicToken, metadata) => api("POST", "/bank/exchange", {
  publicToken,
  institution: metadata?.institution || null,
  accounts: (metadata?.accounts || []).map((a) => ({ id: a.id, name: a.name, mask: a.mask, type: a.type, subtype: a.subtype })),
});
export const markRepaired = (itemId) => api("POST", `/bank/items/${encodeURIComponent(itemId)}/repaired`, {});
export const disconnectItem = (itemId) => api("DELETE", `/bank/items/${encodeURIComponent(itemId)}`);
export const requestSync = (itemId) => api("POST", "/bank/sync", itemId ? { itemId } : {});

/* ---------- applying what arrives ---------- */

let pulling = null;

/** Claim the household's waiting bank batches, apply them in one undoable commit, push, then ack. */
export function pullBank(ctx) {
  if (pulling) return pulling;
  pulling = (async () => {
    try { return await pullInner(ctx); }
    finally { pulling = null; }
  })();
  return pulling;
}

async function pullInner(ctx) {
  const access = await bankAccess();
  if (!access.canApply || !ctx.budget()) return { stats: null };
  // Start from the household's latest budget so bank transactions land on top of everyone's edits.
  await syncNow(ctx);
  const claimed = [];
  for (let page = 0; page < 10; page++) {
    const res = await api("GET", "/bank/inbox");
    const fresh = (res.batches || []).filter((b) => !claimed.some((c) => c.id === b.id));
    claimed.push(...fresh);
    if (!res.more || !fresh.length) break;
  }
  const legacy = await heldBatches();
  if (!claimed.length && !legacy.length) {
    await saveBankState({ lastPull: Date.now(), error: null });
    return { stats: sumStats([]) };
  }
  let b = ctx.budget();
  const start = b;
  const results = [];
  const done = []; const release = []; const held = [];
  for (const row of claimed) {
    const r = applyBankBatch(b, row.batch);
    b = r.budget;
    results.push(r.stats);
    if (!r.held) done.push(row.id);
    else if (batchCount(r.held) === batchCount(row.batch)) release.push(row.id);
    else { done.push(row.id); held.push(r.held); }
  }
  for (const batch of legacy) {
    const r = applyBankBatch(b, batch);
    b = r.budget;
    results.push(r.stats);
    if (r.held) held.push(r.held);
  }
  if (b !== start) {
    const budgets = ctx.state.budgets.map((x) => x.id === b.id ? b : x);
    await ctx.commit({ ...ctx.state, budgets });
    // The bank transactions must reach the server before the inbox lets go of them.
    await syncNow(ctx);
  }
  await api("POST", "/bank/ack", { ids: done, release, held });
  if (legacy.length) await deviceSet("bankHeld", []);
  const stats = sumStats(results);
  await saveBankState({ lastPull: Date.now(), lastStats: stats, waiting: held.length + release.length, error: null });
  return { stats, text: statsLine(stats) };
}

/** Put the server's account list into the budget so each account can be mapped. Owners only (it changes bank links). */
export async function rememberItems(ctx, items) {
  if (!(await bankAccess()).canManage) return;
  let b = ctx.budget();
  if (!b) return;
  const start = b;
  for (const it of items || []) {
    b = rememberBankAccounts(b, it.itemId, it.institution, (it.accounts || []).map((a) => ({ account_id: a.id, name: a.name, mask: a.mask, type: a.type, subtype: a.subtype })));
  }
  if (b !== start) ctx.commit({ ...ctx.state, budgets: ctx.state.budgets.map((x) => x.id === b.id ? b : x) }, { undo: false });
}

/** Quietly check for new bank transactions when the app opens or comes back. */
let lastAuto = 0;
export async function bankOnOpen(ctx) {
  if (Date.now() - lastAuto < 5 * 60000) return;
  lastAuto = Date.now();
  const access = await bankAccess();
  if (!access.signedIn || !navigator.onLine) return;
  if (access.canApply) {
    try {
      const res = await pullBank(ctx);
      const st = res?.stats;
      if (st && (st.added || st.updated || st.removed)) ctx.toast(`Bank sync: ${statsLine(st)}`);
    } catch (e) {
      await saveBankState({ error: e.message });
    }
  }
  try { await listItems(); } catch { /* shown in Settings */ }
}

/* ---------- Plaid Link ---------- */

let linkScript = null;
export function loadPlaidLink() {
  if (window.Plaid) return Promise.resolve(window.Plaid);
  if (linkScript) return linkScript;
  linkScript = new Promise((resolve, reject) => {
    const el = document.createElement("script");
    el.src = PLAID_LINK_SRC;
    el.async = true;
    el.onload = () => (window.Plaid ? resolve(window.Plaid) : reject(new Error("Plaid Link didn’t load")));
    el.onerror = () => { linkScript = null; reject(new Error("Couldn’t load Plaid Link. Check your connection.")); };
    document.head.append(el);
  });
  return linkScript;
}

/**
 * Open Plaid Link. mode "create" adds a bank; "update" is Reconnect for an existing one.
 * connectedInstitutions guards the 10-login cap: picking a bank that's already connected closes Link
 * before any login is created.
 */
export async function openLink({ token, mode, itemId, connectedInstitutions = [], receivedRedirectUri, onDone, onDuplicate }) {
  const Plaid = await loadPlaidLink();
  if (!receivedRedirectUri) {
    try { localStorage.setItem(LINK_KEY, JSON.stringify({ token, mode, itemId: itemId || null, at: Date.now() })); } catch { /* ignore */ }
  }
  let handler = null;
  let dupe = false;
  const finish = (result) => {
    try { localStorage.removeItem(LINK_KEY); localStorage.removeItem(OAUTH_KEY); } catch { /* ignore */ }
    try { handler?.destroy?.(); } catch { /* ignore */ }
    onDone?.(result);
  };
  handler = Plaid.create({
    token,
    receivedRedirectUri: receivedRedirectUri || undefined,
    onSuccess: async (publicToken, metadata) => {
      try {
        if (mode === "update") { await markRepaired(itemId); finish({ ok: true, mode }); return; }
        const res = await exchangePublicToken(publicToken, metadata);
        finish({ ok: true, mode, item: res.item });
      } catch (e) { finish({ ok: false, message: e.message, data: e.data }); }
    },
    onExit: (err) => {
      if (dupe) { finish({ ok: false, duplicate: true }); return; }
      finish({ ok: false, cancelled: !err, message: err?.display_message || err?.error_message || null });
    },
    onEvent: (name, meta) => {
      if (mode !== "update" && name === "SELECT_INSTITUTION" && meta?.institution_id && connectedInstitutions.includes(meta.institution_id)) {
        dupe = true;
        onDuplicate?.(meta.institution_name);
        try { handler.exit({ force: true }); } catch { /* ignore */ }
      }
    },
  });
  handler.open();
  return handler;
}

/** After a bank's own sign-in page sends the user back to oauth.html, Link picks up where it left off. */
export function pendingOAuth() {
  try {
    const href = localStorage.getItem(OAUTH_KEY);
    const link = JSON.parse(localStorage.getItem(LINK_KEY) || "null");
    if (!href || !link?.token) return null;
    if (Date.now() - (link.at || 0) > 30 * 60000) { localStorage.removeItem(OAUTH_KEY); localStorage.removeItem(LINK_KEY); return null; }
    return { ...link, receivedRedirectUri: href };
  } catch { return null; }
}

export function plainBankError(e) {
  const m = String(e?.message || e || "");
  if (e?.status === 0) return m;
  if (e?.data?.code === "SIGNED_OUT") return "Sign in with Google in Settings to use bank sync.";
  if (/Origin not allowed/.test(m)) return "The bank sync server doesn’t allow this app’s address yet.";
  return m || "Something went wrong";
}
