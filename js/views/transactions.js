import { h, btn, openSheet, field, textInput, toast, moneyButton, confirmDialog, keepFocus, iconBtn, bindLongPress, searchableSel, amountInput, btnRow, append, clear } from "../ui.js?v=154";
import { fmt, todayKey, toTitleCase, isCard, isPayFrom, ccPayCat, makePayFrom, RTA, uid, monthLabel } from "../util.js?v=154";
import { deviceSet } from "../store.js?v=154";
import { displayName, payeeDefaultCategory, payeeSuggestedCategory, findFuzzyDuplicates, isAccountPayee } from "../payees.js?v=154";
import { addTransaction, deleteTransactions, isLocked, setTxCategory, updateTransaction, replaceTransaction, confirmCategories, unreconcileTransaction, resolveDuplicatePair } from "../mutate.js?v=154";
import { parseCSV, guessColumnMapping, applyMapping } from "../csv.js?v=154";


export const UNCONFIRMED_FILTER = "__unconfirmed__";

export function blankTxFilters() {
  return { accountId: "", categoryId: "", categoryIds: null, categoryLabel: "", payee: "", type: "", dateFrom: "", dateTo: "", amountGT: false, amountLT: false, amountEQ: true, amountVal: "" };
}

export function needsAttention(tx) {
  return !tx.accountId || (tx.type === "expense" && !tx.categoryId && !tx.splits) || (tx.type === "expense" && tx.categoryId && !tx.splits && tx.categoryConfirmed === false);
}

function matchesUnconfirmed(tx) {
  return !tx.accountId || (tx.type === "expense" && !tx.categoryId && !tx.splits) || tx.categoryConfirmed === false;
}

export function applyTxNav(ctx, patch = {}) {
  const budget = ctx.budget() || { accounts: [], creditCards: [], categories: [], categoryGroups: [] };
  const f = blankTxFilters();
  const chips = [];
  const add = (type, label, value) => {
    if (value == null || value === "") return;
    chips.push({ id: uid(), type, label, value });
  };
  if (patch.month) add("month", monthLabel(patch.month), patch.month);
  if (patch.categoryId) {
    const cat = (budget.categories || []).find((c) => c.id === patch.categoryId);
    add("category", cat?.name || "Category", patch.categoryId);
  }
  if (patch.accountId) {
    const a = [...(budget.accounts || []), ...(budget.creditCards || [])].find((x) => x.id === patch.accountId);
    add("account", a?.name || "Account", patch.accountId);
  }
  if (patch.groupId) {
    const g = (budget.categoryGroups || []).find((x) => x.id === patch.groupId);
    f.categoryIds = (budget.categories || []).filter((c) => c.groupId === patch.groupId).map((c) => c.id);
    f.categoryLabel = g?.name || "Group";
  }
  if (patch.attention) f.categoryId = UNCONFIRMED_FILTER;
  if (patch.type) add("txtype", patch.type === "expense" ? "Expenses" : toTitleCase(patch.type), patch.type);
  if (patch.payee) add("payee", patch.payee, patch.payee);
  if (patch.dateFrom) f.dateFrom = patch.dateFrom;
  if (patch.dateTo) f.dateTo = patch.dateTo;
  ctx.ui.txFilter = f;
  ctx.ui.txChips = chips;
  ctx.ui.txQuery = "";
  ctx.ui.showTxFilters = true;
}

export function filterTxRows(budget, { query = "", chips = [], filters = {}, showReconciled = false } = {}) {
  const search = (query || "").trim().toLowerCase();
  const f = { ...blankTxFilters(), ...filters };
  const amountVal = parseFloat(f.amountVal);
  const rows = [...(budget.transactions || [])].sort((a, b) => b.date.localeCompare(a.date) || String(b.id || "").localeCompare(String(a.id || "")));
  return rows.filter((tx) => {
    if (!showReconciled && isLocked(budget, tx)) return false;
    if (search) {
      const name = displayName(budget, tx.originalPayee || tx.payee) || "";
      if (!`${name} ${tx.note || ""} ${tx.date || ""}`.toLowerCase().includes(search)) return false;
    }
    if (f.accountId && tx.accountId !== f.accountId) return false;
    if (f.categoryId === UNCONFIRMED_FILTER) {
      if (!matchesUnconfirmed(tx)) return false;
    } else if (f.categoryId) {
      const cats = tx.splits ? tx.splits.map((s) => s.categoryId) : [tx.categoryId];
      if (!cats.includes(f.categoryId)) return false;
    }
    if (f.categoryIds) {
      const cats = tx.splits ? tx.splits.map((s) => s.categoryId) : [tx.categoryId];
      if (!cats.some((id) => f.categoryIds.includes(id))) return false;
    }
    if (f.payee && displayName(budget, tx.originalPayee || tx.payee) !== f.payee) return false;
    if (f.type && tx.type !== f.type) return false;
    if (f.dateFrom && tx.date < f.dateFrom) return false;
    if (f.dateTo && tx.date > f.dateTo) return false;
    if (f.month && !String(tx.date || "").startsWith(f.month)) return false;
    if (f.amountOp && f.amount != null && f.amount !== "") {
      const n = Number(f.amount);
      const a = Math.abs(Number(tx.amount) || 0);
      if (f.amountOp === ">" && !(a > n + 0.001)) return false;
      if (f.amountOp === "<" && !(a < n - 0.001)) return false;
      if (f.amountOp === "=" && !(Math.abs(a - n) < 0.02)) return false;
    } else if ((f.amountGT || f.amountEQ || f.amountLT) && !Number.isNaN(amountVal) && amountVal >= 0) {
      const A = amountVal;
      let pass = false;
      if (f.amountEQ && (Math.abs(tx.amount - A) < 0.005 || Math.abs(tx.amount + A) < 0.005)) pass = true;
      if (f.amountGT && (tx.amount > A + 0.005 || tx.amount < -A - 0.005)) pass = true;
      if (f.amountLT && (tx.amount > -A + 0.005 && tx.amount < A - 0.005)) pass = true;
      if (!pass) return false;
    }
    for (const chip of chips) {
      if (chip.type === "payee" && displayName(budget, tx.originalPayee || tx.payee) !== chip.value) return false;
      if (chip.type === "category") {
        const cats = tx.splits ? tx.splits.map((s) => s.categoryId) : [tx.categoryId];
        if (!cats.includes(chip.value)) return false;
      }
      if (chip.type === "account" && tx.accountId !== chip.value) return false;
      if (chip.type === "amount_digits") {
        const txDigits = Math.abs(Number(tx.amount) || 0).toFixed(2).replace(/[^0-9]/g, "");
        if (!txDigits.includes(chip.value)) return false;
      }
      if (chip.type === "month" && !String(tx.date || "").startsWith(chip.value)) return false;
      if (chip.type === "txtype" && tx.type !== chip.value) return false;
    }
    return true;
  });
}

function netOfRows(budget, rows) {
  return rows.reduce((s, tx) => {
    const isCardTx = (budget.creditCards || []).some((c) => c.id === tx.accountId);
    if (tx.type === "income") return s + Math.abs(tx.amount);
    if (tx.type === "expense") return s - Number(tx.amount);
    if (tx.type === "payment") return isCardTx ? s + Math.abs(tx.amount) : s - Math.abs(tx.amount);
    return s;
  }, 0);
}

function filtersAreActive(query, chips, f) {
  const blank = blankTxFilters();
  if ((query || "").trim() || (chips || []).length) return true;
  return Object.keys(blank).some((k) => {
    const bv = blank[k];
    const fv = f[k];
    if (Array.isArray(bv) || Array.isArray(fv)) return JSON.stringify(fv || null) !== JSON.stringify(bv);
    return (fv ?? blank[k]) !== bv;
  });
}

