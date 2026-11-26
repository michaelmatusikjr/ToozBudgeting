/**
 * Persistence.
 * Core budget data is stored as individual records (id, t, dev, sv) so a later
 * encrypted sync can latest-edit-wins on (t, dev) and pull a change log.
 * Device-only settings (theme, push credentials, fired reminders, session chrome)
 * live in a separate store and are never part of the budget export.
 */
import { SCHEMA_VERSION, deepClone, randomDeviceId, b64url } from "./util.js?v=134";
import { emptyApp, normalizeBudget } from "./mutate.js?v=134";

const DB_NAME = "toozbudgeting";
const DB_VER = 1;
const SNAP_KEY = "toozbudgeting:snapshot";
const DEV_KEY = "toozbudgeting:device";

let dbp = null;
let deviceId = null;
let memoryRecords = new Map();
const listeners = new Set();

function openDb() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) { reject(new Error("no idb")); return; }
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("records")) {
        const s = db.createObjectStore("records", { keyPath: "id" });
        s.createIndex("kind", "kind");
        s.createIndex("budgetId", "budgetId");
      }
      if (!db.objectStoreNames.contains("changes")) {
        const c = db.createObjectStore("changes", { keyPath: "seq", autoIncrement: true });
        c.createIndex("t", "t");
      }
      if (!db.objectStoreNames.contains("device")) db.createObjectStore("device");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

async function idbDo(store, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const out = fn(tx.objectStore(store), tx);
    tx.oncomplete = () => resolve(out);
    tx.onerror = () => reject(tx.error);
  });
}

export async function ensureDeviceId() {
  if (deviceId) return deviceId;
  try {
    const saved = localStorage.getItem(DEV_KEY);
    if (saved) { deviceId = saved; return deviceId; }
  } catch { /* ignore */ }
  try {
    const fromDb = await idbDo("device", "readonly", (s) => {
      const r = s.get("deviceId");
      return new Promise((res) => { r.onsuccess = () => res(r.result); r.onerror = () => res(null); });
    });
    if (fromDb) { deviceId = fromDb; try { localStorage.setItem(DEV_KEY, deviceId); } catch { /* ignore */ } return deviceId; }
  } catch { /* idb down */ }
  deviceId = randomDeviceId();
  try { localStorage.setItem(DEV_KEY, deviceId); } catch { /* ignore */ }
  try { await idbDo("device", "readwrite", (s) => s.put(deviceId, "deviceId")); } catch { /* ignore */ }
  return deviceId;
}

export const getDeviceId = () => deviceId;

export async function deviceGet(key) {
  try {
    return await idbDo("device", "readonly", (s) => new Promise((res) => {
      const r = s.get(key);
      r.onsuccess = () => res(r.result ?? null);
      r.onerror = () => res(null);
    }));
  } catch {
    try { return JSON.parse(localStorage.getItem("toozbudgeting:dev:" + key) || "null"); } catch { return null; }
  }
}

export async function deviceSet(key, value) {
  try { await idbDo("device", "readwrite", (s) => s.put(value, key)); }
  catch { try { localStorage.setItem("toozbudgeting:dev:" + key, JSON.stringify(value)); } catch { /* ignore */ } }
}

function rec(kind, id, budgetId, body, prev) {
  const json = JSON.stringify(body);
  if (prev && !prev.deleted && prev._json === json) return prev;
  return {
    id, kind, budgetId: budgetId || null,
    t: Date.now(), dev: deviceId, sv: SCHEMA_VERSION,
    deleted: false, body, _json: json,
  };
}

