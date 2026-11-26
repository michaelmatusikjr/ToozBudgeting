import { APP_VERSION, monthKey, prevMonth, nextMonth, deepClone } from "./util.js?v=134";
import { loadState, saveState, subscribe, exportData, importData, deviceGet, deviceSet } from "./store.js?v=134";
import { h, clear, icon, toast, closeAllModals, btn } from "./ui.js?v=134";
import { renderIdentity, renderWizard } from "./views/gate.js?v=134";
import { renderBudget, openInbox } from "./views/budget.js?v=134";
import { renderTransactions, openTx } from "./views/transactions.js?v=134";
import { renderAccounts } from "./views/accounts.js?v=134";
import { renderPayees } from "./views/payees.js?v=134";
import { renderSettings } from "./views/settings.js?v=134";
import { registerSW, activateWaiting } from "./pwa.js?v=134";
import { scheduleLocal, collectReminders } from "./notify.js?v=134";
import { pushOnOpen } from "./push.js?v=134";
import { normalizeBudget } from "./mutate.js?v=134";
import { announceIfUpdated } from "./whatsnew.js?v=134";
import { monthAccessible } from "./calc.js?v=134";

const root = document.getElementById("app");
const undoStack = [];
const redoStack = [];

const ctx = {
  state: null,
  month: monthKey(),
  nav: "budget",
  ui: { collapsed: {}, showArchived: false, txFilter: {}, txQuery: "", selected: new Set(), payeeQuery: "", avg: null },
  budget() {
    return ctx.state?.budgets?.find((b) => b.id === ctx.state.activeBudgetId) || ctx.state?.budgets?.[0] || null;
  },
  async commit(next, { undo = true } = {}) {
    if (!next) return;
    if (undo && ctx.state?.setupComplete) {
      undoStack.push(deepClone(ctx.state));
      if (undoStack.length > 30) undoStack.shift();
      redoStack.length = 0;
    }
    ctx.state = next;
    await saveState(ctx.state);
    ctx.render();
    scheduleLocal(ctx.budget(), ctx.month);
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
  reset() {
    ctx.commit({ sv: 1, setupComplete: false, activeBudgetId: null, activeUserId: ctx.state.activeUserId, users: ctx.state.users, budgets: [] }, { undo: false });
  },
  undo() {
    if (!undoStack.length) return;
    redoStack.push(deepClone(ctx.state));
    const prev = undoStack.pop();
    ctx.state = prev;
    saveState(ctx.state).then(() => ctx.render());
  },
  redo() {
    if (!redoStack.length) return;
    undoStack.push(deepClone(ctx.state));
    const next = redoStack.pop();
    ctx.state = next;
    saveState(ctx.state).then(() => ctx.render());
  },
  setMonth(m) { ctx.month = m; closeAllModals(); if (location.hash.startsWith("#budget")) history.replaceState(null, "", `#budget/${m}`); ctx.render(); },
  go(nav, filter) {
    ctx.nav = nav;
    closeAllModals();
    if (filter) ctx.ui.txFilter = { ...ctx.ui.txFilter, ...filter };
    const hash = nav === "budget" ? `#budget/${ctx.month}` : `#${nav}`;
    if (location.hash !== hash) history.replaceState(null, "", hash);
    ctx.render();
  },
  applyTheme(theme) {
    const t = theme || "system";
    if (t === "system") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.dataset.theme = t;
    const dark = t === "dark" || (t === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
    const color = dark ? "#14181c" : "#2f6f62";
    document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.setAttribute("content", color));
  },
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
  if (nav === "open") {
    ctx.nav = a === "tx" ? "transactions" : "budget";
  }
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
  if (!user) { renderIdentity(root, ctx); return; }
  if (!ctx.state.setupComplete || !ctx.budget()) { renderWizard(root, ctx); return; }

  const shell = h("div", { class: "shell" });
  const side = h("nav", { class: "side", "aria-label": "Primary" });
  const main = h("div", { class: "main" });
  const notes = ctx.budget() ? collectReminders(ctx.budget(), ctx.month) : [];
  const top = h("header", { class: "topbar" },
    h("div", { class: "brand" }, h("span", { class: "brand-mark", text: "Tooz" }), h("span", { class: "brand-name", text: ctx.budget().name })),
    h("div", { class: "top-actions" },
      h("button", { class: "icon-btn", type: "button", "aria-label": "Undo", disabled: !undoStack.length, onclick: () => ctx.undo() }, icon("undo")),
      h("button", { class: "icon-btn", type: "button", "aria-label": "Redo", disabled: !redoStack.length, onclick: () => ctx.redo() }, icon("redo")),
      h("button", { class: "icon-btn", type: "button", "aria-label": notes.length ? `${notes.length} notices` : "Notices", onclick: () => openInbox(ctx) }, icon("bell"), notes.length ? h("span", { class: "badge", text: notes.length > 9 ? "9+" : String(notes.length) }) : null),
    ),
  );
  const view = h("div", { class: "view", id: "view" });
  const tabs = h("nav", { class: "tabs", "aria-label": "Primary" });
  const items = [
    ["budget", "Plan", "budget"],
    ["transactions", "Activity", "tx"],
    ["accounts", "Accounts", "accounts"],
    ["payees", "Payees", "payees"],
    ["settings", "Settings", "settings"],
  ];
  for (const [id, label, ic] of items) {
    const current = ctx.nav === id;
    const mk = (extra) => h("button", { class: `nav-btn ${current ? "on" : ""}`, type: "button", "aria-current": current ? "page" : null, onclick: () => ctx.go(id) }, icon(ic), h("span", { text: label }));
    side.append(mk());
    tabs.append(mk());
  }
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

window.addEventListener("hashchange", () => { closeAllModals(); applyHash(); ctx.render(); });

async function boot() {
  ctx.state = await loadState();
  const theme = await deviceGet("theme");
  if (theme) ctx.applyTheme(theme);
  applyHash();
  subscribe(() => {});
  registerSW((reg) => {
    const existing = document.getElementById("toasts")?.textContent || "";
    if (existing.includes("App updated to version")) return;
    toast("An update is ready", { label: "Reload", ms: 8000, action: () => activateWaiting(reg) });
  });
  ctx.render();
  if (ctx.budget()) {
    scheduleLocal(ctx.budget(), ctx.month);
    pushOnOpen(ctx.budget());
  }
  document.title = `ToozBudgeting ${APP_VERSION}`;
  if (ctx.state?.setupComplete) setTimeout(() => announceIfUpdated(ctx), 700);
}

boot().catch((e) => {
  root.textContent = "ToozBudgeting couldn’t start. " + (e?.message || "");
  console.error(e);
});