function searchSuggestions(budget, raw) {
  const value = (raw || "").trim();
  if (!value) return [];
  const q = value.toLowerCase();
  const groups = [];
  const payeeNames = [...new Set((budget.transactions || []).map((tx) => displayName(budget, tx.originalPayee || tx.payee)).filter(Boolean))];
  const payeeMatches = payeeNames.filter((n) => n.toLowerCase().includes(q)).slice(0, 4);
  if (payeeMatches.length) groups.push({ group: "Payees", icon: "👤", items: payeeMatches.map((n) => ({ type: "payee", label: n, value: n, display: n })) });
  const catMatches = (budget.categories || []).filter((c) => !c.archived && c.name.toLowerCase().includes(q)).slice(0, 4);
  if (catMatches.length) groups.push({ group: "Categories", icon: "🏷", items: catMatches.map((c) => ({ type: "category", label: c.name, value: c.id, display: c.name })) });
  const accMatches = [
    ...(budget.accounts || []).filter((a) => !a.archived && a.name.toLowerCase().includes(q)).map((a) => ({ type: "account", label: a.name, value: a.id, display: a.name })),
    ...(budget.creditCards || []).filter((c) => !c.archived && c.name.toLowerCase().includes(q)).map((c) => ({ type: "account", label: c.name, value: c.id, display: c.name })),
  ].slice(0, 4);
  if (accMatches.length) groups.push({ group: "Accounts", icon: "🏦", items: accMatches });
  const digitsOnly = value.replace(/[^0-9]/g, "");
  if (digitsOnly.length > 0 && /^[\d$,. ]+$/.test(value)) {
    groups.push({ group: "Amount", icon: "💰", items: [{ type: "amount_digits", label: `Amount containing "${digitsOnly}"`, value: digitsOnly, display: `amt: ${digitsOnly}` }] });
  }
  const monthNames = ["january","february","march","april","may","june","july","august","september","october","november","december"];
  const monthAbbr = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"];
  const today = new Date();
  let monthIdx = monthNames.findIndex((m) => m.startsWith(q));
  if (monthIdx === -1) monthIdx = monthAbbr.findIndex((m) => m === q.slice(0, 3));
  const isoMonthMatch = value.match(/^(\d{4})-(\d{2})$/);
  if (isoMonthMatch) {
    const [, yr, mo] = isoMonthMatch;
    const label = new Date(Number(yr), Number(mo) - 1, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" });
    groups.push({ group: "Month", icon: "📅", items: [{ type: "month", label, value: `${yr}-${mo}`, display: label }] });
  } else if (monthIdx !== -1) {
    const items = [];
    for (const offset of [-1, 0, 1]) {
      const yr = today.getFullYear() + offset;
      const mo = String(monthIdx + 1).padStart(2, "0");
      const mk = `${yr}-${mo}`;
      if ((budget.transactions || []).some((tx) => String(tx.date || "").startsWith(mk))) {
        const label = new Date(yr, monthIdx, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" });
        items.push({ type: "month", label, value: mk, display: label });
      }
    }
    if (items.length) groups.push({ group: "Month", icon: "📅", items: items.slice(0, 3) });
  }
  const typeMap = { income: { label: "Income", value: "income" }, expense: { label: "Expenses", value: "expense" }, payment: { label: "Payments", value: "payment" }, transfer: { label: "Transfers", value: "transfer" } };
  const typeMatches = Object.entries(typeMap).filter(([k]) => k.startsWith(q)).map(([, v]) => ({ type: "txtype", label: v.label, value: v.value, display: v.label }));
  if (typeMatches.length) groups.push({ group: "Type", icon: "🔄", items: typeMatches });
  return groups;
}

export function renderTransactions(root, ctx) {
  const budget = ctx.budget();
  if (!ctx.ui.txFilter) ctx.ui.txFilter = blankTxFilters();
  if (!ctx.ui.txChips) ctx.ui.txChips = [];
  const f = { ...blankTxFilters(), ...ctx.ui.txFilter };
  ctx.ui.txFilter = f;
  const q = ctx.ui.txQuery || "";
  const chips = ctx.ui.txChips;
  const showReconciled = !!ctx.ui.showReconciled;
  const rows = filterTxRows(budget, { query: q, chips, filters: f, showReconciled });
  const selected = ctx.ui.selected;
  const attentionAll = (budget.transactions || []).filter(needsAttention);

  const addChip = (chip) => {
    const next = (ctx.ui.txChips || []).filter((c) => !(c.type === chip.type && c.value === chip.value));
    next.push({ id: chip.id || uid(), type: chip.type, label: chip.label, value: chip.value });
    ctx.ui.txChips = next;
    ctx.ui.txQuery = "";
    ctx.ui.txSuggestIdx = -1;
    ctx.render();
  };
  const removeChip = (id) => { ctx.ui.txChips = (ctx.ui.txChips || []).filter((c) => c.id !== id); ctx.render(); };
  const clearAllFilters = () => {
    ctx.ui.txFilter = blankTxFilters();
    ctx.ui.txChips = [];
    ctx.ui.txQuery = "";
    ctx.render();
  };

  root.append(h("div", { class: "tx-toolbar" },
    btn("+ Add Transaction", { kind: "primary small", onClick: () => openTx(ctx, null) }),
    btn("📥 Import", { kind: "ghost small", onClick: () => openImport(ctx) }),
  ));

  const suggestions = searchSuggestions(budget, q);
  const flatItems = suggestions.flatMap((g) => g.items);
  const focused = !!ctx.ui.txSearchFocused;
  const activeIdx = Math.min(ctx.ui.txSuggestIdx ?? -1, flatItems.length - 1);
  const search = h("input", {
    class: "tx-search-input",
    type: "search",
    placeholder: chips.length ? "Add another filter..." : "Search payees, categories, amounts, dates...",
    value: q,
    "aria-label": "Search transactions",
    autocomplete: "off",
  });
  const typing = ctx.ui.txTyping;
  const bumpSearch = () => { ctx.ui.txSearchSeq = (ctx.ui.txSearchSeq || 0) + 1; };
  search.addEventListener("input", () => { bumpSearch(); ctx.ui.txQuery = search.value; ctx.ui.txTyping = true; ctx.ui.txSearchFocused = true; ctx.ui.txSuggestIdx = -1; ctx.render(); });
  search.addEventListener("focus", () => { bumpSearch(); if (!ctx.ui.txSearchFocused) { ctx.ui.txSearchFocused = true; ctx.ui.txTyping = true; ctx.render(); } });
  search.addEventListener("blur", () => {
    const seq = ctx.ui.txSearchSeq;
    setTimeout(() => {
      if (ctx.ui.txSearchSeq !== seq) return;
      if (document.activeElement?.classList?.contains("tx-search-input")) return;
      if (ctx.ui.txSearchFocused) { ctx.ui.txSearchFocused = false; ctx.render(); }
    }, 180);
  });
  search.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" && flatItems.length) { e.preventDefault(); ctx.ui.txSuggestIdx = Math.min((ctx.ui.txSuggestIdx ?? -1) + 1, flatItems.length - 1); ctx.ui.txTyping = true; ctx.ui.txSearchFocused = true; ctx.render(); }
    else if (e.key === "ArrowUp" && flatItems.length) { e.preventDefault(); ctx.ui.txSuggestIdx = Math.max((ctx.ui.txSuggestIdx ?? -1) - 1, -1); ctx.ui.txTyping = true; ctx.ui.txSearchFocused = true; ctx.render(); }
    else if (e.key === "Enter" && (ctx.ui.txSuggestIdx ?? -1) >= 0 && flatItems[ctx.ui.txSuggestIdx]) { e.preventDefault(); addChip(flatItems[ctx.ui.txSuggestIdx]); }
    else if (e.key === "Escape") { search.blur(); }
    else if (e.key === "Backspace" && !search.value && chips.length) { removeChip(chips[chips.length - 1].id); }
  });

  const sugBox = (focused && suggestions.length) ? h("div", { class: "tx-sugs" }, ...suggestions.map((group) => h("div", { class: "tx-sug-group" },
    h("div", { class: "tx-sug-h", text: `${group.icon} ${group.group}` }),
    ...group.items.map((item) => {
      const idx = flatItems.indexOf(item);
      return h("div", {
        class: "tx-sug-item" + (idx === activeIdx ? " on" : ""),
        onmousedown: (e) => { e.preventDefault(); addChip({ type: item.type, label: item.display || item.label, value: item.value }); },
      }, h("span", { text: item.label }), h("span", { class: "tx-sug-kind", text: group.group }));
    }),
  ))) : null;

  const searchWrap = h("div", { class: "tx-search" },
    h("div", { class: "tx-search-box" },
      h("span", { class: "tx-search-ico", text: "🔍" }),
      search,
      q ? h("button", { class: "tx-search-clear", type: "button", text: "×", "aria-label": "Clear search", onclick: () => { ctx.ui.txQuery = ""; ctx.render(); } }) : null,
    ),
    sugBox,
  );

  root.append(h("div", { class: "tx-search-row" },
    searchWrap,
    h("div", { class: "tx-search-tools" },
      iconBtn({
        text: "🔒",
        active: showReconciled,
        label: showReconciled ? "Reconciled transactions visible — tap to hide" : "Reconciled transactions hidden — tap to show",
        onClick: () => {
          ctx.ui.showReconciled = !ctx.ui.showReconciled;
          deviceSet("showReconciled", ctx.ui.showReconciled);
          ctx.render();
        },
      }),
      iconBtn({
        text: "⚙️",
        active: !!ctx.ui.showTxFilters,
        label: "Filters",
        onClick: () => { ctx.ui.showTxFilters = !ctx.ui.showTxFilters; ctx.render(); },
      }),
    ),
  ));

  if (chips.length) {
    const row = h("div", { class: "tx-chips" });
    for (const chip of chips) {
      const kind = chip.type.startsWith("amount") ? "amount" : chip.type;
      row.append(h("span", { class: `tx-chip ${kind}` },
        h("span", { text: chip.label }),
        h("button", { type: "button", text: "×", "aria-label": `Remove ${chip.label}`, onclick: () => removeChip(chip.id) }),
      ));
    }
    row.append(h("button", { class: "tx-chip-clear", type: "button", text: "Clear all", onclick: clearAllFilters }));
    root.append(row);
  }

  if (ctx.ui.showTxFilters) root.append(txFilterPanel(ctx, budget, f, clearAllFilters));

  if (attentionAll.length) {
    const filterAttn = () => {
      ctx.ui.txFilter = { ...blankTxFilters(), categoryId: UNCONFIRMED_FILTER };
      ctx.ui.txQuery = "";
      ctx.ui.showTxFilters = true;
      ctx.render();
    };
    root.append(h("div", { class: "tx-attn-row" },
      h("button", { class: "tx-attn", type: "button", onclick: filterAttn },
        h("strong", { text: `⚠️ ${attentionAll.length} transaction${attentionAll.length !== 1 ? "s" : ""} need${attentionAll.length === 1 ? "s" : ""} attention` }),
        h("span", { text: " · Missing or Unconfirmed Categories · Tap to fix" }),
      ),
      btn("🔧 Fix", { kind: "ghost small", onClick: () => openFixTransactions(ctx) }),
    ));
  }

  if (filtersAreActive(q, chips, f)) {
    const total = netOfRows(budget, rows);
    const net = `${total >= 0 ? "+" : ""}${fmt(total)}`;
    root.append(h("div", { class: "tx-net" },
      h("span", { text: `${rows.length} transaction${rows.length !== 1 ? "s" : ""}` }),
      h("span", { class: "tx-net-amt", text: `Net: ${net}` }),
    ));
  }

  const dups = (budget.pendingDuplicates || []).filter((p) => budget.transactions.some((t) => t.id === p.newTxId) && budget.transactions.some((t) => t.id === p.existingTxId));
  if (dups.length) {
    root.append(h("button", { class: "notice", type: "button", onclick: () => openDupes(ctx) },
      h("strong", { text: `${dups.length} possible duplicate${dups.length === 1 ? "" : "s"}` }),
      h("span", { class: "notice-go", text: "Review" }),
    ));
  }
  if (selected.size) {
    const allIds = rows.map((tx) => tx.id);
    const allOn = allIds.length > 0 && allIds.every((id) => selected.has(id));
    const selTxs = [...selected].map((id) => (budget.transactions || []).find((tx) => tx.id === id)).filter(Boolean);
    const hasSuggested = selTxs.some((tx) => !tx.splits && tx.categoryConfirmed === false && tx.categoryId && tx.type === "expense");
    const bar = h("div", { class: "bulk" },
      h("span", { class: "bulk-count", text: `${selected.size} selected` }),
      h("button", { class: "text-link", type: "button", text: allOn ? "Deselect All" : "Select All", onclick: () => {
        if (allOn) selected.clear();
        else allIds.forEach((id) => selected.add(id));
        ctx.render();
      }}),
    );
    if (selected.size === 1) {
      bar.append(btn("✏️ Edit", { kind: "ghost small", onClick: () => {
        const tx = (budget.transactions || []).find((item) => item.id === [...selected][0]);
        selected.clear();
        if (tx) openTx(ctx, tx);
        else ctx.render();
      }}));
    }
    if (hasSuggested) {
      bar.append(btn("✓ Confirm", { kind: "ghost small", onClick: () => {
        ctx.updateBudget((b) => confirmCategories(b, [...selected]));
        selected.clear();
        toast("Categories confirmed");
      }}));
    }
    bar.append(
      btn("🏷 Category", { kind: "ghost small", onClick: () => openBulkCat(ctx) }),
      btn("Account", { kind: "ghost small", onClick: () => openBulkAccount(ctx) }),
      btn("🗑 Delete", { kind: "danger small", onClick: () => confirmDialog({
        title: "Delete Transactions?",
        message: `Delete ${selected.size} transaction${selected.size !== 1 ? "s" : ""}? This cannot be undone. Locked (reconciled) transactions will be skipped.`,
        confirm: "Yes, Delete",
        danger: true,
        onConfirm: () => { ctx.updateBudget((b) => deleteTransactions(b, [...selected])); selected.clear(); toast("Deleted", { label: "Undo", action: () => ctx.undo() }); },
      }) }),
      btn("Cancel", { kind: "quiet small", onClick: () => { selected.clear(); ctx.render(); } }),
    );
    root.append(bar);
  }

  const list = h("div", { class: "tx-list" });
  if (!rows.length) list.append(h("p", { class: "empty", text: (budget.transactions || []).length === 0 ? "No transactions yet. Tap + Add Transaction to get started." : "No transactions match your search/filters" }));
  const PAGE = 80;
  const filterKey = JSON.stringify({ f, q, chips, showReconciled });
  if (ctx.ui.txFilterKey !== filterKey) {
    ctx.ui.txFilterKey = filterKey;
    ctx.ui.txLimit = PAGE;
  }
  const limit = ctx.ui.txLimit || PAGE;
  const shown = rows.slice(0, limit);
  for (const tx of shown) list.append(txRow(ctx, tx, selected));
  root.append(list);
  if (rows.length > shown.length) {
    root.append(btn("Show more", { kind: "ghost", onClick: () => { ctx.ui.txLimit = limit + PAGE; ctx.render(); } }));
    root.lastElementChild.classList.add("tx-show-more");
  }
  ctx.ui.searchEl = search;
  if (typing) { ctx.ui.txTyping = false; keepFocus(search); }
}

