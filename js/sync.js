/**
 * Household budget sync engine.
 *
 * Every change is already saved on this device first, so the app works offline. When signed in, this
 * pushes changed records to the household server and pulls everyone else's, on open, when the app comes
 * back to the front, a moment after each change, and every minute while it's open.
 * Conflicts are last-write-wins per record (one transaction, one category, one month's amount for one
 * category), so two people editing different things never collide.
 */
import { account, api, patchAccount, refreshMe, onAccountChange } from "./account.js?v=151";
import { pendingRecords, markPushed, applyRemote, reloadState, markAllDirty, clearSharedRecords, exportData, deviceSet, deviceGet } from "./store.js?v=151";

const PUSH_BYTES = 350 * 1024;
const PUSH_MAX = 800;
const EVERY_MS = 60000;
const AFTER_EDIT_MS = 1500;

const status = { busy: false, lastSyncAt: null, error: null, uploaded: 0, total: 0 };
const listeners = new Set();
export const syncStatus = () => ({ ...status });
export function onSyncChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
const emit = () => listeners.forEach((fn) => { try { fn(syncStatus()); } catch { /* ignore */ } });

let running = null;
let again = false;

/** Run a sync now (or right after the one in progress). Resolves with { pushed, pulled } or { skipped }. */
export function syncNow(ctx) {
  if (running) { again = true; return running; }
  running = (async () => {
    try {
      let out;
      do { again = false; out = await syncInner(ctx); } while (again);
      return out;
    } finally { running = null; }
  })();
  return running;
}

function chunks(list) {
  const out = []; let cur = []; let bytes = 0;
  for (const r of list) {
    const n = JSON.stringify(r).length + 1;
    if (cur.length && (bytes + n > PUSH_BYTES || cur.length >= PUSH_MAX)) { out.push(cur); cur = []; bytes = 0; }
    cur.push(r); bytes += n;
  }
  if (cur.length) out.push(cur);
  return out;
}

/**
 * The first time this device syncs with a household:
 * - empty household: upload this device's budget (it becomes the household's),
 * - household already has a budget: keep a backup of this device's budget, then use the household's.
 */
async function firstLink(ctx, a) {
  const fresh = await refreshMe();
  const me = fresh?.me || a.me;
  const local = (ctx.state?.budgets || []).length > 0;
  if (!me.household.records) {
    if (local && me.role !== "viewer") await markAllDirty();
    await patchAccount({ linked: true, cursor: 0, accessRev: me.accessRev, firstLink: local ? "uploaded" : "empty" });
    return;
  }
  if (local) await deviceSet("preSyncBackup", { at: Date.now(), data: exportData(ctx.state) });
  // Always start clean, so nothing left on this device (old edits, deletions) overwrites the household.
  await clearSharedRecords();
  await patchAccount({ linked: true, cursor: 0, accessRev: me.accessRev, firstLink: local ? "replaced" : "joined" });
}

async function syncInner(ctx) {
  let a = await account();
  if (!a?.token) return { skipped: "signed-out" };
  if (typeof navigator !== "undefined" && navigator.onLine === false) return { skipped: "offline" };
  status.busy = true; status.error = null; emit();
  try {
    if (!a.linked) { await firstLink(ctx, a); a = await account(); }
    const role = a.me?.role;
    const fromPush = [];
    let pushed = 0;
    let cursor = a.cursor || 0;
    if (role && role !== "viewer") {
      const pend = await pendingRecords();
      status.total = pend.length; status.uploaded = 0; emit();
      for (const part of chunks(pend)) {
        const res = await api("POST", "/sync/push", { records: part });
        await markPushed(part);
        fromPush.push(...(res.current || []));
        pushed += res.applied || 0;
        // Nobody else wrote since our last pull: skip pulling our own records back.
        if (res.from === cursor) cursor = res.seq;
        status.uploaded += part.length; emit();
      }
    }
    let accessRev = a.accessRev;
    let changed = await applyRemote(fromPush);
    let pulled = 0;
    for (let page = 0; page < 100; page++) {
      const res = await api("GET", `/sync/pull?since=${cursor}`);
      if (res.accessRev !== accessRev && cursor > 0) {
        // What this person may see changed. Start over from the beginning.
        accessRev = res.accessRev; cursor = 0;
        continue;
      }
      accessRev = res.accessRev;
      changed += await applyRemote(res.records || []);
      pulled += (res.records || []).length;
      cursor = res.seq;
      if (!res.more) break;
    }
    if (role !== a.me?.role || accessRev !== a.accessRev) await refreshMe().catch(() => {});
    await patchAccount({ cursor, accessRev, lastSyncAt: Date.now(), syncError: null });
    if (changed) ctx.applyRemoteState?.(await reloadState());
    status.lastSyncAt = Date.now();
    return { pushed, pulled, changed };
  } catch (e) {
    status.error = e.message;
    try { await patchAccount({ syncError: e.message }); } catch { /* ignore */ }
    throw e;
  } finally {
    status.busy = false; emit();
  }
}

/** Kick off sync now, and keep syncing while the app is open. Safe to call more than once. */
let started = false;
let timer = null;
let editTimer = null;
export function startAutoSync(ctx) {
  const run = () => syncNow(ctx).catch(() => { /* shown in Settings */ });
  run();
  if (started) return;
  started = true;
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") run(); });
  window.addEventListener("online", run);
  window.addEventListener("focus", run);
  timer = setInterval(() => { if (document.visibilityState === "visible") run(); }, EVERY_MS);
  onAccountChange(async () => { if ((await account())?.token && !running) run(); });
  void timer;
}

/** Called after every local change; pushes a moment later so quick edits go up together. */
export function syncSoon(ctx) {
  clearTimeout(editTimer);
  editTimer = setTimeout(async () => { if ((await account())?.token) syncNow(ctx).catch(() => {}); }, AFTER_EDIT_MS);
}

export async function preSyncBackup() { return deviceGet("preSyncBackup"); }
