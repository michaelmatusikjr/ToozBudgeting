/** Closed-app Web Push. Rules are encrypted on device; the server only stores ciphertext. */
import { deviceGet, deviceSet } from "./store.js?v=138";
import { b64url, b64urlToBytes, timeZone } from "./util.js?v=138";
import { isIOS, isStandalone } from "./pwa.js?v=138";

export const DEFAULTS = {
  serverUrl: "https://toozbudgeting-push.michael-matusik-jr.workers.dev",
  publicKey: "BDQvhK5lTtYsNcCnwLFypiHs1tv0AY0gQhqWvn7_SpIJlJS9gjnM-3qJ6iJ7KyVWVP2y6-moAB7lP4ITb2iIk20",
  registerKey: "TNZXD8EErlnZJAmsnT38xMOIHEh9u695",
};

const KEY_DB = "toozbudgeting-push";
const listeners = new Set();
let mem = null;

export function onPushChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
const changed = () => listeners.forEach((fn) => { try { fn(); } catch { /* ignore */ } });

export async function pushConfig() {
  const o = (await deviceGet("pushConfig")) || {};
  return {
    serverUrl: String(o.serverUrl || DEFAULTS.serverUrl).trim().replace(/\/+$/, ""),
    publicKey: String(o.publicKey || DEFAULTS.publicKey).trim(),
    registerKey: String(o.registerKey || DEFAULTS.registerKey).trim(),
  };
}
export async function setPushConfig(patch) {
  const cur = await pushConfig();
  const next = { ...cur, ...patch };
  next.serverUrl = String(next.serverUrl || "").trim().replace(/\/+$/, "");
  await deviceSet("pushConfig", next);
  changed();
}
async function loadState() { return (await deviceGet("pushState")) || {}; }
async function saveState(patch) {
  const s = { ...(await loadState()), ...patch };
  await deviceSet("pushState", s);
  changed();
  return s;
}

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
export async function ensureKey() {
  if (mem?.key) return mem;
  const rec = await idb("readonly", (s) => s.get("reminder"));
  if (rec?.key) { mem = rec; return rec; }
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  mem = { key, kid: b64url(crypto.getRandomValues(new Uint8Array(8))), created: Date.now() };
  await idb("readwrite", (s) => s.put(mem, "reminder"));
  return mem;
}
export async function encryptJson(rec, ruleId, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(ruleId) },
    rec.key, new TextEncoder().encode(JSON.stringify(obj)),
  ));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv); out.set(ct, 12);
  return rec.kid + b64url(out);
}

class ApiError extends Error { constructor(status, message) { super(message); this.status = status; } }
async function api(method, path, body, { auth = true } = {}) {
  const cfg = await pushConfig();
  const state = await loadState();
  const headers = body === undefined ? {} : { "Content-Type": "application/json" };
  if (auth) { headers.Authorization = "Bearer " + state.token; headers["X-Device"] = state.deviceId; }
  if (path === "/api/register" && cfg.registerKey) headers["X-Register-Key"] = cfg.registerKey;
  let res;
  try {
    res = await fetch(cfg.serverUrl + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), mode: "cors" });
  } catch { throw new ApiError(0, navigator.onLine ? "network error" : "offline"); }
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) throw new ApiError(res.status, data?.error || `HTTP ${res.status}`);
  return data;
}

function plainError(e) {
  const m = String(e?.message || e || "");
  if (e?.status === 0) return navigator.onLine ? "Can’t reach your server" : "You’re offline";
  if (/Origin not allowed/.test(m)) return "This server doesn’t allow this app’s address yet.";
  if (/Wrong register key/.test(m)) return "The register key doesn’t match the server.";
  if (/must be encrypted|title\/body/.test(m)) return "The server refused plaintext reminders.";
  if (/kind must be/.test(m)) return m;
  return m || "Something went wrong";
}

export function healthProblem(h, cfg) {
  if (!h) return null;
  if (!h.reachable) return "Can’t reach the push server right now.";
  if (h.db === false) return "The push server’s database isn’t ready.";
  if (!h.vapidPublic) return "The push server has no public key.";
  if (!h.vapidPrivate) return "The push server is missing its private key.";
  if (!h.registerKey) return "The push server has no register key.";
  if (h.vapidPublicKey && cfg?.publicKey && h.vapidPublicKey !== cfg.publicKey) return "The public key in Advanced doesn’t match the server.";
  if (h.lastCronError) return `The server timer reported an error: ${h.lastCronError}`;
  if (!h.lastCronAt) return "The server timer hasn’t run yet.";
  if (h.time && h.time - h.lastCronAt > 5 * 60000) return "The server timer isn’t running.";
  return null;
}

export const pushSupported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

export async function pushStatus() {
  const s = await loadState();
  const perm = "Notification" in window ? Notification.permission : "denied";
  if (isIOS() && !isStandalone()) return { kind: "ios", text: "On iPhone and iPad, closed-app reminders need ToozBudgeting on your Home Screen (Share, then Add to Home Screen) and iOS 16.4 or later." };
  if (!pushSupported()) return { kind: "unsupported", text: "This browser can’t receive push notifications." };
  if (!s.on) return { kind: "off", text: "Off. Local reminders still fire while the app is open." };
  if (perm === "denied") return { kind: "blocked", text: "Notifications are blocked for this app. Allow them in system settings." };
  if (s.pending && !navigator.onLine) return { kind: "offline", text: "Waiting to sync. You’re offline." };
  if (s.error) return { kind: "error", text: s.error };
  const hp = healthProblem(s.health, await pushConfig());
  if (hp) return { kind: "error", text: hp };
  if (s.pending || !s.lastOk) return { kind: "pending", text: "Syncing reminder rules…" };
  return { kind: "on", text: `On. Last synced ${new Date(s.lastOk).toLocaleString()}.` };
}