function signedDisplay(budget, tx) {
  const card = (budget.creditCards || []).some((c) => c.id === tx.accountId);
  if (tx.type === "income") return Math.abs(tx.amount);
  if (tx.type === "expense") return card ? -tx.amount : -tx.amount;
  if (tx.type === "transfer") return tx.amount;
  if (tx.type === "payment") {
    const card = (budget.creditCards || []).some((c) => c.id === tx.accountId);
    return card ? Math.abs(tx.amount) : -Math.abs(tx.amount);
  }
  return tx.amount;
}

function monthRangeSafe(k) {
  const [y, m] = k.split("-").map(Number);
  const last = new Date(y, m, 0).getDate();
  return { from: `${k}-01`, to: `${k}-${String(last).padStart(2, "0")}` };
}


function shortTxDate(date) {
  if (!date) return "";
  return new Date(`${date}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function txRow(ctx, tx, selected) {
  const budget = ctx.budget();
  const isSplit = !!(tx.splits && tx.splits.length);
  const isStartingBalance = tx.subtype === "starting_balance";
  const isRefundTx = tx.type === "expense" && Number(tx.amount) < 0;
  const isSuggested = !isStartingBalance && tx.categoryConfirmed === false && tx.categoryId && tx.type === "expense" && !tx.splits;
  const isMissingCat = !isStartingBalance && tx.type === "expense" && !tx.categoryId && !tx.splits;
  const isCardTx = (budget.creditCards || []).some((c) => c.id === tx.accountId);
  const isCardPayment = tx.type === "payment" && isCardTx;
  const acct = [...(budget.accounts || []), ...(budget.creditCards || [])].find((a) => a.id === tx.accountId);
  const cat = (budget.categories || []).find((c) => c.id === tx.categoryId);
  const locked = isLocked(budget, tx);
  const expanded = ctx.ui.expandedTxId === tx.id;
  const selecting = selected.size > 0;
  const payee = isStartingBalance ? (acct?.name || "Account") : (displayName(budget, tx.originalPayee || tx.payee) || tx.payee || "—");

  const pill = txPill(ctx, tx, { isSplit, isStartingBalance, isRefundTx, isSuggested, isMissingCat, isCardTx, cat, acct, locked });

  const sign = tx.type === "income" || (tx.type === "adjustment" && Number(tx.amount) >= 0) || isRefundTx || isCardPayment ? "+" : "-";
  const amtClass = amountClass(budget, tx);
  const amtText = `${sign}${fmt(Math.abs(Number(tx.amount) || 0))}`;

  const monthNote = tx.categoryId && budget.categoryNotes?.[String(tx.date || "").slice(0, 7)]?.[tx.categoryId];
  const noteBits = [];
  if (tx.note) noteBits.push(tx.note);
  if (monthNote) {
    const when = new Date(`${String(tx.date || "").slice(0, 7)}-01T12:00:00`).toLocaleDateString("en-US", { month: "short", year: "2-digit" });
    noteBits.push(`Note from category for ${when}: ${monthNote}`);
  }
  const row = h("article", { class: `tx${selected.has(tx.id) ? " sel" : ""}${selecting ? " selecting" : ""}` });
  bindLongPress(row, () => { ctx.ui.selected = new Set([tx.id]); ctx.render(); });
  row.addEventListener("contextmenu", (e) => { e.preventDefault(); ctx.ui.selected = new Set([tx.id]); ctx.render(); });
  row.addEventListener("click", () => {
    if (selecting) {
      if (selected.has(tx.id)) selected.delete(tx.id); else selected.add(tx.id);
      ctx.render();
      return;
    }
    if (isSplit) {
      ctx.ui.expandedTxId = expanded ? null : tx.id;
      ctx.render();
      return;
    }
    openTx(ctx, tx);
  });

  if (selecting) {
    const box = h("input", { type: "checkbox", checked: selected.has(tx.id), onclick: (e) => { e.stopPropagation(); if (e.target.checked) selected.add(tx.id); else selected.delete(tx.id); ctx.render(); } });
    row.append(box);
  }
  const hasPayee = !!(payee && payee !== "—");
  const title = hasPayee ? payee : (acct?.name || payee);
  const subKids = [];
  if (hasPayee && acct) subKids.push(h("span", { text: acct.name }));
  if (!tx.accountId) subKids.push(h("span", { class: "tx-no-acct", text: "⚠️ no account" }));
  subKids.push(h("span", { class: "tx-pill-wrap", onclick: (e) => e.stopPropagation() }, pill));
  if (noteBits.length) subKids.push(h("span", { class: "tx-memo", text: `· ${noteBits.join(" · ")}` }));

  row.append(
    h("div", { class: "tx-date", text: shortTxDate(tx.date) }),
    h("div", { class: "tx-mid" },
      h("div", { class: "tx-payee", text: title }),
      h("div", { class: "tx-meta" }, ...subKids),
    ),
    h("div", { class: amtClass, text: amtText }),
    locked
      ? h("span", { class: "tx-lock", title: "Locked by reconciliation", text: "🔒" })
      : h("button", { class: "tx-x", type: "button", text: "×", "aria-label": "Delete transaction", onclick: (e) => { e.stopPropagation(); confirmDeleteTx(ctx, tx); } }),
  );
  if (expanded && isSplit) {
    const box = h("div", { class: "tx-splits" });
    for (const sp of tx.splits) {
      const spCat = (budget.categories || []).find((c) => c.id === sp.categoryId);
      box.append(h("div", { class: "tx-split-row" },
        h("span", { text: spCat?.name || "—" }),
        h("span", { text: fmt(sp.amount) }),
      ));
    }
    row.append(box);
  }
  return row;
}

function txPill(ctx, tx, flags) {
  const { isSplit, isStartingBalance, isRefundTx, isSuggested, isMissingCat, isCardTx, cat, locked } = flags;
  const budget = ctx.budget();
  if (isStartingBalance) return h("span", { class: "tx-pill sb", text: "Starting Balance" });
  if (isSplit) return h("span", { class: "tx-pill split", text: "🔀 Split" });
  if (tx.type === "transfer") return h("span", { class: "tx-pill transfer", text: "🔄 Transfer" });
  if (tx.type === "payment") {
    const linkIcon = tx.paymentLinkStatus === "linked" ? "🔗" : tx.paymentLinkStatus === "broken" ? "⛓️‍💥" : "";
    let label;
    if (isCardTx) {
      const fromAcct = tx.paymentFromAccountId ? (budget.accounts || []).find((a) => a.id === tx.paymentFromAccountId) : null;
      label = fromAcct ? `Payment from ${fromAcct.name}` : "Card Payment";
    } else {
      label = cat?.name || "Payment";
    }
    const el = h("span", { class: "tx-pill payment" },
      linkIcon ? h("span", { class: "tx-link-ico", title: tx.paymentLinkStatus === "linked" ? "Matched" : "Waiting for match", text: linkIcon }) : null,
      h("span", { text: label }),
    );
    if (tx.paymentLinkStatus && tx.paymentLinkStatus !== "linked") {
      el.style.cursor = "pointer";
      el.addEventListener("click", (e) => { e.stopPropagation(); openMissingSide(ctx, tx); });
    }
    return el;
  }
  if (tx.type === "adjustment") return h("span", { class: "tx-pill adj", text: "⚖️ Adj" });
  if (tx.type === "income") return h("span", { class: "tx-pill income", text: "Income" });
  if (isMissingCat) {
    return h("button", { class: "tx-pill missing", type: "button", text: "— No Category", onclick: (e) => { e.stopPropagation(); openInlineCat(ctx, tx); } });
  }
  if (isSuggested) {
    return h("div", { class: "tx-pill suggested" },
      h("span", { text: cat?.name || "—" }),
      h("button", { type: "button", class: "tx-sug-yes", title: "Confirm", text: "✓", disabled: !!locked, onclick: (e) => { e.stopPropagation(); ctx.updateBudget((b) => confirmCategories(b, [tx.id])); } }),
      h("button", { type: "button", class: "tx-sug-no", title: "Change", text: "✕", disabled: !!locked, onclick: (e) => { e.stopPropagation(); openInlineCat(ctx, tx); } }),
    );
  }
  return h("span", { class: "tx-pill", text: cat?.name || (isRefundTx ? "↩ Refund" : "—") });
}

function confirmDeleteTx(ctx, tx) {
  const budget = ctx.budget();
  const payeeName = displayName(budget, tx.originalPayee || tx.payee) || tx.payee;
  const acctName = [...(budget.accounts || []), ...(budget.creditCards || [])].find((a) => a.id === tx.accountId)?.name;
  const name = (payeeName && payeeName !== "—") ? payeeName : (acctName || "this transaction");
  let message = `Delete ${name} (${fmt(Math.abs(tx.amount))} on ${tx.date})? This cannot be undone.`;
  if (tx.type === "transfer" && tx.transferLinkId) message += " Both sides of this transfer will be deleted.";
  if (tx.type === "payment" && tx.paymentLinkStatus === "linked") message += " The matching payment on the other account will be unlinked.";
  confirmDialog({
    title: "Delete Transaction?",
    message,
    confirm: "Yes, Delete",
    danger: true,
    onConfirm: () => {
      ctx.updateBudget((b) => deleteTransactions(b, [tx.id]));
      toast("Deleted", { label: "Undo", action: () => ctx.undo() });
    },
  });
}

function amountClass(budget, tx) {
  const isRefundTx = tx.type === "expense" && Number(tx.amount) < 0;
  const isCardPayment = tx.type === "payment" && (budget.creditCards || []).some((c) => c.id === tx.accountId);
  if (tx.type === "income" || isRefundTx || isCardPayment) return "tx-amt in";
  if (tx.type === "payment") return "tx-amt pay";
  if (tx.type === "adjustment") return "tx-amt adj";
  return "tx-amt out";
}

export function openMissingSide(ctx, tx) {
  const budget = ctx.budget();
  const card = isCard(budget, tx.accountId);
  if (card) {
    const from = tx.paymentFromAccountId || budget.accounts.find((a) => !a.archived)?.id;
    const pay = ccPayCat(budget, tx.accountId);
    if (!from || !pay) { toast("Pick the bank account on the card payment first"); return; }
    openTx(ctx, { draft: true, date: tx.date, amount: Math.abs(tx.amount), accountId: from, categoryId: pay.id, type: "payment", payee: "" });
    return;
  }
  const cat = (budget.categories || []).find((c) => c.id === tx.categoryId);
  if (!cat?.creditCardId) { toast("This payment isn’t tied to a card"); return; }
  openTx(ctx, { draft: true, date: tx.date, amount: Math.abs(tx.amount), accountId: cat.creditCardId, categoryId: makePayFrom(tx.accountId), type: "payment", payee: "" });
}

function amountLabel(budget, tx) {
  if (tx.type === "income") return fmt(Math.abs(tx.amount));
  if (tx.type === "expense") return fmt(-Number(tx.amount));
  if (tx.type === "transfer") return fmt(Number(tx.amount));
  if (tx.type === "payment") return isCard(budget, tx.accountId) ? fmt(Math.abs(tx.amount)) : fmt(-Math.abs(tx.amount));
  return fmt(tx.amount);
}

function openInlineCat(ctx, tx) {
  const budget = ctx.budget();
  const sheet = openSheet({
    title: "Category",
    body: (host) => {
      const sel = categorySelect(budget, tx.accountId, true);
      sel.value = tx.categoryId || (tx.type === "income" ? RTA : "");
      host.append(sel, btn("Save", { block: true, onClick: () => {
        const v = sel.value;
        if (v === RTA) ctx.updateBudget((b) => updateTransaction(b, tx.id, { type: "income", categoryId: null, splits: undefined, amount: Math.abs(tx.amount) }));
        else ctx.updateBudget((b) => setTxCategory(b, tx.id, v));
        sheet.close();
      }}));
    },
  });
}

function categorySelect(budget, accountId, includeRta) {
  const sel = h("select", { class: "input" });
  sel.append(h("option", { value: "", text: "No category" }));
  if (includeRta) sel.append(h("option", { value: RTA, text: "Ready to Assign (income)" }));
  const card = (budget.creditCards || []).some((c) => c.id === accountId);
  if (card) {
    for (const a of budget.accounts.filter((a) => !a.archived)) sel.append(h("option", { value: makePayFrom(a.id), text: `Payment from ${a.name}` }));
  }
  for (const g of budget.categoryGroups) {
    const og = h("optgroup", { label: g.name });
    for (const c of budget.categories.filter((c) => c.groupId === g.id && !c.archived)) {
      if (card && c.creditCardId) continue;
      og.append(h("option", { value: c.id, text: c.name }));
    }
    sel.append(og);
  }
  return sel;
}


function isPaymentCategory(budget, categoryId) {
  return isPayFrom(categoryId) || (budget.categories || []).some((c) => c.id === categoryId && c.creditCardId);
}

function hasUsableAccount(budget) {
  return (budget.accounts || []).some((a) => !a.archived) || (budget.creditCards || []).some((c) => !c.archived);
}

function accountSelectOptions(budget, includeId) {
  const opts = [{ value: "", label: "Select..." }];
  for (const a of budget.accounts || []) {
    if (!a.archived || a.id === includeId) opts.push({ value: a.id, label: a.name, group: "Cash & Bank Accounts" });
  }
  for (const c of budget.creditCards || []) {
    if (!c.archived || c.id === includeId) opts.push({ value: c.id, label: c.name, group: "Credit Cards" });
  }
  return opts;
}

function catOptionsForAccount(budget, accountId, extraTop = []) {
  const opts = [{ value: "", label: "No category" }, ...extraTop];
  const card = (budget.creditCards || []).some((c) => c.id === accountId);
  if (card) {
    for (const a of (budget.accounts || []).filter((a) => !a.archived)) {
      opts.push({ value: makePayFrom(a.id), label: `Payment from ${a.name}`, group: "Credit Card Payments" });
    }
  }
  for (const g of budget.categoryGroups || []) {
    for (const c of (budget.categories || []).filter((c) => c.groupId === g.id && !c.archived && !(card && c.creditCardId))) {
      opts.push({ value: c.id, label: c.name, group: g.name });
    }
  }
  return opts;
}

function transferSelectOptions(budget, accountId) {
  const opts = [{ value: "", label: "None" }];
  for (const a of budget.accounts || []) {
    if (a.archived || a.id === accountId) continue;
    opts.push({ value: a.id, label: a.name, group: "Cash & Bank Accounts" });
  }
  for (const c of budget.creditCards || []) {
    if (c.archived || c.id === accountId) continue;
    opts.push({ value: c.id, label: c.name, group: "Credit Cards" });
  }
  return opts;
}

function splitCatOptions(budget) {
  const opts = [{ value: "", label: "Category..." }];
  for (const g of budget.categoryGroups || []) {
    for (const c of (budget.categories || []).filter((c) => c.groupId === g.id && !c.archived && !c.creditCardId)) {
      opts.push({ value: c.id, label: c.name, group: g.name });
    }
  }
  return opts;
}

function payeeNames(budget) {
  return [...new Set((budget.transactions || []).map((t) => displayName(budget, t.originalPayee || t.payee)).filter((n) => n && !isAccountPayee(budget, n)))];
}

function signToggle(isRefund, onChange) {
  return h("div", { class: "tx-sign" },
    h("button", { type: "button", class: `tx-sign-btn minus${isRefund ? "" : " on"}`, text: "−", onclick: () => onChange(false) }),
    h("button", { type: "button", class: `tx-sign-btn plus${isRefund ? " on" : ""}`, text: "+", onclick: () => onChange(true) }),
  );
}

function formCanSave(form, budget) {
  const isPaymentTx = isPaymentCategory(budget, form.categoryId);
  const payeeOk = isPaymentTx || !!form.transferAccountId || !!(form.payee || "").trim();
  if (!form.accountId || !payeeOk || !(Math.abs(Number(form.amount) || 0) > 0)) return false;
  if (form.splits) {
    const sum = form.splits.reduce((s, sp) => s + Math.abs(Number(sp.amount) || 0), 0);
    return form.splits.length > 0
      && form.splits.every((sp) => sp.categoryId && Number(sp.amount) > 0)
      && Math.abs(sum - Math.abs(Number(form.amount) || 0)) < 0.005;
  }
  return true;
}

export function openTx(ctx, existing, opts = {}) {
  const budget = ctx.budget();
  if (existing?.subtype === "starting_balance") {
    const sheet = openSheet({
      title: "🏦 Starting Balance",
      body: (host) => {
        append(host,
          h("div", { class: "tx-lock-banner", text: "🔒 This is a Starting Balance transaction. It's permanently locked and cannot be edited or deleted." }),
          btn("Close", { kind: "ghost", onClick: () => sheet.close() }),
        );
      },
    });
    return;
  }
  const editing = !!(existing?.id && !existing.draft);
  const locked = editing && isLocked(budget, existing);
  const form = {
    date: existing?.date || todayKey(),
    payee: existing ? displayName(budget, existing.originalPayee || existing.payee) : "",
    note: existing?.note || "",
    amount: existing ? Math.abs(Number(existing.amount) || 0) : 0,
    isRefund: existing?.type === "expense" && Number(existing.amount) < 0,
    accountId: existing?.accountId || "",
    categoryId: (() => {
      if (existing?.type === "income") return RTA;
      if (existing?.type === "payment") {
        if (existing.paymentFromAccountId) return makePayFrom(existing.paymentFromAccountId);
        if (existing.categoryId) return existing.categoryId;
      }
      return existing?.categoryId || "";
    })(),
    transferAccountId: existing?.transferAccountId || "",
    splits: existing?.splits ? existing.splits.map((s) => ({ ...s, amount: Math.abs(s.amount) })) : null,
    type: existing?.type || "expense",
    categoryConfirmed: existing?.categoryConfirmed,
    preSplitCategoryId: "",
    preSplitAmount: 0,
  };
  const sheet = openSheet({
    title: existing?.draft ? "Enter the other side" : (editing ? "Edit Transaction" : "New Transaction"),
    closeLabel: "Discard",
    body: (host) => {
      if (!editing && !existing?.draft && !hasUsableAccount(budget)) {
        append(host,
          h("p", { class: "tx-empty-acct", text: "Every transaction needs to be tied to an account or credit card, so the app can keep a running balance. Add one in Settings first." }),
          btn("Go to Settings", { block: true, onClick: () => { sheet.close(); ctx.go("settings"); } }),
        );
        return;
      }

      const applyPayeeCategory = (name) => {
        const displayed = displayName(budget, name.trim());
        const def = payeeDefaultCategory(budget, displayed);
        const sug = payeeSuggestedCategory(budget, displayed);
        const autoCat = def || sug || "";
        if (!form.splits && !form.categoryId && autoCat) {
          form.categoryId = autoCat;
          form.categoryConfirmed = !!def;
        }
      };

      const save = () => {
        if (!formCanSave(form, budget)) return;
        if (form.splits?.length) {
          const sum = form.splits.reduce((s, sp) => s + Math.abs(Number(sp.amount) || 0), 0);
          if (Math.abs(sum - Math.abs(form.amount)) > 0.02) { toast("Splits have to add up to the amount"); return; }
          if (form.splits.some((sp) => !sp.categoryId)) { toast("Each split needs a category"); return; }
        }
        const payload = { ...form, payee: form.payee, type: form.transferAccountId ? "transfer" : (form.categoryId === RTA ? "income" : form.type) };
        ctx.updateBudget((b) => {
          const res = editing ? replaceTransaction(b, existing.id, payload) : addTransaction(b, payload);
          if (res.error) { toast(res.error); return b; }
          sheet.close();
          toast(editing ? "Saved" : "Added", { label: "Undo", action: () => ctx.undo() });
          return res.budget;
        });
      };

      const cancelSplit = () => {
        form.categoryId = form.preSplitCategoryId || (form.splits?.[0]?.categoryId || "");
        form.amount = form.preSplitAmount || form.amount || 0;
        form.splits = null;
        form.preSplitCategoryId = "";
        form.preSplitAmount = 0;
        paint();
      };

      const paintBalance = () => {
        const el = host.querySelector(".tx-split-bal");
        if (!el || !form.splits) return;
        const splitSum = form.splits.reduce((s, sp) => s + (Number(sp.amount) || 0), 0);
        const remaining = Math.round((Math.abs(form.amount) - splitSum) * 100) / 100;
        const balanced = Math.abs(remaining) < 0.005;
        el.classList.toggle("ok", balanced);
        el.querySelector(".tx-split-remain").textContent = balanced ? "✓ Balanced" : `${fmt(remaining)} remaining`;
        el.querySelector(".tx-split-total").textContent = `Total: ${form.isRefund ? "+" : "−"}${fmt(Math.abs(form.amount))}`;
      };

      const refreshActions = () => {
        const saveBtn = host.querySelector(".btn-row .btn.primary");
        if (saveBtn) saveBtn.disabled = !formCanSave(form, budget) || !!ctx.readOnly();
        const splitBtn = host.querySelector(".tx-split-toggle");
        if (splitBtn) splitBtn.disabled = !form.amount;
        paintBalance();
      };

      const payeeField = () => {
        const wrap = h("div", { class: "tx-payee-wrap" });
        const input = textInput({ value: form.payee, placeholder: "Who was it?" });
        if (locked) input.disabled = true;
        input.setAttribute("autocapitalize", "words");
        input.setAttribute("autocorrect", "off");
        input.setAttribute("spellcheck", "false");
        const drop = h("div", { class: "tx-payee-drop" });
        const closeDrop = () => { drop.replaceChildren(); drop.classList.remove("open"); };
        const openDrop = () => {
          const q = input.value.trim().toLowerCase();
          drop.replaceChildren();
          if (!q) { drop.classList.remove("open"); return; }
          const matches = payeeNames(budget).filter((n) => n.toLowerCase().includes(q)).slice(0, 8);
          if (!matches.length) { drop.classList.remove("open"); return; }
          for (const name of matches) {
            drop.append(h("button", { type: "button", class: "tx-payee-opt", text: name, onmousedown: (e) => {
              e.preventDefault();
              input.value = name;
              form.payee = name;
              applyPayeeCategory(name);
              closeDrop();
              paint();
            }}));
          }
          drop.classList.add("open");
        };
        input.addEventListener("input", () => {
          form.payee = input.value;
          applyPayeeCategory(input.value);
          openDrop();
          refreshActions();
        });
        input.addEventListener("focus", openDrop);
        input.addEventListener("blur", () => setTimeout(() => {
          closeDrop();
          const before = form.categoryId;
          applyPayeeCategory(form.payee || "");
          if (form.categoryId !== before) paint();
        }, 150));
        wrap.append(input, drop);
        return field("Payee", wrap);
      };

      const splitEditor = () => {
        const box = h("div", { class: "tx-split-ed" });
        box.append(h("label", { class: "field-label", text: "Split Categories" }));
        box.append(field("Total Transaction Amount", h("div", { class: "tx-amt-row" },
          signToggle(form.isRefund, (refund) => { form.isRefund = refund; paint(); }),
          h("div", { class: "tx-amt-box" },
            h("span", { class: "tx-amt-prefix", text: form.isRefund ? "+" : "−" }),
            amountInput({
              value: Math.abs(form.amount) || 0,
              placeholder: "0.00",
              onChange: (v) => { form.amount = Math.abs(v); refreshActions(); },
              onCommit: (v) => { form.amount = Math.abs(v); refreshActions(); },
            }),
          ),
        )));
        form.splits.forEach((sp, i) => {
          const row = h("div", { class: "tx-split-ed-row" },
            h("div", { class: "tx-split-ed-cat" }, searchableSel({
              value: sp.categoryId,
              placeholder: "Search...",
              options: splitCatOptions(budget),
              onChange: (v) => { sp.categoryId = v; refreshActions(); },
            })),
            h("div", { class: "tx-split-ed-amt" }, amountInput({
              value: sp.amount || 0,
              placeholder: "0.00",
              onChange: (v) => { sp.amount = Math.abs(v); refreshActions(); },
              onCommit: (v) => { sp.amount = Math.abs(v); refreshActions(); },
            })),
            h("button", {
              type: "button", class: "tx-split-x", text: "×", "aria-label": "Remove split",
              onclick: () => {
                if (form.splits.length <= 1) return;
                const next = form.splits.filter((_, j) => j !== i);
                if (next.length === 1) cancelSplit();
                else { form.splits = next; paint(); }
              },
            }),
          );
          box.append(row);
        });
        box.append(h("div", { class: "tx-split-ed-actions" },
          h("button", { type: "button", class: "tx-split-add", text: "+ Add Category", onclick: () => { form.splits.push({ categoryId: "", amount: 0 }); paint(); } }),
          h("button", { type: "button", class: "tx-split-cancel", text: "✕ Cancel Split", onclick: cancelSplit }),
        ));
        const splitSum = form.splits.reduce((s, sp) => s + (Number(sp.amount) || 0), 0);
        const remaining = Math.round((Math.abs(form.amount) - splitSum) * 100) / 100;
        const balanced = Math.abs(remaining) < 0.005;
        box.append(h("div", { class: `tx-split-bal${balanced ? " ok" : ""}` },
          h("span", { class: "tx-split-remain", text: balanced ? "✓ Balanced" : `${fmt(remaining)} remaining` }),
          h("span", { class: "tx-split-total", text: `Total: ${form.isRefund ? "+" : "−"}${fmt(Math.abs(form.amount))}` }),
        ));
        return box;
      };

      const paint = () => {
        const isPayment = isPaymentCategory(budget, form.categoryId);
        const isIncome = form.categoryId === RTA;
        const isTransfer = !!form.transferAccountId;
        const isSpecial = isIncome || isPayment || isTransfer;
        const kids = [];
        if (opts.approval) kids.push(h("div", { class: "tx-approval" }));
        if (locked) kids.push(h("div", { class: "tx-lock-banner", text: "🔒 This transaction is locked (reconciled). Category and note can still be edited." }));
        if (existing?.draft) {
          kids.push(h("p", { class: "lede", text: "This is the missing side of a card payment. Check the account and category, then add it." }));
        }
        const date = h("input", { class: "input", type: "date", value: form.date, disabled: locked || null });
        date.addEventListener("change", () => { form.date = date.value; });
        kids.push(field("Date", date));
        kids.push(searchableSel({
          label: "Account",
          value: form.accountId,
          placeholder: "Search accounts...",
          disabled: locked,
          options: accountSelectOptions(budget, form.accountId),
          onChange: (v) => {
            form.accountId = v;
            form.categoryId = "";
            form.splits = null;
            if (form.transferAccountId === v) form.transferAccountId = "";
            paint();
          },
        }));
        kids.push(searchableSel({
          label: "Transfer to",
          value: form.transferAccountId || "",
          placeholder: "Search accounts...",
          disabled: locked,
          options: transferSelectOptions(budget, form.accountId),
          onChange: (v) => {
            form.transferAccountId = v;
            if (v) {
              form.type = "transfer";
              form.categoryId = "";
              form.splits = null;
            } else if (form.type === "transfer") form.type = "expense";
            paint();
          },
        }));
        if (!isPayment) kids.push(payeeField());
        if (!form.splits && !isTransfer) {
          kids.push(searchableSel({
            label: "Category",
            value: form.categoryId,
            placeholder: form.accountId ? "Search categories..." : "Select account first",
            disabled: locked && !form.categoryId,
            options: form.accountId
              ? catOptionsForAccount(budget, form.accountId, [{ value: RTA, label: editing ? "→ Ready to Assign (convert to income)" : "→ Ready to Assign (income)" }])
              : [{ value: "", label: "Select account first" }],
            onChange: (v) => { form.categoryId = v; form.categoryConfirmed = true; paint(); },
          }));
        }
        if (!form.splits) {
          if (isSpecial) {
            kids.push(amountInput({
              label: "Amount",
              value: form.amount,
              placeholder: "0.00",
              disabled: locked,
              onChange: (v) => { form.amount = Math.max(0, v); refreshActions(); },
              onCommit: (v) => { form.amount = Math.max(0, v); refreshActions(); },
            }));
          } else {
            kids.push(field("Amount", h("div", { class: "tx-amt-row" },
              signToggle(form.isRefund, (refund) => { if (!locked) { form.isRefund = refund; paint(); } }),
              h("div", { class: "tx-amt-box" },
                h("span", { class: "tx-amt-prefix", text: form.isRefund ? "+" : "−" }),
                amountInput({
                  value: form.amount ? Math.abs(form.amount) : 0,
                  placeholder: "0.00",
                  disabled: locked,
                  onChange: (v) => { form.amount = Math.abs(v); refreshActions(); },
                  onCommit: (v) => { form.amount = Math.abs(v); refreshActions(); },
                }),
              ),
            )));
          }
        }
        if (!form.splits && form.accountId && !isSpecial && !locked) {
          kids.push(h("button", {
            type: "button",
            class: "tx-split-toggle",
            disabled: !form.amount,
            text: "🔀 Split into multiple categories",
            onclick: () => {
              if (!form.amount) return;
              form.preSplitCategoryId = form.categoryId;
              form.preSplitAmount = form.amount;
              form.splits = [{ categoryId: form.categoryId || "", amount: 0 }, { categoryId: "", amount: 0 }];
              form.categoryId = "";
              paint();
            },
          }));
        }
        if (form.splits) kids.push(splitEditor());
        const note = h("input", { class: "input", type: "text", placeholder: "Add a note...", value: form.note || "" });
        note.addEventListener("input", () => { form.note = note.value; });
        kids.push(field("Note (optional)", note));
        if (locked) {
          if (!ctx.readOnly()) {
            const actions = [btnRow(
              { label: "Discard", kind: "ghost", onClick: () => sheet.close() },
              { label: "Save & Close", kind: "primary", onClick: () => {
                const patch = { note: form.note };
                if (form.categoryId) patch.categoryId = form.categoryId === RTA ? null : form.categoryId;
                ctx.updateBudget((b) => updateTransaction(b, existing.id, patch));
                sheet.close();
                toast("Saved", { label: "Undo", action: () => ctx.undo() });
              } },
            )];
            actions.push(btn("Unreconcile", { kind: "ghost", block: true, onClick: () => {
              confirmDialog({
                title: "Unreconcile this transaction?",
                message: "It will no longer be treated as reconciled, and you can edit or delete it.",
                confirm: "Unreconcile",
                onConfirm: () => {
                  ctx.updateBudget((b) => {
                    const res = unreconcileTransaction(b, existing.id);
                    if (res.error) { toast(res.error); return b; }
                    sheet.close();
                    toast("Unreconciled", { label: "Undo", action: () => ctx.undo() });
                    return res.budget;
                  });
                },
              });
            } }));
            kids.push(h("div", { class: "tx-form-actions" }, ...actions));
          }
        } else if (!ctx.readOnly()) {
          const actions = [];
          if (editing) {
            actions.push(h("div", { class: "btn-row tx-edit-actions" },
              btn("Discard", { kind: "ghost", onClick: () => sheet.close() }),
              btn("Save & Close", { kind: "primary", disabled: !formCanSave(form, budget), onClick: save }),
              btn("Delete", { kind: "danger", onClick: () => {
                ctx.updateBudget((b) => deleteTransactions(b, [existing.id]));
                sheet.close();
                toast("Deleted", { label: "Undo", action: () => ctx.undo() });
              } }),
            ));
          } else {
            actions.push(btnRow(
              { label: "Cancel", kind: "ghost", onClick: () => sheet.close() },
              { label: "Save Transaction", kind: "primary", disabled: !formCanSave(form, budget), onClick: save },
            ));
          }
          kids.push(h("div", { class: "tx-form-actions" }, ...actions));
        }
        clear(host);
        append(host, ...kids);
      };
      paint();
    },
  });
}

function txFilterPanel(ctx, budget, f, clearAllFilters) {
  const setF = (patch) => { ctx.ui.txFilter = { ...ctx.ui.txFilter, ...patch }; ctx.render(); };
  const acct = h("select", { class: "input", onchange: (e) => setF({ accountId: e.target.value }) }, h("option", { value: "", text: "All Accounts" }));
  const accts = (budget.accounts || []).filter((a) => !a.archived);
  const cards = (budget.creditCards || []).filter((a) => !a.archived);
  if (accts.length) {
    const og = h("optgroup", { label: "Accounts" });
    for (const a of accts) og.append(h("option", { value: a.id, text: a.name }));
    acct.append(og);
  }
  if (cards.length) {
    const og = h("optgroup", { label: "Credit Cards" });
    for (const a of cards) og.append(h("option", { value: a.id, text: a.name }));
    acct.append(og);
  }
  acct.value = f.accountId || "";
  const cat = h("select", { class: "input", onchange: (e) => setF({ categoryId: e.target.value, categoryIds: null, categoryLabel: "" }) },
    h("option", { value: "", text: "All Categories" }),
    h("option", { value: UNCONFIRMED_FILTER, text: "⚠️ Missing or Unconfirmed" }),
  );
  for (const g of budget.categoryGroups || []) {
    const og = h("optgroup", { label: g.name });
    for (const c of (budget.categories || []).filter((c) => c.groupId === g.id)) og.append(h("option", { value: c.id, text: c.name }));
    cat.append(og);
  }
  cat.value = f.categoryId || "";
  const typ = h("select", { class: "input", onchange: (e) => setF({ type: e.target.value }) },
    h("option", { value: "", text: "All Types" }),
    h("option", { value: "expense", text: "Expense" }),
    h("option", { value: "income", text: "Income" }),
    h("option", { value: "payment", text: "Payment" }),
    h("option", { value: "adjustment", text: "Adjustment" }),
  );
  typ.value = f.type || "";
  const from = h("input", { class: "input", type: "date", value: f.dateFrom || "", onchange: (e) => setF({ dateFrom: e.target.value }) });
  const to = h("input", { class: "input", type: "date", value: f.dateTo || "", onchange: (e) => setF({ dateTo: e.target.value }) });
  const kids = [];
  if (f.payee) kids.push(h("div", { class: "tx-filter-tag" }, h("span", { text: "Payee:" }), h("span", { text: f.payee }), h("button", { type: "button", text: "×", onclick: () => setF({ payee: "" }) })));
  if (f.categoryIds) kids.push(h("div", { class: "tx-filter-tag" }, h("span", { text: "Group:" }), h("span", { text: f.categoryLabel || "Group" }), h("button", { type: "button", text: "×", onclick: () => setF({ categoryIds: null, categoryLabel: "" }) })));
  kids.push(acct, cat);
  kids.push(typ);
  kids.push(h("div", { class: "tx-filter-row cols" },
    h("div", {}, h("label", { class: "hint", text: "From Date" }), h("div", { class: "tx-date-wrap" }, from, f.dateFrom ? h("button", { type: "button", class: "tx-date-x", text: "×", onclick: () => setF({ dateFrom: "" }) }) : null)),
    h("div", {}, h("label", { class: "hint", text: "To Date" }), h("div", { class: "tx-date-wrap" }, to, f.dateTo ? h("button", { type: "button", class: "tx-date-x", text: "×", onclick: () => setF({ dateTo: "" }) }) : null)),
  ));
  const amt = h("input", { class: "input", type: "number", min: "0", placeholder: "0.00", value: f.amountVal || "", oninput: (e) => {
    let v = e.target.value;
    if (v.startsWith("-")) v = v.slice(1);
    const next = { amountVal: v };
    if (v && !f.amountGT && !f.amountEQ && !f.amountLT) next.amountEQ = true;
    setF(next);
  } });
  kids.push(h("div", { class: "tx-filter-row amt" },
    h("div", { class: "tx-amt-ops" },
      iconBtn({ text: ">", active: !!f.amountGT, label: "Greater than", onClick: () => setF({ amountGT: !f.amountGT, amountLT: f.amountGT ? f.amountLT : false }) }),
      iconBtn({ text: "=", active: !!f.amountEQ, label: "Equal to", onClick: () => setF({ amountEQ: !f.amountEQ }) }),
      iconBtn({ text: "<", active: !!f.amountLT, label: "Less than", onClick: () => setF({ amountLT: !f.amountLT, amountGT: f.amountLT ? f.amountGT : false }) }),
    ),
    amt,
    btn("Clear All Filters", { kind: "ghost small", onClick: clearAllFilters }),
  ));
  return h("div", { class: "tx-filter-panel" }, ...kids);
}


export function prepareImportRows(rows, headers, mapping, existingTxs, accountId) {
  const existing = (existingTxs || []).filter((tx) => tx.accountId === accountId);
  const parsed = [];
  for (const row of (rows || []).slice(1)) {
    const mapped = applyMapping(row, headers, mapping);
    if (!mapped.date) continue;
    const payee = (mapped.payee || "").trim();
    const amount = Number(mapped.amount) || 0;
    if (!amount) continue;
    const named = toTitleCase(payee);
    const isDup = existing.some((tx) => tx.date === mapped.date
      && Math.abs(Math.abs(tx.amount) - Math.abs(amount)) < 0.005
      && (tx.originalPayee || tx.payee || "").trim().toLowerCase() === payee.toLowerCase());
    parsed.push({
      date: mapped.date,
      payee,
      amount,
      categoryId: "",
      duplicate: isDup,
      skip: isDup || !named,
    });
  }
  return parsed;
}

function openImport(ctx) {
  if (ctx.readOnly()) { toast("View only — importing is turned off"); return; }
  const budget = ctx.budget();
  const st = {
    step: "select",
    rows: [],
    headers: [],
    fileName: "",
    accountId: "",
    dateCol: "",
    payeeCol: "",
    amountMode: "single",
    amountCol: "",
    signConvention: "neg-expense",
    debitCol: "",
    creditCol: "",
    mappingSource: "none",
    parsedTxs: [],
  };

  let sheet;
  sheet = openSheet({
    title: "📥 Import Transactions",
    closeLabel: "Discard",
    body: (host) => {
      const setTitle = (t) => {
        const el = host.closest(".sheet")?.querySelector(".sheet-title");
        if (el) el.textContent = t;
      };

      const mappingNow = () => ({
        dateCol: st.dateCol, payeeCol: st.payeeCol, amountCol: st.amountCol,
        debitCol: st.debitCol, creditCol: st.creditCol,
        amountMode: st.amountMode, signConvention: st.signConvention,
      });

      const colSelect = (label, key) => {
        const sel = h("select", { class: "input" }, h("option", { value: "", text: "Select..." }));
        for (const hd of st.headers) sel.append(h("option", { value: hd, text: hd }));
        sel.value = st[key] || "";
        sel.addEventListener("change", () => { st[key] = sel.value; });
        return field(label, sel);
      };

      const goToMap = () => {
        if (st.rows.length < 2 || !st.accountId) return;
        const remembered = budget.csvMappings?.[st.accountId];
        const needed = remembered
          ? [remembered.dateCol, remembered.payeeCol, ...(remembered.amountMode === "split" ? [remembered.debitCol, remembered.creditCol] : [remembered.amountCol])]
          : [];
        const templateValid = remembered && needed.every((col) => col && st.headers.includes(col));
        const mapping = templateValid ? remembered : guessColumnMapping(st.headers);
        Object.assign(st, {
          dateCol: mapping.dateCol || "",
          payeeCol: mapping.payeeCol || "",
          amountMode: mapping.amountMode || "single",
          amountCol: mapping.amountCol || "",
          signConvention: mapping.signConvention || "neg-expense",
          debitCol: mapping.debitCol || "",
          creditCol: mapping.creditCol || "",
          mappingSource: templateValid ? "template" : ((mapping.dateCol || mapping.payeeCol) ? "guess" : "none"),
          step: "map",
        });
        paint();
      };

      const goToReview = () => {
        const map = mappingNow();
        const ready = st.dateCol && st.payeeCol && (st.amountMode === "single" ? st.amountCol : (st.debitCol && st.creditCol));
        if (!ready) return;
        const parsed = prepareImportRows(st.rows, st.headers, map, budget.transactions, st.accountId);
        for (const p of parsed) {
          if (p.skip || p.duplicate) continue;
          const named = toTitleCase(p.payee);
          const displayed = displayName(budget, named);
          const expense = p.amount > 0;
          p.categoryId = expense ? (payeeDefaultCategory(budget, displayed) || payeeSuggestedCategory(budget, displayed) || "") : RTA;
        }
        st.parsedTxs = parsed;
        st.step = "review";
        paint();
      };

      const finishImport = () => {
        const map = mappingNow();
        let b = { ...budget, csvMappings: { ...(budget.csvMappings || {}), [st.accountId]: map } };
        let added = 0; let skipped = 0; let dup = 0;
        const seen = new Set((b.transactions || []).map((t) => `${t.accountId}|${t.date}|${Math.abs(t.amount)}|${(t.originalPayee || t.payee || "").toLowerCase()}`));
        for (const parsed of st.parsedTxs) {
          const named = toTitleCase((parsed.payee || "").trim());
          if (parsed.skip || !named) { skipped++; continue; }
          const key = `${st.accountId}|${parsed.date}|${Math.abs(parsed.amount)}|${named.toLowerCase()}`;
          if (parsed.duplicate || seen.has(key)) { skipped++; continue; }
          seen.add(key);
          const chosen = parsed.categoryId || "";
          const isRta = chosen === RTA;
          const expense = !isRta && parsed.amount > 0;
          const defCat = payeeDefaultCategory(b, named) || "";
          const sugCat = payeeSuggestedCategory(b, named) || "";
          const confirmed = !chosen || isRta || chosen === defCat || (chosen !== sugCat);
          const res = addTransaction(b, {
            date: parsed.date, payee: named, amount: Math.abs(parsed.amount),
            accountId: st.accountId,
            categoryId: isRta ? RTA : chosen,
            type: isRta ? "income" : (expense ? "expense" : "income"),
            isRefund: !isRta && parsed.amount < 0,
            categoryConfirmed: !!confirmed,
          });
          if (res.error) continue;
          b = res.budget;
          added++;
          if ((b.pendingDuplicates || []).length > dup) dup = (b.pendingDuplicates || []).length;
        }
        ctx.updateBudget(() => b);
        sheet.close();
        toast(`Imported ${added}${skipped ? `, skipped ${skipped}` : ""}${dup ? `, ${dup} possible duplicates` : ""}`);
      };

      const paintSelect = () => {
        setTitle("📥 Import Transactions");
        const file = h("input", { class: "input", type: "file", accept: ".csv,text/csv" });
        file.addEventListener("change", async () => {
          const f = file.files?.[0]; if (!f) return;
          const rows = parseCSV(await f.text());
          st.rows = rows;
          st.headers = rows[0] || [];
          st.fileName = f.name;
          paint();
        });
        const kids = [
          h("p", { class: "tx-import-lede", text: "Import a CSV export from your bank. You'll map the columns and review categories before anything is added." }),
          field("CSV File", file),
        ];
        if (st.fileName) kids.push(h("div", { class: "tx-import-fileok", text: `✓ ${st.fileName} — ${Math.max(0, st.rows.length - 1)} rows found` }));
        kids.push(searchableSel({
          label: "Import into",
          value: st.accountId,
          placeholder: "Select an account or card...",
          options: [{ value: "", label: "Select an account or card..." }, ...accountSelectOptions(budget).filter((o) => o.value)],
          onChange: (v) => { st.accountId = v; paint(); },
        }));
        kids.push(btnRow(
          { label: "Cancel", kind: "ghost", onClick: () => sheet.close() },
          { label: "Next: Map Columns", kind: "primary", disabled: st.rows.length < 2 || !st.accountId, onClick: goToMap },
        ));
        append(host, ...kids);
      };

      const paintMap = () => {
        setTitle("Map Columns");
        const kids = [];
        if (st.mappingSource === "template") kids.push(h("div", { class: "tx-import-info", text: "✓ Pre-filled using the mapping you used last time for this account. Adjust if needed." }));
        if (st.mappingSource === "guess") kids.push(h("div", { class: "tx-import-info", text: "✓ Pre-filled based on your file's column names. Double-check these look right." }));
        if (st.rows[1]) {
          const preview = st.rows[1].slice(0, 4).join(" · ") + (st.rows[1].length > 4 ? "…" : "");
          kids.push(h("p", { class: "tx-import-preview", text: `Preview of row 1: ${preview}` }));
        }
        kids.push(colSelect("Date Column", "dateCol"));
        kids.push(colSelect("Payee / Description Column", "payeeCol"));
        const modeBox = h("div", { class: "tx-import-modes" },
          btn("One Amount Column", { kind: st.amountMode === "single" ? "primary small" : "ghost small", onClick: () => { st.amountMode = "single"; paint(); } }),
          btn("Separate Debit/Credit", { kind: st.amountMode === "split" ? "primary small" : "ghost small", onClick: () => { st.amountMode = "split"; paint(); } }),
        );
        kids.push(field("Amount Format", modeBox));
        if (st.amountMode === "single") {
          kids.push(colSelect("Amount Column", "amountCol"));
          const signs = h("div", { class: "tx-import-signs" });
          for (const [val, label] of [["neg-expense", "Negative numbers are expenses"], ["pos-expense", "Positive numbers are expenses"]]) {
            const input = h("input", { type: "radio", name: "signconv", checked: st.signConvention === val || null });
            input.addEventListener("change", () => { st.signConvention = val; paint(); });
            signs.append(h("label", { class: "tx-import-sign" }, input, h("span", { text: label })));
          }
          kids.push(field("Sign Convention", signs));
        } else {
          kids.push(colSelect("Debit Column (expenses)", "debitCol"));
          kids.push(colSelect("Credit Column (income)", "creditCol"));
        }
        const ready = st.dateCol && st.payeeCol && (st.amountMode === "single" ? st.amountCol : (st.debitCol && st.creditCol));
        kids.push(h("div", { class: "tx-form-actions" }, btnRow(
          { label: "Back", kind: "ghost", onClick: () => { st.step = "select"; paint(); } },
          { label: "Next: Review", kind: "primary", disabled: !ready, onClick: goToReview },
        )));
        append(host, ...kids);
      };

      const paintReview = () => {
        setTitle("Review Import");
        const toImport = st.parsedTxs.filter((p) => !p.skip);
        const dupCount = st.parsedTxs.filter((p) => p.duplicate).length;
        const kids = [];
        kids.push(h("p", { class: "tx-import-summary" },
          h("strong", { text: String(toImport.length) }),
          h("span", { text: ` transaction${toImport.length !== 1 ? "s" : ""} ready to import` }),
          dupCount ? h("span", {}, h("span", { text: ", " }), h("strong", { text: String(dupCount) }), h("span", { text: ` flagged as duplicate${dupCount !== 1 ? "s" : ""}` })) : null,
          h("span", { text: "." }),
        ));
        const list = h("div", { class: "tx-import-list" });
        if (!st.parsedTxs.length) {
          list.append(h("div", { class: "tx-import-empty", text: "Nothing to import." }));
        } else {
          const catOpts = catOptionsForAccount(budget, st.accountId, [{ value: RTA, label: "→ Ready to Assign (record as income)" }]);
          st.parsedTxs.forEach((p, i) => {
            const named = displayName(budget, toTitleCase(p.payee || ""));
            const defCat = named ? payeeDefaultCategory(budget, named) : "";
            const sugCat = named ? payeeSuggestedCategory(budget, named) : "";
            const isRTA = p.categoryId === RTA;
            const isPositive = p.amount > 0;
            const amtClass = isRTA || !isPositive ? "in" : "out";
            const meta = [];
            try {
              meta.push(new Date(p.date + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }));
            } catch { meta.push(p.date); }
            if (isRTA) meta.push("→ Income / RTA");
            else if (!isPositive) meta.push("→ Refund / Return");
            else meta.push("expense");
            if ((defCat || sugCat) && !isRTA && isPositive) meta.push(`${defCat ? "Default" : "Suggested"} pre-filled`);
            const skip = h("input", { type: "checkbox", checked: !!p.skip });
            skip.addEventListener("change", () => { p.skip = skip.checked; paint(); });
            const row = h("div", { class: `tx-import-row${p.duplicate ? " dup" : ""}${p.skip ? " skipped" : ""}` },
              h("div", { class: "tx-import-row-top" },
                h("span", { class: "tx-import-payee", text: p.payee || "No payee" }),
                h("span", { class: `tx-import-amt ${amtClass}`, text: fmt(p.amount) }),
              ),
              h("div", { class: "tx-import-meta", text: meta.join(" · ") }),
              p.duplicate ? h("div", { class: "tx-import-dup", text: "Possible duplicate of an existing transaction" }) : null,
              h("label", { class: "tx-import-skip" }, skip, h("span", { text: p.duplicate ? "Skip (duplicate)" : (p.payee ? "Skip this row" : "Skipped — no payee") })),
            );
            if (!p.skip) {
              row.append(searchableSel({
                value: p.categoryId || "",
                placeholder: "Search categories...",
                options: catOpts,
                onChange: (v) => { p.categoryId = v; paint(); },
              }));
            }
            list.append(row);
          });
        }
        kids.push(list);
        const actions = h("div", { class: "tx-form-actions" });
        if (toImport.length === 0) {
          actions.append(btn(st.parsedTxs.some((p) => p.duplicate) && !st.parsedTxs.some((p) => !p.duplicate && !p.skip) ? "Dismiss" : "Dismiss", { kind: "primary", onClick: () => sheet.close() }));
          if (st.parsedTxs.length) actions.prepend(btn("Back", { kind: "ghost", onClick: () => { st.step = "map"; paint(); } }));
        } else {
          actions.append(btnRow(
            { label: "Back", kind: "ghost", onClick: () => { st.step = "map"; paint(); } },
            { label: `Import ${toImport.length} Transaction${toImport.length !== 1 ? "s" : ""}`, kind: "primary", onClick: finishImport },
          ));
        }
        kids.push(actions);
        append(host, ...kids);
      };

      const paint = () => {
        clear(host);
        if (st.step === "select") paintSelect();
        else if (st.step === "map") paintMap();
        else paintReview();
      };
      paint();
    },
  });
}

function liveDuplicatePairs(budget) {
  return (budget.pendingDuplicates || []).filter((p) => budget.transactions.some((t) => t.id === p.newTxId) && budget.transactions.some((t) => t.id === p.existingTxId));
}

function dupCard(budget, tx) {
  if (!tx) return h("div", { class: "tx-dup-card" }, h("div", { class: "tx-dup-payee", text: "—" }));
  const acct = [...(budget.accounts || []), ...(budget.creditCards || [])].find((a) => a.id === tx.accountId);
  const cat = tx.categoryId ? (budget.categories || []).find((c) => c.id === tx.categoryId) : null;
  const amt = amountLabel(budget, tx);
  const isOut = tx.type === "expense" || (tx.type === "payment" && !isCard(budget, tx.accountId)) || (tx.type !== "income" && Number(tx.amount) < 0);
  return h("div", { class: "tx-dup-card" },
    h("div", { class: "tx-dup-payee", text: displayName(budget, tx.originalPayee || tx.payee) || "—" }),
    h("div", { class: "tx-dup-date", text: tx.date }),
    h("div", { class: `tx-dup-amt${isOut ? " out" : " in"}`, text: amt }),
    acct ? h("div", { class: "tx-dup-meta", text: `📂 ${acct.name}` }) : null,
    cat ? h("div", { class: "tx-dup-meta", text: `🏷 ${cat.name}` }) : null,
    tx.note ? h("div", { class: "tx-dup-note", text: `"${tx.note}"` }) : null,
  );
}

function setSheetTitle(host, title) {
  const el = host.closest(".sheet")?.querySelector(".sheet-title");
  if (el) el.textContent = title;
}

export function openDupes(ctx) {
  const initial = liveDuplicatePairs(ctx.budget()).length;
  const sheet = openSheet({
    title: `⚠️ Potential Duplicate (${initial} remaining)`,
    body: (host) => {
      const paint = () => {
        const budget = ctx.budget();
        const pairs = liveDuplicatePairs(budget);
        clear(host);
        setSheetTitle(host, `⚠️ Potential Duplicate (${pairs.length} remaining)`);
        if (!pairs.length) {
          host.append(h("p", { class: "tx-dup-lede", text: "All caught up." }));
          return;
        }
        const pair = pairs[0];
        const txA = budget.transactions.find((t) => t.id === pair.newTxId);
        const txB = budget.transactions.find((t) => t.id === pair.existingTxId);
        const resolve = (keep) => {
          if (ctx.readOnly()) { toast("View only — this budget can’t be edited"); return; }
          let err = null;
          ctx.updateBudget((bud) => {
            const out = resolveDuplicatePair(bud, pair, keep);
            if (out.error) { err = out.error; return null; }
            return out.budget;
          });
          if (err) { toast(err); return; }
          ctx.render();
          if (!liveDuplicatePairs(ctx.budget()).length) sheet.close();
          else paint();
        };
        host.append(
          h("p", { class: "tx-dup-lede", text: "These two transactions look like they might be the same. Choose which one to keep, or keep both if they're different transactions." }),
          h("div", { class: "tx-dup-pair" },
            dupCard(budget, txA),
            h("div", { class: "tx-dup-swap", text: "⟷" }),
            dupCard(budget, txB),
          ),
          h("div", { class: "tx-dup-actions" },
            h("div", { class: "tx-dup-keep-row" },
              btn("Keep Left", { onClick: () => resolve("left") }),
              btn("Keep Right", { onClick: () => resolve("right") }),
            ),
            btn("Keep Both", { kind: "ghost", onClick: () => resolve("both") }),
          ),
        );
      };
      paint();
    },
  });
}

function fixDateLabel(date) {
  if (!date) return "";
  return new Date(`${date}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function fixAccountSelect(budget, tx) {
  const sel = h("select", { class: "input" });
  sel.append(h("option", { value: "", text: "Select an account..." }));
  const cash = (budget.accounts || []).filter((a) => !a.archived || a.id === tx.accountId);
  const cards = (budget.creditCards || []).filter((c) => !c.archived || c.id === tx.accountId);
  if (cash.length) {
    const og = h("optgroup", { label: "Cash & Bank Accounts" });
    for (const a of cash) og.append(h("option", { value: a.id, text: a.name }));
    sel.append(og);
  }
  if (cards.length) {
    const og = h("optgroup", { label: "Credit Cards" });
    for (const c of cards) og.append(h("option", { value: c.id, text: c.name }));
    sel.append(og);
  }
  sel.value = tx.accountId || "";
  return sel;
}

function fixCategorySelect(budget, tx) {
  const sel = h("select", { class: "input" });
  sel.append(h("option", { value: "", text: "Select a category..." }));
  for (const g of budget.categoryGroups || []) {
    const og = h("optgroup", { label: g.name });
    for (const c of (budget.categories || []).filter((c) => c.groupId === g.id && !c.archived)) {
      og.append(h("option", { value: c.id, text: c.name }));
    }
    sel.append(og);
  }
  sel.value = tx.categoryId || "";
  return sel;
}

export function openFixTransactions(ctx) {
  const sheet = openSheet({
    title: "⚠️ Fix Transactions",
    body: (host) => {
      const paint = () => {
        const budget = ctx.budget();
        const rows = (budget.transactions || []).filter(needsAttention);
        clear(host);
        host.append(h("p", { class: "tx-fix-lede", text: "These transactions are missing an account and/or category. Assign what's needed for each." }));
        if (!rows.length) {
          host.append(h("p", { class: "tx-fix-empty", text: "All transactions have an account and category." }));
        }
        for (const tx of rows) {
          const row = h("div", { class: "tx-fix-row" });
          const payee = displayName(budget, tx.originalPayee || tx.payee) || "—";
          row.append(h("div", { class: "tx-fix-head" },
            h("span", { text: `${payee} — ${amountLabel(budget, tx)} ` }),
            h("span", { class: "tx-fix-date", text: `(${fixDateLabel(tx.date)})` }),
          ));
          const needAccount = !tx.accountId;
          const needCategory = !tx.splits && (!tx.categoryId || tx.categoryConfirmed === false);
          if (needAccount) {
            const sel = fixAccountSelect(budget, tx);
            sel.disabled = !!ctx.readOnly();
            sel.addEventListener("change", () => {
              if (!sel.value || ctx.readOnly()) return;
              ctx.updateBudget((b) => updateTransaction(b, tx.id, { accountId: sel.value }));
              ctx.render();
              paint();
            });
            row.append(sel);
          }
          if (needCategory) {
            const wrap = h("div", { class: "tx-fix-cat" });
            const sel = fixCategorySelect(budget, tx);
            sel.disabled = !!ctx.readOnly();
            sel.addEventListener("change", () => {
              if (!sel.value || ctx.readOnly()) return;
              ctx.updateBudget((b) => setTxCategory(b, tx.id, sel.value));
              ctx.render();
              paint();
            });
            wrap.append(sel);
            row.append(wrap);
          }
          host.append(row);
        }
        host.append(btn("Done", { block: true, onClick: () => sheet.close() }));
      };
      paint();
    },
  });
}

function openBulkCat(ctx) {
  const budget = ctx.budget();
  const sheet = openSheet({
    title: "Set category",
    body: (host) => {
      const sel = categorySelect(budget, "", true);
      host.append(sel, btn("Apply", { block: true, onClick: () => {
        const ids = [...ctx.ui.selected];
        ctx.updateBudget((b) => {
          let cur = b;
          for (const id of ids) cur = setTxCategory(cur, id, sel.value);
          return cur;
        });
        ctx.ui.selected.clear();
        sheet.close();
      }}));
    },
  });
}

function openBulkAccount(ctx) {
  const budget = ctx.budget();
  const sheet = openSheet({
    title: "Set account",
    body: (host) => {
      const sel = h("select", { class: "input" });
      for (const a of [...(budget.accounts || []), ...(budget.creditCards || [])].filter((a) => !a.archived)) {
        sel.append(h("option", { value: a.id, text: a.name }));
      }
      host.append(h("p", { class: "hint", text: "Locked (reconciled) transactions are skipped." }), sel, btn("Apply", { block: true, onClick: () => {
        const ids = [...ctx.ui.selected];
        ctx.updateBudget((b) => {
          let cur = b;
          for (const id of ids) {
            const item = (cur.transactions || []).find((tx) => tx.id === id);
            if (!item || isLocked(cur, item)) continue;
            cur = updateTransaction(cur, id, { accountId: sel.value });
          }
          return cur;
        });
        ctx.ui.selected.clear();
        sheet.close();
        toast("Account updated", { label: "Undo", action: () => ctx.undo() });
      }}));
    },
  });
}

