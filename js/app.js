import { APP_VERSION, monthKey, prevMonth, nextMonth, deepClone, fmt, monthLabel } from "./util.js?v=154";
import { loadState, saveState, subscribe, exportData, importData, deviceGet, deviceSet } from "./store.js?v=154";
import { h, clear, icon, toast, closeAllModals, btn } from "./ui.js?v=154";
import { renderIdentity, renderWizard, renderLoading } from "./views/gate.js?v=154";
import { renderBudget, openInbox, openHistory } from "./views/budget.js?v=154";
import { renderTransactions, openTx, applyTxNav } from "./views/transactions.js?v=154";
import { renderAccounts } from "./views/accounts.js?v=154";
import { renderPayees } from "./views/payees.js?v=154";
import { renderSettings } from "./views/settings.js?v=154";
import { registerSW, activateWaiting } from "./pwa.js?v=154";
import { scheduleLocal, collectReminders } from "./notify.js?v=154";
import { pushCleanupOnce } from "./push.js?v=154";
import { bankOnOpen } from "./banksync.js?v=154";
import { normalizeBudget } from "./mutate.js?v=154";
import { announceIfUpdated } from "./whatsnew.js?v=154";
import { paintTheme, resolveTheme } from "./theme.js?v=154";
import { monthAccessible, globalFree, assignedAhead } from "./calc.js?v=154";
import { account, redeemSignInCode, onAccountChange, signOut, withCode, setPendingInvite, pendingInvite, isInviteId } from "./account.js?v=154";
import { startAutoSync, syncSoon, syncNow, syncStatus, onSyncChange } from "./sync.js?v=154";
await import("./dev/testtools.js?v=152").catch(() => {}); // 🧪 TEST TOOLS: delete this line to remove Load Test Data + Test Wizard

const root = document.getElementById("app");
const undoStack = [];
const redoStack = [];

/** A local profile for the signed-in Google account, so the rest of the app knows who's here. */
function accountUser(acct) {
  const u = acct?.me?.user;
  if (!u) return null;
  return {
    userId: "acct:" + u.id, displayName: u.displayName || u.name || u.email, email: u.email || "", picture: u.picture || null,
    isGuest: false, account: true, role: acct.me.role, passwordHash: "", createdAt: new Date().toISOString(),
  };
}

let pendingRemote = false;