async function registration() {
  const reg = await navigator.serviceWorker.ready;
  return reg;
}
async function currentSubscription(cfg) {
  const reg = await registration();
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64urlToBytes(cfg.publicKey) });
  return sub;
}

/** Map budgeting reminders onto the server's rule shape. Kinds the server rejects are retried as task/habit. */
export function buildRules(budget) {
  const rules = [];
  const tz = timeZone();
  for (const r of budget?.reminders || []) {
    if (r.enabled === false) continue;
    const recurType = r.recur?.type || (r.date ? "none" : "monthly");
    const kind = r.serverKind || (recurType === "none" ? "task" : "habit");
    const rule = {
      id: String(r.id).replace(/[^\w:.-]/g, "_").slice(0, 128),
      kind,
      url: r.url || "./",
      tag: (r.tag || r.id).slice(0, 128),
      time: r.time || "09:00",
      offsetDays: Math.max(-7, Math.min(0, r.offsetDays || 0)),
      recur: recurType === "none" ? { type: "none" } : {
        type: recurType === "monthly" ? "monthly" : recurType,
        start: r.recur?.start || r.date || new Date().toISOString().slice(0, 10),
        ...(recurType === "weekly" ? { days: r.recur?.days || [] } : {}),
        ...(recurType === "interval" ? { interval: r.recur?.interval || 1 } : {}),
      },
      exceptions: r.exceptions || [],
      skipDates: r.skipDates || [],
      title: r.title || "ToozBudgeting",
      body: r.body || "Open ToozBudgeting",
    };
    if (recurType === "none") rule.date = r.date;
    rules.push(rule);
  }
  return { tz, rules };
}

async function seal(rules) {
  const rec = await ensureKey();
  const sealed = [];
  for (const { title, body, serverKind, ...rest } of rules) {
    const enc = await encryptJson(rec, rest.id, { title: String(title || "").slice(0, 180), body: String(body || "").slice(0, 400) });
    sealed.push({ ...rest, enc });
  }
  return sealed;
}

export async function syncSchedule(budget) {
  const s = await loadState();
  if (!s.on || !s.token) return;
  const { tz, rules } = buildRules(budget);
  let payloadRules = await seal(rules);
  try {
    await api("PUT", "/api/schedule", { tz, rules: payloadRules });
  } catch (e) {
    if (/kind must be/.test(String(e.message))) {
      payloadRules = payloadRules.map((r) => ({ ...r, kind: r.recur?.type === "none" ? "task" : "habit" }));
      await api("PUT", "/api/schedule", { tz, rules: payloadRules });
    } else throw e;
  }
  await saveState({ lastOk: Date.now(), pending: false, error: null });
}

export async function checkHealth() {
  try {
    const data = await api("GET", "/api/health", undefined, { auth: false });
    const h = { ...data, reachable: true, at: Date.now() };
    await saveState({ health: h });
    return h;
  } catch {
    const h = { reachable: false, at: Date.now() };
    await saveState({ health: h });
    return h;
  }
}

export async function enablePush() {
  const cfg = await pushConfig();
  if (isIOS() && !isStandalone()) return { ok: false, message: "Add ToozBudgeting to your Home Screen first (iOS 16.4 or later)." };
  if (!pushSupported()) return { ok: false, message: "This browser can’t receive push notifications." };
  let perm = Notification.permission;
  if (perm === "default") perm = await Notification.requestPermission();
  if (perm !== "granted") return { ok: false, message: "Notification permission was not granted." };
  try {
    const sub = await currentSubscription(cfg);
    const { deviceId, token } = await api("POST", "/api/register", { subscription: sub.toJSON() }, { auth: false });
    await saveState({ on: true, deviceId, token, endpoint: sub.endpoint, pending: true, error: null });
    await checkHealth();
    return { ok: true };
  } catch (e) {
    return { ok: false, message: plainError(e) };
  }
}

export async function disablePush() {
  const s = await loadState();
  try { if (s.token) await api("DELETE", "/api/device"); } catch { /* already gone */ }
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = await reg?.pushManager?.getSubscription();
    await sub?.unsubscribe();
  } catch { /* ignore */ }
  await saveState({ on: false, token: null, deviceId: null, pending: false, error: null, lastOk: null });
}

export async function pushOnOpen(budget) {
  const s = await loadState();
  if (!s.on) return;
  try {
    const cfg = await pushConfig();
    const sub = await currentSubscription(cfg);
    if (sub && sub.endpoint !== s.endpoint) {
      await api("POST", "/api/subscription", { subscription: sub.toJSON() });
      await saveState({ endpoint: sub.endpoint });
    }
  } catch { /* reported by sync */ }
  try { await syncSchedule(budget); } catch (e) { await saveState({ pending: true, error: plainError(e) }); }
  await checkHealth();
}