function explode(state) {
  const out = new Map();
  const put = (r) => out.set(r.id, r);
  put(rec("app", "app", null, {
    sv: SCHEMA_VERSION,
    setupComplete: !!state.setupComplete,
    activeBudgetId: state.activeBudgetId || null,
    activeUserId: state.activeUserId || null,
  }, memoryRecords.get("app")));
  for (const u of state.users || []) put(rec("user", "user:" + u.userId, null, u, memoryRecords.get("user:" + u.userId)));
  for (const b of state.budgets || []) {
    const header = {
      id: b.id, name: b.name, createdAt: b.createdAt, archived: !!b.archived, ownerId: b.ownerId || null,
      mergeExcludeWords: b.mergeExcludeWords || ["TST*"],
      rejectedMerges: b.rejectedMerges || [],
      moneyMoveLog: b.moneyMoveLog || [],
      csvMappings: b.csvMappings || {},
      pendingDuplicates: b.pendingDuplicates || [],
    };
    put(rec("budget", "budget:" + b.id, b.id, header, memoryRecords.get("budget:" + b.id)));
    for (const a of b.accounts || []) put(rec("account", "account:" + a.id, b.id, a, memoryRecords.get("account:" + a.id)));
    for (const c of b.creditCards || []) put(rec("creditCard", "card:" + c.id, b.id, c, memoryRecords.get("card:" + c.id)));
    for (const g of b.categoryGroups || []) put(rec("categoryGroup", "group:" + g.id, b.id, g, memoryRecords.get("group:" + g.id)));
    for (const c of b.categories || []) put(rec("category", "category:" + c.id, b.id, c, memoryRecords.get("category:" + c.id)));
    for (const tx of b.transactions || []) put(rec("transaction", "tx:" + tx.id, b.id, tx, memoryRecords.get("tx:" + tx.id)));
    for (const p of b.payees || []) put(rec("payee", "payee:" + p.id, b.id, p, memoryRecords.get("payee:" + p.id)));
    for (const [mk, amounts] of Object.entries(b.monthlyBudgets || {})) {
      const id = `mb:${b.id}:${mk}`;
      put(rec("assignment", id, b.id, { month: mk, amounts }, memoryRecords.get(id)));
    }
    for (const [mk, amount] of Object.entries(b.inflows || {})) {
      const id = `in:${b.id}:${mk}`;
      put(rec("inflow", id, b.id, { month: mk, amount }, memoryRecords.get(id)));
    }
    for (const [mk, notes] of Object.entries(b.categoryNotes || {})) {
      const id = `notes:${b.id}:${mk}`;
      put(rec("note", id, b.id, { month: mk, notes }, memoryRecords.get(id)));
    }
    for (const r of b.reminders || []) put(rec("reminder", "rem:" + r.id, b.id, r, memoryRecords.get("rem:" + r.id)));
  }
  return out;
}

function assemble(records) {
  const list = [...records.values()].filter((r) => r && !r.deleted);
  const app = list.find((r) => r.id === "app")?.body || {};
  const users = list.filter((r) => r.kind === "user").map((r) => r.body);
  const budgets = list.filter((r) => r.kind === "budget").map((r) => {
    const id = r.body.id;
    const kids = list.filter((x) => x.budgetId === id);
    const b = {
      ...r.body,
      accounts: kids.filter((x) => x.kind === "account").map((x) => x.body),
      creditCards: kids.filter((x) => x.kind === "creditCard").map((x) => x.body),
      categoryGroups: kids.filter((x) => x.kind === "categoryGroup").map((x) => x.body),
      categories: kids.filter((x) => x.kind === "category").map((x) => x.body),
      transactions: kids.filter((x) => x.kind === "transaction").map((x) => x.body),
      payees: kids.filter((x) => x.kind === "payee").map((x) => x.body),
      reminders: kids.filter((x) => x.kind === "reminder").map((x) => x.body),
      monthlyBudgets: {}, inflows: {}, categoryNotes: {},
    };
    for (const x of kids.filter((k) => k.kind === "assignment")) b.monthlyBudgets[x.body.month] = x.body.amounts || {};
    for (const x of kids.filter((k) => k.kind === "inflow")) b.inflows[x.body.month] = x.body.amount || 0;
    for (const x of kids.filter((k) => k.kind === "note")) b.categoryNotes[x.body.month] = x.body.notes || {};
    return normalizeBudget(b);
  });
  const state = {
    sv: SCHEMA_VERSION,
    setupComplete: !!app.setupComplete && budgets.length > 0,
    activeBudgetId: app.activeBudgetId || budgets[0]?.id || null,
    activeUserId: app.activeUserId || null,
    users, budgets,
  };
  if (state.activeUserId && !users.some((u) => u.userId === state.activeUserId)) state.activeUserId = null;
  return migrate(state);
}