const ctx = {
  state: null,
  account: null,
  month: monthKey(),
  nav: "budget",
  ui: { collapsed: {}, showArchived: false, txFilter: {}, txQuery: "", txChips: [], showTxFilters: false, showReconciled: false, selected: new Set(), payeeQuery: "", avg: null },
  budget() {
    return ctx.state?.budgets?.find((b) => b.id === ctx.state.activeBudgetId) || ctx.state?.budgets?.[0] || null;
  },
  readOnly() { return !!ctx.account?.token && ctx.account?.me?.role === "viewer"; },
  async commit(next, { undo = true } = {}) {
    if (!next) return;
    if (ctx.readOnly() && next.budgets !== ctx.state?.budgets) {
      toast("You have view-only access. Ask a household owner if you need to make changes.");
      ctx.render();
      return;
    }
    if (undo && ctx.state?.setupComplete) {
      undoStack.push(deepClone(ctx.state));
      if (undoStack.length > 30) undoStack.shift();
      redoStack.length = 0;
    }
    ctx.state = next;
    await saveState(ctx.state);
    ctx.render();
    scheduleLocal(ctx.budget(), ctx.month);
    syncSoon(ctx);
  },
  /** Changes from the household arrived. Undo history is cleared so Undo can't roll back someone else's edit. */
  applyRemoteState(state) {
    const next = { ...state };
    if (!next.activeUserId && ctx.state?.activeUserId) next.activeUserId = ctx.state.activeUserId;
    if (next.budgets.length && (!next.setupComplete || !next.budgets.some((b) => b.id === next.activeBudgetId))) {
      next.setupComplete = true;
      next.activeBudgetId = next.budgets.find((b) => !b.archived)?.id || next.budgets[0].id;
      ctx.state = next;
      saveState(next);
    } else ctx.state = next;
    undoStack.length = 0;
    redoStack.length = 0;
    renderWhenFree();
  },
  async accountSignedIn(acct) {
    ctx.account = acct;
    ctx.pendingInvite = null;
    const user = accountUser(acct);
    if (!user) return;
    const users = [...(ctx.state.users || []).filter((u) => u.userId !== user.userId), user];
    await ctx.commit({ ...ctx.state, users, activeUserId: user.userId }, { undo: false });
    toast(`Signed in as ${user.displayName}`);
    startAutoSync(ctx);
  },
  accountSignedOut() {
    ctx.account = null;
    ctx.commit({ ...ctx.state, activeUserId: null }, { undo: false });
  },
  updateBudget(fn) {
    const b = ctx.budget();
    if (!b) return;
    const nextB = fn(b);
    if (!nextB) return;
    const budgets = ctx.state.budgets.map((x) => x.id === b.id ? nextB : x);
    ctx.commit({ ...ctx.state, budgets });
  },
  signIn(user, { create }) {
    const users = create ? [...(ctx.state.users || []).filter((u) => u.userId !== user.userId), user] : ctx.state.users;
    ctx.commit({ ...ctx.state, users, activeUserId: user.userId }, { undo: false }).then(() => announceIfUpdated(ctx));
  },
  saveUser(user) {
    const users = (ctx.state.users || []).map((u) => u.userId === user.userId ? user : u);
    ctx.commit({ ...ctx.state, users }, { undo: false });
  },
  logOut() {
    ctx.commit({ ...ctx.state, activeUserId: null }, { undo: false });
  },
  finishSetup(budget) {
    const b = normalizeBudget(budget);
    ctx.commit({ ...ctx.state, setupComplete: true, activeBudgetId: b.id, budgets: [...ctx.state.budgets, b] }, { undo: false });
  },
  addBudget(budget) {
    const b = normalizeBudget(budget);
    ctx.commit({ ...ctx.state, setupComplete: true, activeBudgetId: b.id, budgets: [...ctx.state.budgets, b] });
  },
  restore(state) {
    const next = state?.budgets ? state : importData(state);
    if (!next.activeUserId && ctx.state.activeUserId) next.activeUserId = ctx.state.activeUserId;
    if (!next.users?.length) next.users = ctx.state.users;
    ctx.commit(next, { undo: false });
  },
  async reset() {
    // Signed in: sign out first, so erasing this device never erases the household's budget.
    const wasAccount = !!ctx.account?.token;
    if (wasAccount) { await signOut(); ctx.account = null; }
    ctx.commit({ sv: 1, setupComplete: false, activeBudgetId: null, activeUserId: wasAccount ? null : ctx.state.activeUserId, users: ctx.state.users, budgets: [] }, { undo: false });
  },
  undo() {
    if (!undoStack.length || ctx.readOnly()) return;
    redoStack.push(deepClone(ctx.state));
    const prev = undoStack.pop();
    ctx.state = prev;
    saveState(ctx.state).then(() => { ctx.render(); syncSoon(ctx); });
  },
  redo() {
    if (!redoStack.length || ctx.readOnly()) return;
    undoStack.push(deepClone(ctx.state));
    const next = redoStack.pop();
    ctx.state = next;
    saveState(ctx.state).then(() => { ctx.render(); syncSoon(ctx); });
  },
  setMonth(m) { ctx.month = m; closeAllModals(); if (location.hash.startsWith("#budget")) history.replaceState(null, "", `#budget/${m}`); ctx.render(); },
  go(nav, filter) {
    ctx.nav = nav;
    closeAllModals();
    if (nav === "transactions" && filter) applyTxNav(ctx, filter);
    else if (filter) ctx.ui.txFilter = { ...ctx.ui.txFilter, ...filter };
    const hash = nav === "budget" ? `#budget/${ctx.month}` : `#${nav}`;
    if (location.hash !== hash) history.replaceState(null, "", hash);
    ctx.render();
  },
  applyTheme(theme, custom) { paintTheme(theme, custom); },
  render() { paint(); },
  toast,
};

function applyHash() {
  const parts = location.hash.replace(/^#/, "").split("/").filter(Boolean);
  const [nav, a, b] = parts;
  if (nav === "budget" || nav === "transactions" || nav === "accounts" || nav === "payees" || nav === "settings") ctx.nav = nav === "transactions" ? "transactions" : nav;
  if (nav === "tx") ctx.nav = "transactions";
  if (nav === "budget" && /^\d{4}-\d{2}$/.test(a)) ctx.month = a;
  if (nav === "budget" && b) ctx.ui.focusCat = b;
  if (nav === "accounts" && a) ctx.ui.focusAccount = a;
  if (nav === "settings" && a === "bank") ctx.ui.openBank = true;
  if (nav === "open") {
    ctx.nav = a === "tx" ? "transactions" : "budget";
  }
}

/** Don't repaint under an open sheet or while typing; catch up as soon as it closes. */
function renderWhenFree() {
  const busy = document.querySelector(".scrim") || ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName);
  if (!busy) { pendingRemote = false; ctx.render(); return; }
  if (pendingRemote) return;
  pendingRemote = true;
  const wait = setInterval(() => {
    if (document.querySelector(".scrim") || ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName)) return;
    clearInterval(wait);
    pendingRemote = false;
    ctx.render();
  }, 1000);
}

