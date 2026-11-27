import { h, btn, openSheet, field, textInput, toast, moneyButton, confirmDialog, keepFocus, iconBtn, bindLongPress } from "../ui.js?v=154";
import { fmt, todayKey, toTitleCase, isCard, ccPayCat, makePayFrom, RTA, uid, monthLabel } from "../util.js?v=154";
import { deviceSet } from "../store.js?v=154";
import { displayName, payeeDefaultCategory, payeeSuggestedCategory, findFuzzyDuplicates, isAccountPayee } from "../payees.js?v=154";
import { addTransaction, deleteTransactions, isLocked, setTxCategory, updateTransaction, replaceTransaction, confirmCategories } from "../mutate.js?v=154";
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
    root.append(h("button", { class: "tx-attn", type: "button", onclick: () => {
      ctx.ui.txFilter = { ...blankTxFilters(), categoryId: UNCONFIRMED_FILTER };
      ctx.ui.txQuery = "";
      ctx.ui.showTxFilters = true;
      ctx.render();
    } },
      h("strong", { text: `⚠️ ${attentionAll.length} transaction${attentionAll.length !== 1 ? "s" : ""} need${attentionAll.length === 1 ? "s" : ""} attention` }),
      h("span", { text: " · Missing or Unconfirmed Categories · Tap to fix" }),
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

export function openTx(ctx, existing) {
  const budget = ctx.budget();
  if (existing?.subtype === "starting_balance") { toast("Starting balances can’t be edited or deleted"); return; }
  const editing = !!(existing?.id && !existing.draft);
  const locked = editing && isLocked(budget, existing);
  const form = {
    date: existing?.date || todayKey(),
    payee: existing ? displayName(budget, existing.originalPayee || existing.payee) : "",
    note: existing?.note || "",
    amount: existing ? Math.abs(Number(existing.amount) || 0) : 0,
    isRefund: existing?.type === "expense" && Number(existing.amount) < 0,
    accountId: existing?.accountId || budget.accounts.find((a) => !a.archived)?.id || "",
    categoryId: existing?.type === "income" ? RTA : (existing?.categoryId || ""),
    transferAccountId: existing?.transferAccountId || "",
    splits: existing?.splits ? existing.splits.map((s) => ({ ...s, amount: Math.abs(s.amount) })) : null,
    type: existing?.type || "expense",
  };
  const sheet = openSheet({
    title: existing?.draft ? "Enter the other side" : (editing ? "Edit transaction" : "New transaction"),
    body: (host) => {
      const date = h("input", { class: "input", type: "date", value: form.date });
      date.addEventListener("change", () => { form.date = date.value; });
      const payee = textInput({ value: form.payee, placeholder: "Payee" });
      const suggest = h("div", { class: "suggest" });
      const refreshSug = () => {
        suggest.replaceChildren();
        const q = payee.value.trim().toLowerCase();
        if (q.length < 1) return;
        const names = [...new Set((budget.transactions || []).map((t) => displayName(budget, t.originalPayee || t.payee)).filter((n) => n && !isAccountPayee(budget, n)))];
        for (const n of names.filter((n) => n.toLowerCase().includes(q)).slice(0, 6)) {
          suggest.append(h("button", { type: "button", class: "sug", text: n, onclick: () => {
            payee.value = n; form.payee = n;
            const def = payeeDefaultCategory(budget, n) || payeeSuggestedCategory(budget, n);
            if (def) { form.categoryId = def; form.categoryConfirmed = !!payeeDefaultCategory(budget, n); cat.value = def; }
            suggest.replaceChildren();
          }}));
        }
      };
      payee.addEventListener("input", () => { form.payee = payee.value; refreshSug(); });
      const acct = h("select", { class: "input" });
      for (const a of budget.accounts) if (!a.archived || a.id === form.accountId) acct.append(h("option", { value: a.id, text: a.name }));
      for (const c of budget.creditCards) if (!c.archived || c.id === form.accountId) acct.append(h("option", { value: c.id, text: c.name + " (card)" }));
      acct.value = form.accountId;
      const catSlot = h("div", { class: "cat-slot" });
      let cat = categorySelect(budget, form.accountId, true);
      const bindCat = (node, prev) => {
        cat = node;
        if (prev) cat.value = prev;
        form.categoryId = cat.value;
        cat.addEventListener("change", () => { form.categoryId = cat.value; });
        catSlot.replaceChildren(cat);
      };
      bindCat(cat, form.categoryId || "");
      const transfer = h("select", { class: "input" });
      const fillTransfer = () => {
        transfer.replaceChildren(h("option", { value: "", text: "Not a transfer" }));
        for (const a of [...budget.accounts, ...budget.creditCards]) {
          if (a.archived || a.id === form.accountId) continue;
          transfer.append(h("option", { value: a.id, text: a.name }));
        }
        transfer.value = form.transferAccountId || "";
      };
      acct.addEventListener("change", () => {
        form.accountId = acct.value;
        bindCat(categorySelect(budget, form.accountId, true), form.categoryId);
        fillTransfer();
      });
      fillTransfer();
      transfer.addEventListener("change", () => { form.transferAccountId = transfer.value; form.type = transfer.value ? "transfer" : "expense"; });
      const splitsBox = h("div");
      const paintSplits = () => {
        splitsBox.replaceChildren();
        if (!form.splits) return;
        for (const sp of form.splits) {
          const sel = categorySelect(budget, form.accountId, false);
          sel.value = sp.categoryId || "";
          sel.addEventListener("change", () => { sp.categoryId = sel.value; });
          splitsBox.append(h("div", { class: "line" }, sel, moneyButton(sp.amount, (n) => { sp.amount = n; })));
        }
        splitsBox.append(btn("Add split line", { kind: "quiet", onClick: () => { form.splits.push({ categoryId: "", amount: 0 }); paintSplits(); } }));
      };
      host.append(
        existing?.draft ? h("p", { class: "lede", text: "This is the missing side of a card payment. Check the account and category, then add it." }) : null,
        field("Date", date),
        field("Payee", payee),
        suggest,
        field("Account", acct),
        field("Category", catSlot),
        field("Transfer to", transfer),
        field("Amount", moneyButton(form.amount, (n) => { form.amount = Math.abs(n); form.isRefund = n < 0; })),
        h("p", { class: "hint", text: "Use the pad’s math keys, or toggle refund for a negative expense." }),
        btn(form.splits ? "Use one category" : "Split", { kind: "ghost", onClick: () => {
          form.splits = form.splits ? null : [{ categoryId: form.categoryId, amount: form.amount }];
          paintSplits();
        }}),
        splitsBox,
        field("Note", (() => { const t = h("textarea", { class: "input", rows: "2" }); t.value = form.note; t.addEventListener("input", () => { form.note = t.value; }); return t; })()),
      );
      paintSplits();
        if (!locked) {
        host.append(btn(editing ? "Save" : "Add", { block: true, onClick: () => {
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
        }}));
      } else host.append(h("p", { class: "hint", text: "Reconciled transactions can’t be deleted. You can still edit the note." }));
      if (editing && !locked) host.append(btn("Delete", { kind: "danger", block: true, onClick: () => {
        ctx.updateBudget((b) => deleteTransactions(b, [existing.id]));
        sheet.close();
        toast("Deleted", { label: "Undo", action: () => ctx.undo() });
      }}));
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

function openImport(ctx) {
  const budget = ctx.budget();
  const sheet = openSheet({
    title: "Import CSV",
    body: (host) => {
      const acct = h("select", { class: "input" });
      for (const a of [...budget.accounts, ...budget.creditCards].filter((a) => !a.archived)) acct.append(h("option", { value: a.id, text: a.name }));
      const file = h("input", { type: "file", accept: ".csv,text/csv" });
      const mapBox = h("div");
      host.append(field("Account", acct), field("CSV file", file), mapBox);
      file.addEventListener("change", async () => {
        const f = file.files?.[0]; if (!f) return;
        const rows = parseCSV(await f.text());
        if (rows.length < 2) { toast("No rows in that file"); return; }
        const headers = rows[0];
        const remembered = budget.csvMappings?.[acct.value];
        const mapping = remembered || guessColumnMapping(headers);
        mapBox.replaceChildren();
        const selects = {};
        const make = (label, key) => {
          const sel = h("select", { class: "input" }, h("option", { value: "", text: "—" }));
          headers.forEach((hd) => sel.append(h("option", { value: hd, text: hd })));
          sel.value = mapping[key] || "";
          selects[key] = sel;
          mapBox.append(field(label, sel));
        };
        make("Date", "dateCol"); make("Payee", "payeeCol"); make("Amount", "amountCol"); make("Debit", "debitCol"); make("Credit", "creditCol");
        const sign = h("select", { class: "input" },
          h("option", { value: "neg-expense", text: "Negative amounts are expenses" }),
          h("option", { value: "pos-expense", text: "Positive amounts are expenses" }),
        );
        sign.value = mapping.signConvention || "neg-expense";
        const mode = h("select", { class: "input" },
          h("option", { value: "single", text: "One amount column" }),
          h("option", { value: "split", text: "Separate debit and credit" }),
        );
        mode.value = mapping.amountMode || "single";
        mapBox.append(field("Amount style", mode), field("Sign", sign));
        const review = h("div", { class: "stack" });
        mapBox.append(h("p", { class: "kicker", text: "Review" }), review);
        const mappingNow = () => ({
          dateCol: selects.dateCol.value, payeeCol: selects.payeeCol.value, amountCol: selects.amountCol.value,
          debitCol: selects.debitCol.value, creditCol: selects.creditCol.value,
          amountMode: mode.value, signConvention: sign.value,
        });
        const parsedRows = () => rows.slice(1).map((r) => applyMapping(r, headers, mappingNow())).filter((p) => p.date && p.amount);
        let draft = [];
        const paintReview = () => {
          review.replaceChildren();
          draft = parsedRows();
          if (!draft.length) { review.append(h("p", { class: "hint", text: "No dated amounts with the columns selected." })); return; }
          draft.forEach((p, i) => {
            const expense = p.amount > 0;
            const named = toTitleCase((p.payee || "").trim());
            const guessed = named ? (payeeDefaultCategory(budget, named) || payeeSuggestedCategory(budget, named) || "") : "";
            p._named = named;
            p._skip = !named;
            p._categoryId = expense ? guessed : RTA;
            if (i >= 12) return;
            const cat = categorySelect(budget, acct.value, true);
            cat.value = p._categoryId;
            cat.addEventListener("change", () => { p._categoryId = cat.value; });
            const skip = h("input", { type: "checkbox", checked: !named });
            skip.addEventListener("change", () => { p._skip = skip.checked; });
            const row = h("div", { class: "pair" },
              h("p", { text: `${p.date} · ${named || "No payee"} · ${fmt(p.amount)}` }),
              h("label", { class: "choice" }, skip, h("span", { text: named ? "Skip this row" : "Skipped — no payee" })),
            );
            if (named) row.append(cat);
            review.append(row);
          });
          if (draft.length > 12) review.append(h("p", { class: "hint", text: `${draft.length - 12} more rows use each payee’s default category.` }));
        };
        for (const sel of Object.values(selects)) sel.addEventListener("change", paintReview);
        mode.addEventListener("change", paintReview);
        sign.addEventListener("change", paintReview);
        paintReview();
        mapBox.append(btn("Import", { block: true, onClick: () => {
          const map = mappingNow();
          let b = { ...budget, csvMappings: { ...(budget.csvMappings || {}), [acct.value]: map } };
          let added = 0; let dup = 0; let skipped = 0;
          const seen = new Set((b.transactions || []).map((t) => `${t.accountId}|${t.date}|${Math.abs(t.amount)}|${(t.originalPayee || t.payee || "").toLowerCase()}`));
          for (const parsed of draft) {
            const named = parsed._named || toTitleCase((parsed.payee || "").trim());
            if (!named || parsed._skip) { skipped++; continue; }
            const key = `${acct.value}|${parsed.date}|${Math.abs(parsed.amount)}|${named.toLowerCase()}`;
            if (seen.has(key)) { skipped++; continue; }
            seen.add(key);
            const expense = parsed.amount > 0;
            const chosen = parsed._categoryId || "";
            const confirmed = chosen ? chosen === (payeeDefaultCategory(b, named) || "") : true;
            const res = addTransaction(b, {
              date: parsed.date, payee: named, amount: Math.abs(parsed.amount),
              accountId: acct.value,
              categoryId: expense ? chosen : RTA,
              type: expense ? "expense" : "income",
              categoryConfirmed: confirmed,
            });
            if (res.error) continue;
            b = res.budget;
            added++;
            if ((b.pendingDuplicates || []).length > dup) dup = b.pendingDuplicates.length;
          }
          ctx.updateBudget(() => b);
          sheet.close();
          toast(`Imported ${added}${skipped ? `, skipped ${skipped}` : ""}${dup ? `, ${dup} possible duplicates` : ""}`);
        }}));
      });
    },
  });
}

function openDupes(ctx) {
  const budget = ctx.budget();
  const pairs = (budget.pendingDuplicates || []).filter((p) => budget.transactions.some((t) => t.id === p.newTxId) && budget.transactions.some((t) => t.id === p.existingTxId));
  const sheet = openSheet({
    title: "Possible duplicates",
    body: (host) => {
      for (const p of pairs) {
        const a = budget.transactions.find((t) => t.id === p.newTxId);
        const b = budget.transactions.find((t) => t.id === p.existingTxId);
        host.append(h("div", { class: "pair" },
          h("p", { text: `${a.date} ${displayName(budget, a.originalPayee || a.payee)} ${fmt(a.amount)}` }),
          h("p", { class: "muted", text: `Existing ${b.date} ${displayName(budget, b.originalPayee || b.payee)} ${fmt(b.amount)}` }),
          h("div", { class: "row gap" },
            btn("Keep both", { kind: "ghost", onClick: () => {
              ctx.updateBudget((bud) => ({ ...bud, pendingDuplicates: (bud.pendingDuplicates || []).filter((x) => x !== p && !(x.newTxId === p.newTxId && x.existingTxId === p.existingTxId)) }));
              sheet.close(); ctx.render(); openDupes(ctx);
            }}),
            btn("Delete new", { kind: "danger", onClick: () => {
              ctx.updateBudget((bud) => deleteTransactions({ ...bud, pendingDuplicates: (bud.pendingDuplicates || []).filter((x) => x.newTxId !== p.newTxId) }, [p.newTxId]));
              sheet.close();
            }}),
          ),
        ));
      }
      if (!pairs.length) host.append(h("p", { text: "All caught up." }));
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