export function migrate(state) {
  const s = state && typeof state === "object" ? state : emptyApp();
  const sv = Number(s.sv) || 1;
  let cur = { ...emptyApp(), ...s, sv };
  if (!Array.isArray(cur.budgets)) cur.budgets = [];
  if (!Array.isArray(cur.users)) cur.users = [];
  cur.budgets = cur.budgets.map(normalizeBudget);
  if (sv < 1) cur.sv = 1;
  cur.sv = SCHEMA_VERSION;
  if (!cur.setupComplete && cur.budgets.length) cur.setupComplete = true;
  return cur;
}

async function readAllRecords() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("records", "readonly");
    const req = tx.objectStore("records").getAll();
    req.onsuccess = () => {
      const map = new Map();
      for (const r of req.result || []) map.set(r.id, { ...r, _json: JSON.stringify(r.body) });
      resolve(map);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function loadState() {
  await ensureDeviceId();
  try {
    memoryRecords = await readAllRecords();
    if (memoryRecords.size) return assemble(memoryRecords);
  } catch { /* fall through */ }
  try {
    const raw = localStorage.getItem(SNAP_KEY);
    if (raw) return migrate(JSON.parse(raw));
  } catch { /* ignore */ }
  return emptyApp();
}

async function writeChanges(changed) {
  if (!changed.length) return;
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(["records", "changes"], "readwrite");
      const recs = tx.objectStore("records");
      const ch = tx.objectStore("changes");
      for (const r of changed) {
        const { _json, ...stored } = r;
        recs.put(stored);
        ch.add({ id: uidChange(), recordId: r.id, kind: r.kind, op: r.deleted ? "delete" : "upsert", t: r.t, dev: r.dev, sv: r.sv });
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch { /* snapshot fallback below */ }
}

function uidChange() {
  const b = new Uint8Array(6);
  crypto.getRandomValues(b);
  return b64url(b);
}

export async function saveState(state) {
  const next = explode(state);
  const changed = [];
  for (const [id, r] of next) {
    const prev = memoryRecords.get(id);
    if (!prev || prev._json !== r._json || prev.deleted) changed.push(r);
  }
  for (const [id, prev] of memoryRecords) {
    if (prev.deleted) continue;
    if (!next.has(id)) {
      changed.push({ ...prev, deleted: true, t: Date.now(), dev: deviceId, sv: SCHEMA_VERSION, body: prev.body });
    }
  }
  memoryRecords = next;
  await writeChanges(changed);
  try { localStorage.setItem(SNAP_KEY, JSON.stringify(state)); } catch { /* quota */ }
  return changed.length;
}

export function exportData(state) {
  return {
    app: "ToozBudgeting",
    schemaVersion: SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    setupComplete: !!state.setupComplete,
    activeBudgetId: state.activeBudgetId,
    users: (state.users || []).map((u) => ({ ...u })),
    budgets: (state.budgets || []).map((b) => deepClone(b)),
  };
}

export function importData(parsed) {
  if (!parsed || typeof parsed !== "object") throw new Error("That file is not a ToozBudgeting backup.");
  const budgets = parsed.budgets || parsed.data?.budgets;
  if (!Array.isArray(budgets)) throw new Error("This doesn't look like a budget backup.");
  const users = Array.isArray(parsed.users) ? parsed.users : [];
  const state = migrate({
    sv: SCHEMA_VERSION,
    setupComplete: true,
    activeBudgetId: parsed.activeBudgetId || budgets[0]?.id || null,
    activeUserId: parsed.activeUserId || users[0]?.userId || null,
    users, budgets,
  });
  return state;
}

/** Read the shadow log (newest last). For a future sync engine. */
export async function readChanges(sinceSeq = 0, limit = 500) {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction("changes", "readonly");
      const req = tx.objectStore("changes").getAll();
      req.onsuccess = () => {
        const rows = (req.result || []).filter((r) => r.seq > sinceSeq).slice(0, limit);
        resolve(rows);
      };
      req.onerror = () => reject(req.error);
    });
  } catch { return []; }
}

export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export const emit = () => listeners.forEach((fn) => { try { fn(); } catch { /* ignore */ } });