async function paint() {
  try {
    await paintInner();
  } catch (err) {
    console.error(err);
    showRescue(err);
  }
}

function showRescue(err) {
  clear(root);
  root.append(h("main", { class: "gate" },
    h("h1", { text: "Couldn’t open" }),
    h("p", { class: "lede", text: "This budget made the app quit. Reset removes it from this device only." }),
    h("p", { class: "hint", text: err?.message || "Something in the saved budget failed." }),
    btn("Reset this device", { block: true, onClick: () => ctx.reset() }),
  ));
}

async function paintInner() {
  clear(root);
  const user = (ctx.state.users || []).find((u) => u.userId === ctx.state.activeUserId);
  // An invite link goes straight to Sign in with Google, even on a device that already has a local profile.
  const invite = ctx.account?.token ? null : ctx.pendingInvite;
  if (!user || invite) { ctx.signedOutReason = ctx.account?.signedOutReason || ""; renderIdentity(root, ctx, { invite }); return; }
  if (!ctx.state.setupComplete || !ctx.budget()) {
    const st = syncStatus();
    if (ctx.account?.token && (!ctx.account.linked || st.busy) && !st.error) {
      renderLoading(root, st.total && st.uploaded < st.total ? `Uploading your budget… ${st.uploaded} of ${st.total}` : null);
      return;
    }
    renderWizard(root, ctx);
    return;
  }

  const shell = h("div", { class: "shell" });
  const side = h("nav", { class: "side", "aria-label": "Primary" });
  const main = h("div", { class: "main" });
  const budget = ctx.budget();
  const notes = collectReminders(budget, ctx.month);
  const free = globalFree(budget, ctx.month);
  const ahead = assignedAhead(budget, ctx.month);
  const rtaColor = free < -0.005 ? "var(--rta-neg)" : Math.abs(free) < 0.005 ? "color-mix(in srgb, var(--on-navy) 35%, transparent)" : "var(--good-on-navy)";
  const bell = h("button", {
    class: notes.length ? "hdr-bell has" : "hdr-bell",
    type: "button",
    "aria-label": notes.length ? `${notes.length} alerts` : "Alerts",
    onclick: () => openInbox(ctx),
  }, notes.length ? `🔔 ${notes.length}` : "🔔");
  let center;
  if (ctx.nav === "budget") {
    const prevMk = prevMonth(ctx.month);
    const nextMk = nextMonth(ctx.month);
    const prevOk = monthAccessible(budget, prevMk);
    const nextOk = monthAccessible(budget, nextMk);
    const isToday = ctx.month === monthKey();
    center = h("div", { class: "hdr-month" },
      h("button", { class: "hdr-mo-btn", type: "button", "aria-label": "Previous month", text: "‹", disabled: !prevOk, onclick: () => { if (prevOk) ctx.setMonth(prevMk); } }),
      h("button", { class: isToday ? "hdr-mo-label today" : "hdr-mo-label", type: "button", "aria-label": monthLabel(ctx.month), onclick: () => openHistory(ctx) },
        h("div", { class: "hdr-mo-name", text: monthLabel(ctx.month) }),
        h("div", { class: "hdr-budget-name", text: budget.name }),
      ),
      h("button", { class: "hdr-mo-btn", type: "button", "aria-label": "Next month", text: "›", disabled: !nextOk, onclick: () => {
        if (!nextOk) { toast("Assign money in the previous month first"); return; }
        ctx.setMonth(nextMk);
      } }),
    );
  } else {
    const titles = { accounts: "Accounts", transactions: "Transactions", payees: "Payees", settings: "Settings" };
    center = h("div", { class: "hdr-title" },
      h("div", { class: "hdr-page", text: titles[ctx.nav] || "" }),
      h("div", { class: "hdr-budget-name", text: budget.name }),
    );
  }
  const rtaBox = h("div", { class: "hdr-rta" },
    h("div", { class: "hdr-rta-kicker", text: "Ready to Assign" }),
    h("div", { class: "hdr-rta-amt", style: `color:${rtaColor}`, text: fmt(free) }),
  );
  const top = h("header", { class: "topbar" },
    h("div", { class: "hdr-row" }, bell, center, rtaBox),
    (ctx.nav === "budget" && ahead > 0.001)
      ? h("div", { class: "hdr-ahead", text: `📅 ${fmt(ahead)} assigned in future months` })
      : null,
  );
  const view = h("div", { class: "view", id: "view" });
  const tabs = h("nav", { class: "tabs", "aria-label": "Primary" });
  const items = [
    ["accounts", "🏦", "Accounts"],
    ["budget", "📊", "Budget"],
    ["transactions", "💸", "Transactions"],
    ["payees", "👥", "Payees"],
    ["settings", "⚙️", "Settings"],
  ];
  const openCount = (budget.transactions || []).filter((tx) =>
    !tx.accountId
    || (tx.type === "expense" && !tx.categoryId && !tx.splits)
    || (tx.type === "expense" && tx.categoryId && !tx.splits && tx.categoryConfirmed === false)
  ).length;
  const navBtn = (id, emoji, label) => {
    const current = ctx.nav === id;
    const badge = (id === "transactions" && openCount > 0)
      ? h("span", { class: "nav-gold-badge", text: String(openCount) })
      : null;
    return h("button", {
      class: current ? "nav-btn on" : "nav-btn",
      type: "button",
      "aria-current": current ? "page" : null,
      onclick: () => ctx.go(id),
    }, h("span", { class: "nav-emoji", text: emoji }), h("span", { class: "nav-label", text: label }), badge);
  };
  const undoRedo = () => h("div", { class: "nav-undo" },
    h("button", { class: "ico-btn", type: "button", "aria-label": "Undo", title: "Undo", disabled: !undoStack.length, onclick: () => ctx.undo() }, "↩"),
    h("button", { class: "ico-btn", type: "button", "aria-label": "Redo", title: "Redo", disabled: !redoStack.length, onclick: () => ctx.redo() }, "↪"),
  );
  for (const [id, emoji, label] of items) {
    side.append(navBtn(id, emoji, label));
    tabs.append(navBtn(id, emoji, label));
  }
  // Desktop keeps Undo/Redo in the sidebar until WU-07 restyles it; phone puts them in the bottom nav.
  side.append(undoRedo());
  tabs.append(undoRedo());
  main.append(top, view);
  shell.append(side, main, tabs);
  root.append(shell);
  if (ctx.nav === "budget") renderBudget(view, ctx);
  else if (ctx.nav === "transactions") renderTransactions(view, ctx);
  else if (ctx.nav === "accounts") renderAccounts(view, ctx);
  else if (ctx.nav === "payees") renderPayees(view, ctx);
  else await renderSettings(view, ctx);
}

