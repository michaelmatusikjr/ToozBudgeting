/**
 * Bank sync client. Talks to the toozbudgeting-bank Worker, keeps this device's private key,
 * opens Plaid Link, and applies what the Worker delivers through ctx.commit so it can be undone.
 */
import { deviceGet, deviceSet } from "./store.js?v=139";
import { b64urlToBytes } from "./util.js?v=139";
import { applyBankBatch, rememberBankAccounts, sumStats, statsLine } from "./bankmap.js?v=139";

export const BANK_DEFAULTS = {
  serverUrl: "https://toozbudgeting-bank.michael-matusik-jr.workers.dev",
};
export const PLAID_LINK_SRC = "https://cdn.plaid.com/link/v2/stable/link-initialize.js";
const KEY_DB = "toozbudgeting-bank";
const LINK_KEY = "toozbudgeting:bank:link";
const OAUTH_KEY = "toozbudgeting:bank:oauth";
const listeners = new Set();

export function onBankChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
const changed = () => listeners.forEach((fn) => { try { fn(); } catch { /* ignore */ } });

export async function bankConfig() {
  const o = (await deviceGet("bankConfig")) || {};
  return { serverUrl: String(o.serverUrl || BANK_DEFAULTS.serverUrl).trim().replace(/\/+$/, "") };
}
export async function setBankConfig(patch) {
  const next = { ...(await bankConfig()), ...patch };
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
export async function heldBatches() { return (await deviceGet("bankHeld")) || []; }
export const heldCount = (held) => (held || []).reduce((n, b) => n + (b.added?.length || 0) + (b.removed?.length || 0), 0);

/* ---------- device key: P-256 ECDH, private half never leaves this device ---------- */

function openKeyDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(KEY_DB, 1);
    req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains("kv")) req.result.createObjectStore("kv"); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idb(mode, fn) {
  const db = await openKeyDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction("kv", mode);
      const out = fn(tx.objectStore("kv"));
      tx.oncomplete = () => resolve(out?.result);
      tx.onerror = () => reject(tx.error);
    });
  } finally { db.close(); }
}
async function newDeviceKey() {
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  await idb("readwrite", (s) => s.put(pair, "device"));
  return pair;
}
async function deviceKey() { return idb("readonly", (s) => s.get("device")); }

const te = new TextEncoder();
/** Open a batch sealed by the Worker (ephemeral ECDH, HKDF-SHA256, AES-GCM). */
export async function openSealed(privateKey, sealed) {
  const o = typeof sealed === "string" ? JSON.parse(sealed) : sealed;
  const epkRaw = b64urlToBytes(o.epk);
  const epk = await crypto.subtle.importKey("raw", epkRaw, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const bits = await crypto.subtle.deriveBits({ name: "ECDH", public: epk }, privateKey, 256);
  const ikm = await crypto.subtle.importKey("raw", bits, "HKDF", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: epkRaw, info: te.encode("toozbudgeting-bank-v1") }, ikm, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64urlToBytes(o.iv) }, key, b64urlToBytes(o.ct));
  return JSON.parse(new TextDecoder().decode(pt));
}

/* ---------- server calls ---------- */

export class BankError extends Error { constructor(status, message, data) { super(message); this.status = status; this.data = data; } }

async function api(method, path, body, { auth = true } = {}) {
  const cfg = await bankConfig();
  const s = await bankState();
  const headers = body === undefined ? {} : { "Content-Type": "application/json" };
  if (auth) {
    if (!s.token) throw new BankError(401, "Pair this device first");
    headers.Authorization = "Bearer " + s.token;
  }
  let res;
  try {
    res = await fetch(cfg.serverUrl + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), mode: "cors" });
  } catch { throw new BankError(0, navigator.onLine ? "Can’t reach the bank sync server" : "You’re offline"); }
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) {
    if (res.status === 401 && auth) await saveBankState({ token: null, deviceId: null, error: "This device was unpaired. Pair it again." });
    throw new BankError(res.status, data?.error || `HTTP ${res.status}`, data);
  }
  return data;
}