let gPending = false;
let gTimer = null;
window.addEventListener("keydown", (e) => {
  const tag = document.activeElement?.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || document.activeElement?.isContentEditable) return;
  if (document.querySelector(".scrim")) return;
  const meta = e.metaKey || e.ctrlKey;
  if (meta && e.key.toLowerCase() === "z") { e.preventDefault(); if (e.shiftKey) ctx.redo(); else ctx.undo(); return; }
  if (e.key === "?" ) { e.preventDefault(); toast("g then b/t/a/p/s jumps views. Arrows change month. n adds a transaction. / searches."); return; }
  if (e.key === "g" || e.key === "G") { gPending = true; clearTimeout(gTimer); gTimer = setTimeout(() => { gPending = false; }, 1000); return; }
  if (gPending) {
    gPending = false;
    const dest = { b: "budget", t: "transactions", a: "accounts", p: "payees", s: "settings" }[e.key.toLowerCase()];
    if (dest) { e.preventDefault(); ctx.go(dest); }
    return;
  }
  if (ctx.nav === "budget" && ctx.state?.setupComplete && ctx.budget()) {
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      const p = prevMonth(ctx.month);
      if (monthAccessible(ctx.budget(), p)) ctx.setMonth(p);
    }
    if (e.key === "ArrowRight") {
      e.preventDefault();
      const n = nextMonth(ctx.month);
      if (!monthAccessible(ctx.budget(), n)) { toast("Assign money in the previous month first"); return; }
      ctx.setMonth(n);
    }
  }
  if (ctx.nav === "transactions") {
    if (e.key === "n" || e.key === "N") { e.preventDefault(); openTx(ctx, null); }
    if (e.key === "/") { e.preventDefault(); ctx.ui.searchEl?.focus(); }
  }
});