export const isPaired = async () => !!(await bankState()).token;

export async function bankHealth() {
  try { return { reachable: true, ...(await api("GET", "/bank/health", undefined, { auth: false })) }; }
  catch (e) { return { reachable: false, error: e.message }; }
}

export async function pairDevice(secret, name) {
  const pair = await newDeviceKey();
  const publicKey = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const res = await api("POST", "/bank/pair", { secret: String(secret || "").trim(), publicKey, name: name || deviceName() }, { auth: false });
  await saveBankState({ token: res.token, deviceId: res.deviceId, pairedAt: Date.now(), error: null });
  return res;
}

export async function unpairDevice() {
  try { await api("DELETE", "/bank/device"); } catch { /* already gone */ }
  await saveBankState({ token: null, deviceId: null, items: null, error: null, lastPull: null });
}

function deviceName() {
  const ua = navigator.userAgent || "";
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return "Android";
  if (/Mac/.test(ua)) return "Mac";
  if (/Windows/.test(ua)) return "Windows";
  return "Browser";
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

/** Pull the inbox, apply every batch (and anything held for mapping) in one undoable commit, then ack. */
export function pullBank(ctx) {
  if (pulling) return pulling;
  pulling = (async () => {
    try { return await pullInner(ctx); }
    finally { pulling = null; }
  })();
  return pulling;
}

async function pullInner(ctx) {
  const s = await bankState();
  if (!s.token || !ctx.budget()) return { stats: null };
  const pair = await deviceKey();
  if (!pair?.privateKey) {
    await saveBankState({ error: "This device lost its bank key. Unpair and pair again." });
    return { stats: null };
  }
  const batches = [];
  const ids = [];
  let after = 0;
  for (let page = 0; page < 10; page++) {
    const res = await api("GET", `/bank/inbox?after=${after}`);
    for (const row of res.batches || []) {
      after = row.id;
      try { batches.push(await openSealed(pair.privateKey, row.enc)); ids.push(row.id); }
      catch { await saveBankState({ error: "A bank update couldn’t be opened on this device." }); }
    }
    if (!res.more) break;
  }
  const held = await heldBatches();
  if (!batches.length && !held.length) {
    await saveBankState({ lastPull: Date.now(), error: null });
    return { stats: sumStats([]) };
  }
  let b = ctx.budget();
  const start = b;
  const results = [];
  const nextHeld = [];
  for (const batch of [...held, ...batches]) {
    const r = applyBankBatch(b, batch);
    b = r.budget;
    results.push(r.stats);
    if (r.held) nextHeld.push(r.held);
  }
  if (b !== start) {
    const budgets = ctx.state.budgets.map((x) => x.id === b.id ? b : x);
    await ctx.commit({ ...ctx.state, budgets });
  }
  await deviceSet("bankHeld", nextHeld);
  for (let i = 0; i < ids.length; i += 200) await api("POST", "/bank/ack", { ids: ids.slice(i, i + 200) });
  const stats = sumStats(results);
  await saveBankState({ lastPull: Date.now(), lastStats: stats, error: null });
  return { stats, text: statsLine(stats) };
}

/** Put the server's account list into the budget so each account can be mapped. */
export function rememberItems(ctx, items) {
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
  if (!(await isPaired()) || !navigator.onLine) return;
  try {
    const res = await pullBank(ctx);
    const st = res?.stats;
    if (st && (st.added || st.updated || st.removed)) ctx.toast(`Bank sync: ${statsLine(st)}`);
  } catch (e) {
    await saveBankState({ error: e.message });
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
  if (/Origin not allowed/.test(m)) return "The bank sync server doesn’t allow this app’s address yet.";
  return m || "Something went wrong";
}