window.addEventListener("gesturestart", (e) => e.preventDefault(), { passive: false });
window.addEventListener("gesturechange", (e) => e.preventDefault(), { passive: false });
window.addEventListener("gestureend", (e) => e.preventDefault(), { passive: false });

window.addEventListener("hashchange", () => { closeAllModals(); applyHash(); ctx.render(); });

/** Back from Google on the installed iPhone app: #signin=<one-time code> or #signin-error=<message>. */
async function finishRedirectSignIn() {
  const hash = location.hash.replace(/^#/, "");
  if (!/^signin(-error)?=/.test(hash)) return null;
  const q = new URLSearchParams(hash);
  history.replaceState(null, "", location.pathname + location.search);
  const code = q.get("signin");
  if (!code) {
    const msg = withCode(q.get("signin-error") || "Sign-in failed", q.get("signin-code") || "ERROR");
    setTimeout(() => toast(msg, { ms: 9000 }), 300);
    return null;
  }
  try { return await redeemSignInCode(code); }
  catch (x) { setTimeout(() => toast(withCode(x.message, x.code || "REDEEM"), { ms: 9000 }), 300); return null; }
}

/** Opened from an invite link (?invite=<id>): remember it for sign-in, then tidy the address bar. */
async function captureInvite() {
  const params = new URLSearchParams(location.search);
  const id = params.get("invite");
  if (!id) return;
  params.delete("invite");
  const q = params.toString();
  history.replaceState(null, "", location.pathname + (q ? "?" + q : "") + location.hash);
  if (isInviteId(id)) await setPendingInvite(id);
}

async function boot() {
  ctx.state = await loadState();
  await captureInvite();
  ctx.pendingInvite = await pendingInvite();
  const redirected = await finishRedirectSignIn();
  ctx.account = await account();
  if (ctx.account?.token && (await pendingInvite())) {
    await setPendingInvite(null);
    ctx.pendingInvite = null;
    setTimeout(() => toast(`You’re already signed in as ${ctx.account.me?.user?.email || "a household member"}. Sign out first to use that invite with another account.`, { ms: 8000 }), 400);
  }
  onAccountChange(async () => {
    const before = ctx.account?.token;
    ctx.account = await account();
    if (before && !ctx.account?.token) ctx.render();
  });
  onSyncChange((st) => { if (!ctx.budget() && ctx.account?.token) renderWhenFree(); void st; });
  const theme = await deviceGet("theme");
  const custom = await deviceGet("customTheme");
  ctx.applyTheme(theme || "system", custom);
  ctx.ui.showReconciled = !!(await deviceGet("showReconciled"));
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", async () => {
    const current = await deviceGet("theme");
    if (!current || resolveTheme(current) === "system") ctx.applyTheme("system", await deviceGet("customTheme"));
  });
  applyHash();
  subscribe(() => {});
  if (redirected) await ctx.accountSignedIn(redirected);
  else if (ctx.account?.token) {
    // Signed in on this device: open straight into the household, like any other app.
    const user = accountUser(ctx.account);
    const known = (ctx.state.users || []).find((u) => u.userId === user.userId);
    if (!known || ctx.state.activeUserId !== user.userId || known.displayName !== user.displayName || known.picture !== user.picture) {
      const users = [...(ctx.state.users || []).filter((u) => u.userId !== user.userId), { ...known, ...user }];
      ctx.state = { ...ctx.state, users, activeUserId: user.userId };
      await saveState(ctx.state);
    }
    startAutoSync(ctx);
  }
  registerSW((reg) => {
    const existing = document.getElementById("toasts")?.textContent || "";
    if (existing.includes("App updated to version")) return;
    toast("An update is ready", { label: "Reload", ms: 8000, action: () => activateWaiting(reg) });
  });
  ctx.render();
  if (ctx.budget()) {
    scheduleLocal(ctx.budget(), ctx.month);
    pushCleanupOnce();
    bankOnOpen(ctx);
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && ctx.budget() && ctx.state?.activeUserId) bankOnOpen(ctx);
  });
  void syncNow;
  document.title = `ToozBudgeting ${APP_VERSION}`;
  if (ctx.state?.setupComplete) setTimeout(() => announceIfUpdated(ctx), 700);
}

boot().catch((e) => {
  root.textContent = "ToozBudgeting couldn’t start. " + (e?.message || "");
  console.error(e);
});
