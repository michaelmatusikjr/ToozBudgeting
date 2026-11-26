/** Budget mutations. Each function takes a budget and returns a new one. */
import {
  uid, toTitleCase, monthKey, todayKey, nextMonth, prevMonth, isCard, isBank, ccPayCat,
  isPayFrom, payFromId, round2, deepClone,
} from "./util.js";
import { available, readyToAssign, getGoalMetrics, globalFree, furthestMonth } from "./calc.js";
import {
  ensurePayee, prunePayees, findFuzzyDuplicates, runPaymentMatchScan, displayName,
  originalsForCanonical, payeeDefaultCategory, payeeSuggestedCategory,
} from "./payees.js";

const stamp = () => new Date().toISOString();

export function touch(budget, patch) {
  return { ...budget, ...patch, t: Date.now() };
}

function logMove(budget, entry) {
  const log = [...(budget.moneyMoveLog || []), { ...entry, ts: stamp() }];
  return log.slice(-200);
}

export function setAssigned(budget, month, catId, value) {
  const mb = deepClone(budget.monthlyBudgets || {});
  mb[month] = { ...(mb[month] || {}), [catId]: round2(value) };
  const prev = Number((budget.monthlyBudgets?.[month] || {})[catId] || 0);
  const delta = round2(value) - prev;
  const entry = delta !== 0 ? {
    type: "assign", month,
    entries: [{ from: delta < 0 ? catId : "rta", to: delta < 0 ? "rta" : catId, amount: Math.abs(delta) }],
  } : null;
  return touch(budget, {
    monthlyBudgets: mb,
    moneyMoveLog: entry ? logMove(budget, entry) : budget.moneyMoveLog,
  });
}

export function moveMoney(budget, month, fromId, toId, amount) {
  const n = round2(amount);
  if (!(n > 0) || fromId === toId) return budget;
  const mb = deepClone(budget.monthlyBudgets || {});
  const row = { ...(mb[month] || {}) };
  if (fromId) row[fromId] = round2((row[fromId] || 0) - n);
  if (toId) row[toId] = round2((row[toId] || 0) + n);
  mb[month] = row;
  return touch(budget, {
    monthlyBudgets: mb,
    moneyMoveLog: logMove(budget, { type: "move", month, entries: [{ from: fromId, to: toId, amount: n }] }),
  });
}

export function coverOverspending(budget, month, sources) {
  let mb = deepClone(budget.monthlyBudgets || {});
  const entries = [];
  const over = (budget.categories || []).filter((c) => !c.archived && !c.creditCardId && available({ ...budget, monthlyBudgets: mb }, c.id, month, mb) < -0.005);
  for (const src of sources) {
    let left = round2(src.amount);
    for (const cat of over) {
      if (left < 0.005) break;
      const short = Math.abs(available({ ...budget, monthlyBudgets: mb }, cat.id, month, mb));
      if (short < 0.005) continue;
      const apply = round2(Math.min(left, short));
      const row = { ...(mb[month] || {}) };
      if (src.id !== "rta" && src.id) row[src.id] = round2((row[src.id] || 0) - apply);
      row[cat.id] = round2((row[cat.id] || 0) + apply);
      mb[month] = row;
      entries.push({ from: src.id, to: cat.id, amount: apply });
      left = round2(left - apply);
    }
  }
  return touch(budget, {
    monthlyBudgets: mb,
    moneyMoveLog: logMove(budget, { type: "cover", month, entries }),
  });
}

function unassignPriority(cat) {
  if (!cat.goal?.type) return 0;
  if (cat.goal.type === "savings") return 1;
  if (cat.goal.type === "date") return 2;
  return 3;
}

/** Plan to free `shortfall` from future months so the current assignment can land. */
export function planClawback(budget, month, catId, newVal) {
  const oldVal = Number((budget.monthlyBudgets?.[month] || {})[catId] || 0);
  const delta = newVal - oldVal;
  const free = globalFree(budget, month);
  if (delta <= 1e-6 || delta <= free + 1e-6) return { ok: true, direct: true };
  let remaining = delta - free;
  const plan = [];
  const working = deepClone(budget.monthlyBudgets || {});
  let currentFree = free;
  const far = furthestMonth(budget, month);
  let mk = far;
  while (mk > month && remaining > 1e-6) {
    const cats = (budget.categories || [])
      .filter((c) => !c.archived && ((working[mk] || {})[c.id] || 0) > 1e-6)
      .sort((a, b) => unassignPriority(a) - unassignPriority(b));
    for (const c of cats) {
      if (remaining <= 1e-6) break;
      const before = working[mk][c.id];
      const take = Math.min(before, remaining);
      working[mk][c.id] = before - take;
      const newFree = readyToAssign({ ...budget, monthlyBudgets: working }, far, working, budget.inflows || {});
      const gain = newFree - currentFree;
      if (gain <= 1e-6) { working[mk][c.id] = before; continue; }
      plan.push({ month: mk, categoryId: c.id, categoryName: c.name, amount: take });
      currentFree = newFree;
      remaining -= gain;
    }
    mk = prevMonth(mk);
  }
  if (remaining > 1e-6) return { ok: false, insufficient: true, shortfall: delta - free, available: (delta - free) - remaining };
  return { ok: true, plan, catId, newVal, shortfall: delta - free };
}

export function applyClawback(budget, month, plan, catId, newVal) {
  const mb = deepClone(budget.monthlyBudgets || {});
  const entries = [];
  for (const step of plan) {
    mb[step.month] = mb[step.month] || {};
    mb[step.month][step.categoryId] = round2((mb[step.month][step.categoryId] || 0) - step.amount);
    entries.push({ type: "move", month: step.month, entries: [{ from: step.categoryId, to: "rta", amount: step.amount }] });
  }
  mb[month] = { ...(mb[month] || {}), [catId]: round2(newVal) };
  const log = [...(budget.moneyMoveLog || []), ...entries.map((e) => ({ ...e, ts: stamp() })), {
    type: "assign", month, ts: stamp(), entries: [{ from: "rta", to: catId, amount: round2(newVal - Number((budget.monthlyBudgets?.[month] || {})[catId] || 0)) }],
  }].slice(-200);
  return touch(budget, { monthlyBudgets: mb, moneyMoveLog: log });
}

export function computeMonthAssignments(budget, mk, mb, inf) {
  const budgetsForMonth = { ...(mb[mk] || {}) };
  let pool = readyToAssign(budget, mk, mb, inf);
  const assignments = [];
  if (pool <= 0.005) return { mb: { ...mb, [mk]: budgetsForMonth }, assignments, remaining: pool };
  const working = { ...mb, [mk]: budgetsForMonth };
  const assign = (catId, amt) => {
    budgetsForMonth[catId] = round2((budgetsForMonth[catId] || 0) + amt);
    working[mk] = budgetsForMonth;
    pool = round2(pool - amt);
    assignments.push({ categoryId: catId, amount: round2(amt) });
  };
  for (const cat of (budget.categories || []).filter((c) => c.goal?.type === "monthly" && !c.archived)) {
    if (pool <= 0.005) break;
    const avail = available(budget, cat.id, mk, working, inf);
    const m = getGoalMetrics(cat, avail, budgetsForMonth[cat.id] || 0, mk);
    if (!m) continue;
    const n = Math.max(0, m.target - (budgetsForMonth[cat.id] || 0));
    if (n > 0.005) assign(cat.id, Math.min(n, pool));
  }
  const dated = (budget.categories || [])
    .filter((c) => c.goal?.type === "date" && c.goal.targetDate && !c.archived)
    .sort((a, b) => a.goal.targetDate.localeCompare(b.goal.targetDate));
  for (const cat of dated) {
    if (pool <= 0.005) break;
    const avail = available(budget, cat.id, mk, working, inf);
    const m = getGoalMetrics(cat, avail, budgetsForMonth[cat.id] || 0, mk);
    if (!m || m.complete) continue;
    const n = Math.max(0, m.monthlyNeeded - (budgetsForMonth[cat.id] || 0));
    if (n > 0.005) assign(cat.id, Math.min(n, pool));
  }
  return { mb: { ...mb, [mk]: budgetsForMonth }, assignments, remaining: pool };
}

export function applyAssignments(budget, mk, amounts) {
  const row = { ...(budget.monthlyBudgets?.[mk] || {}) };
  const entries = [];
  for (const [catId, amt] of Object.entries(amounts)) {
    const n = round2(amt);
    if (n > 0) {
      row[catId] = round2((row[catId] || 0) + n);
      entries.push({ from: "rta", to: catId, amount: n });
    }
  }
  const mb = { ...(budget.monthlyBudgets || {}), [mk]: row };
  return touch(budget, {
    monthlyBudgets: mb,
    moneyMoveLog: entries.length ? logMove(budget, { type: "assign", month: mk, entries }) : budget.moneyMoveLog,
  });
}

function bumpCC(budget, accountId, month, delta, mb) {
  if (!isCard(budget, accountId)) return mb;
  const pay = ccPayCat(budget, accountId);
  if (!pay) return mb;
  const next = deepClone(mb);
  next[month] = { ...(next[month] || {}) };
  next[month][pay.id] = round2((next[month][pay.id] || 0) + delta);
  return next;
}

function addInflow(inf, month, delta, onBank) {
  if (!onBank) return inf;
  return { ...inf, [month]: round2((inf[month] || 0) + delta) };
}

function withDupes(budget, tx, existing) {
  const pairs = findFuzzyDuplicates(tx, existing);
  if (!pairs.length) return budget.pendingDuplicates || [];
  const already = budget.pendingDuplicates || [];
  const fresh = pairs.filter((p) => !already.some((e) => e.newTxId === p.newTxId && e.existingTxId === p.existingTxId));
  return [...already, ...fresh];
}

/**
 * Create a transaction.
 * form: { date, payee, note, amount, accountId, categoryId, splits, isRefund, transferAccountId }
 * categoryId may be __rta__, __pay_from__id, a real category, or empty.
 */
export function addTransaction(budget, form) {
  const amountAbs = round2(Math.abs(Number(form.amount) || 0));
  if (!form.accountId || !(amountAbs > 0)) return { budget, error: "Account and amount are required." };
  const card = isCard(budget, form.accountId);
  const bank = isBank(budget, form.accountId);
  const originalPayee = toTitleCase((form.payee || "").trim());
  const id = uid();
  const existing = budget.transactions || [];
  const base = {
    id, date: form.date || todayKey(), payee: originalPayee, originalPayee,
    note: (form.note || "").trim(), accountId: form.accountId, reconciled: false,
  };

  if (form.type === "transfer" || form.transferAccountId) {
    const toId = form.transferAccountId;
    if (!toId || toId === form.accountId) return { budget, error: "Pick a different account to transfer to." };
    const link = uid();
    const outAmt = card ? amountAbs : -amountAbs;
    const inAmt = isCard(budget, toId) ? -amountAbs : amountAbs;
    const a = { ...base, type: "transfer", amount: outAmt, transferAccountId: toId, transferLinkId: link, payee: originalPayee || "Transfer", originalPayee: originalPayee || "Transfer" };
    const b = {
      id: uid(), date: base.date, type: "transfer", accountId: toId, amount: inAmt,
      transferAccountId: form.accountId, transferLinkId: link,
      payee: originalPayee || "Transfer", originalPayee: originalPayee || "Transfer", note: base.note, reconciled: false,
    };
    let txs = [...existing, a, b];
    return { budget: touch(budget, { transactions: txs, pendingDuplicates: withDupes(budget, a, existing) }) };
  }

  if (form.categoryId === "__rta__" || form.type === "income") {
    const tx = { ...base, type: "income", categoryId: null, amount: amountAbs };
    const updates = { transactions: [...existing, tx] };
    if (!card) updates.inflows = addInflow(budget.inflows || {}, tx.date.slice(0, 7), amountAbs, true);
    updates.payees = ensurePayee(budget.payees || [], originalPayee, "");
    updates.pendingDuplicates = withDupes(budget, tx, existing);
    return { budget: touch(budget, updates) };
  }

  if (card && isPayFrom(form.categoryId)) {
    const fromAccountId = payFromId(form.categoryId);
    const payeeName = originalPayee || "Payment";
    const tx = { ...base, payee: payeeName, originalPayee: payeeName, type: "payment", amount: amountAbs, paymentLinkStatus: "broken", paymentFromAccountId: fromAccountId };
    const scanned = runPaymentMatchScan([...existing, tx], budget.creditCards, budget.accounts);
    return { budget: touch(budget, { transactions: scanned, pendingDuplicates: withDupes(budget, tx, existing) }) };
  }

  const ccCat = (budget.categories || []).find((c) => c.id === form.categoryId && c.creditCardId);
  if (bank && ccCat) {
    const payeeName = originalPayee || `${(budget.creditCards || []).find((c) => c.id === ccCat.creditCardId)?.name || "Card"} Payment`;
    const tx = { ...base, payee: payeeName, originalPayee: payeeName, type: "payment", categoryId: form.categoryId, amount: amountAbs, paymentLinkStatus: "broken" };
    const scanned = runPaymentMatchScan([...existing, tx], budget.creditCards, budget.accounts);
    return { budget: touch(budget, { transactions: scanned, pendingDuplicates: withDupes(budget, tx, existing) }) };
  }

  const signed = form.isRefund ? -amountAbs : amountAbs;
  const splits = form.splits?.length
    ? form.splits.map((sp) => ({ categoryId: sp.categoryId, amount: form.isRefund ? -Math.abs(round2(sp.amount)) : Math.abs(round2(sp.amount)) }))
    : null;
  const displayed = displayName(budget, originalPayee);
  const suggested = !splits && form.categoryId && !payeeDefaultCategory(budget, displayed) && !payeeSuggestedCategory(budget, displayed);
  const tx = {
    ...base, type: "expense", amount: signed,
    ...(splits ? { splits } : form.categoryId ? { categoryId: form.categoryId, categoryConfirmed: true } : {}),
  };
  const updates = { transactions: [...existing, tx] };
  if (card) updates.monthlyBudgets = bumpCC(budget, form.accountId, tx.date.slice(0, 7), signed, budget.monthlyBudgets || {});
  updates.payees = ensurePayee(budget.payees || [], originalPayee, "", suggested ? form.categoryId : "");
  updates.pendingDuplicates = withDupes(budget, tx, existing);
  return { budget: touch(budget, updates) };
}

export function deleteTransactions(budget, ids) {
  const idset = new Set(ids);
  const toDelete = (budget.transactions || []).filter((t) => idset.has(t.id) && t.subtype !== "starting_balance" && !isLocked(budget, t));
  const remove = new Set();
  let mb = deepClone(budget.monthlyBudgets || {});
  let inf = { ...(budget.inflows || {}) };
  for (const tx of toDelete) {
    remove.add(tx.id);
    if (tx.type === "transfer" && tx.transferLinkId) {
      const partner = (budget.transactions || []).find((t) => t.transferLinkId === tx.transferLinkId && t.id !== tx.id);
      if (partner && !isLocked(budget, partner)) remove.add(partner.id);
    }
    if (tx.type === "expense" && isCard(budget, tx.accountId)) {
      mb = bumpCC(budget, tx.accountId, tx.date.slice(0, 7), -Number(tx.amount), mb);
    }
    if (tx.type === "income" && isBank(budget, tx.accountId)) {
      const mk = tx.date.slice(0, 7);
      inf = { ...inf, [mk]: round2((inf[mk] || 0) - Number(tx.amount)) };
    }
    if (tx.type === "adjustment" && isBank(budget, tx.accountId)) {
      const mk = tx.date.slice(0, 7);
      inf = { ...inf, [mk]: round2((inf[mk] || 0) - Number(tx.amount)) };
    }
  }
  let txs = (budget.transactions || []).filter((t) => !remove.has(t.id));
  txs = txs.map((t) => {
    if (t.type === "payment" && t.paymentLinkStatus === "linked" && remove.has(t.paymentLinkId)) return { ...t, paymentLinkStatus: "broken" };
    return t;
  });
  return touch(budget, { transactions: txs, monthlyBudgets: mb, inflows: inf, payees: prunePayees(budget.payees || [], txs) });
}

export function isLocked(budget, tx) {
  if (!tx) return false;
  if (tx.subtype === "starting_balance") return true;
  if (tx.reconciled) return true;
  const acc = [...(budget.accounts || []), ...(budget.creditCards || [])].find((a) => a.id === tx.accountId);
  if (acc?.reconciledDate && tx.date <= acc.reconciledDate) return true;
  return false;
}

export function updateTransaction(budget, txId, patch) {
  const tx = (budget.transactions || []).find((t) => t.id === txId);
  if (!tx || tx.subtype === "starting_balance") return budget;
  const next = { ...tx, ...patch };
  if (patch.payee != null) {
    next.payee = toTitleCase(String(patch.payee).trim());
    if (!tx.originalPayee || tx.originalPayee === tx.payee) next.originalPayee = next.payee;
  }
  let txs = (budget.transactions || []).map((t) => t.id === txId ? next : t);
  let mb = budget.monthlyBudgets || {};
  if (tx.type === "expense" && isCard(budget, tx.accountId) && Number(patch.amount) !== Number(tx.amount) && patch.amount != null) {
    mb = bumpCC(budget, tx.accountId, tx.date.slice(0, 7), Number(patch.amount) - Number(tx.amount), mb);
  }
  if (next.type === "payment" || tx.type === "payment") txs = runPaymentMatchScan(txs, budget.creditCards, budget.accounts);
  let payees = budget.payees || [];
  if (next.originalPayee) payees = ensurePayee(payees, next.originalPayee, "");
  return touch(budget, { transactions: txs, monthlyBudgets: mb, payees: prunePayees(payees, txs) });
}

export function setTxCategory(budget, txId, categoryId) {
  const tx = (budget.transactions || []).find((t) => t.id === txId);
  if (!tx || isLocked(budget, tx) || tx.subtype === "starting_balance") return budget;
  if (isCard(budget, tx.accountId) && isPayFrom(categoryId)) {
    return updateTransaction(budget, txId, {
      type: "payment", categoryId: undefined, categoryConfirmed: undefined,
      paymentLinkStatus: "broken", paymentFromAccountId: payFromId(categoryId), splits: undefined,
    });
  }
  const cc = (budget.categories || []).find((c) => c.id === categoryId && c.creditCardId);
  if (isBank(budget, tx.accountId) && cc) {
    return updateTransaction(budget, txId, { type: "payment", categoryId, categoryConfirmed: undefined, paymentLinkStatus: "broken", splits: undefined });
  }
  const updated = { ...tx, categoryId, categoryConfirmed: true, type: tx.type === "payment" ? "expense" : tx.type };
  delete updated.splits;
  let txs = (budget.transactions || []).map((t) => t.id === txId ? updated : t);
  txs = runPaymentMatchScan(txs, budget.creditCards, budget.accounts);
  return touch(budget, { transactions: txs });
}

export function reconcileAccount(budget, accId, date, diff, txIdsToLock) {
  const card = isCard(budget, accId);
  let txs = budget.transactions || [];
  let mb = null;
  let inf = budget.inflows;
  if (Math.abs(diff) > 0.001) {
    const tx = {
      id: uid(), date, payee: "Balance Adjustment", originalPayee: "Balance Adjustment",
      note: "", type: "adjustment", accountId: accId, categoryId: null, amount: round2(diff), reconciled: true,
    };
    txs = [...txs, tx];
    if (!card) {
      const mk = date.slice(0, 7);
      inf = { ...(budget.inflows || {}), [mk]: round2(((budget.inflows || {})[mk] || 0) + diff) };
    } else {
      const pay = ccPayCat(budget, accId);
      if (pay) {
        const mk = date.slice(0, 7);
        const base = mb || budget.monthlyBudgets || {};
        mb = { ...base, [mk]: { ...(base[mk] || {}), [pay.id]: round2(((base[mk] || {})[pay.id] || 0) + diff) } };
      }
    }
  }
  const updates = { transactions: txs, inflows: inf };
  if (mb) updates.monthlyBudgets = mb;
  if (txIdsToLock) {
    const set = new Set(txIdsToLock);
    updates.transactions = txs.map((tx) => set.has(tx.id) ? { ...tx, reconciled: true } : tx);
    if (card) updates.creditCards = budget.creditCards.map((c) => c.id === accId ? { ...c, lastReconciledDisplay: date } : c);
    else updates.accounts = budget.accounts.map((a) => a.id === accId ? { ...a, lastReconciledDisplay: date } : a);
  } else if (card) updates.creditCards = budget.creditCards.map((c) => c.id === accId ? { ...c, reconciledDate: date } : c);
  else updates.accounts = budget.accounts.map((a) => a.id === accId ? { ...a, reconciledDate: date } : a);
  return touch(budget, updates);
}

const ARCHIVE_RE = /^\(\d{8}\) /;
function dateStamp() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}
function uniqueName(base, names) {
  const taken = new Set(names.map((n) => n.trim().toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  let i = 2;
  while (taken.has(`${base} (${i})`.toLowerCase())) i++;
  return `${base} (${i})`;
}

export function archiveAccount(budget, id, card) {
  const listKey = card ? "creditCards" : "accounts";
  const list = budget[listKey];
  const item = list.find((a) => a.id === id);
  if (!item) return budget;
  if (!item.archived) {
    const base = `(${dateStamp()}) ${item.name}`;
    const name = uniqueName(base, list.filter((a) => a.id !== id).map((a) => a.name));
    return touch(budget, { [listKey]: list.map((a) => a.id === id ? { ...a, archived: true, name } : a) });
  }
  const stripped = item.name.replace(ARCHIVE_RE, "");
  const name = uniqueName(stripped, list.filter((a) => a.id !== id).map((a) => a.name));
  return touch(budget, { [listKey]: list.map((a) => a.id === id ? { ...a, archived: false, name } : a) });
}

export function renameAccount(budget, id, card, name) {
  const listKey = card ? "creditCards" : "accounts";
  const titled = toTitleCase(name.trim());
  return touch(budget, { [listKey]: budget[listKey].map((a) => a.id === id ? { ...a, name: titled } : a) });
}

export function addAccount(budget, { name, type, balance }) {
  const titled = toTitleCase(name.trim());
  const id = uid();
  const today = todayKey();
  const mk = today.slice(0, 7);
  const bal = round2(balance || 0);
  const tx = {
    id: uid(), date: today, payee: "Starting Balance", originalPayee: "Starting Balance",
    note: "", type: "income", subtype: "starting_balance", accountId: id, categoryId: null, amount: bal, reconciled: true,
  };
  return touch(budget, {
    accounts: [...budget.accounts, { id, name: titled, type: type || "checking", balance: 0, archived: false }],
    transactions: [...budget.transactions, tx],
    inflows: bal > 0 ? { ...(budget.inflows || {}), [mk]: round2(((budget.inflows || {})[mk] || 0) + bal) } : budget.inflows,
  });
}

export function addCreditCard(budget, { name, balance }) {
  const titled = toTitleCase(name.trim());
  const id = uid();
  const today = todayKey();
  const mk = today.slice(0, 7);
  const bal = round2(Math.abs(balance || 0));
  let groups = budget.categoryGroups;
  let grp = groups.find((g) => g.name === "Credit Card Payments");
  if (!grp) { grp = { id: uid(), name: "Credit Card Payments" }; groups = [...groups, grp]; }
  const cat = { id: uid(), groupId: grp.id, name: `${titled} Payment`, creditCardId: id, rollover: "rollover", archived: false };
  const tx = {
    id: uid(), date: today, payee: "Starting Balance", originalPayee: "Starting Balance",
    note: "", type: "expense", subtype: "starting_balance", accountId: id, categoryId: cat.id, amount: bal, reconciled: true,
  };
  const mb = deepClone(budget.monthlyBudgets || {});
  if (bal > 0) { mb[mk] = { ...(mb[mk] || {}), [cat.id]: bal }; }
  return touch(budget, {
    creditCards: [...budget.creditCards, { id, name: titled, balance: 0, archived: false }],
    categoryGroups: groups,
    categories: [...budget.categories, cat],
    transactions: [...budget.transactions, tx],
    monthlyBudgets: mb,
  });
}

export function deleteAccount(budget, id, card) {
  const has = (budget.transactions || []).some((t) => t.accountId === id && t.subtype !== "starting_balance");
  if (has) return budget;
  if (card) {
    const cat = ccPayCat(budget, id);
    return touch(budget, {
      creditCards: budget.creditCards.filter((c) => c.id !== id),
      categories: cat ? budget.categories.filter((c) => c.id !== cat.id) : budget.categories,
      transactions: budget.transactions.filter((t) => t.accountId !== id),
    });
  }
  return touch(budget, {
    accounts: budget.accounts.filter((a) => a.id !== id),
    transactions: budget.transactions.filter((t) => t.accountId !== id),
  });
}

export function setCategory(budget, cat) {
  return touch(budget, { categories: budget.categories.map((c) => c.id === cat.id ? cat : c) });
}

export function addCategory(budget, { name, groupId }) {
  const titled = toTitleCase(name.trim());
  const cat = { id: uid(), groupId, name: titled, rollover: "rollover", archived: false };
  return { budget: touch(budget, { categories: [...budget.categories, cat] }), cat };
}

export function archiveCategory(budget, catId, month) {
  const cat = budget.categories.find((c) => c.id === catId);
  if (!cat) return budget;
  if (!cat.archived) {
    let groups = budget.categoryGroups;
    let uc = groups.find((g) => g.name === "Uncategorized");
    if (!uc) { uc = { id: uid(), name: "Uncategorized" }; groups = [...groups, uc]; }
    const base = `(${dateStamp()}) ${cat.name}`;
    const name = uniqueName(base, budget.categories.filter((c) => c.id !== cat.id).map((c) => c.name));
    const avail = available(budget, cat.id, month);
    const mb = deepClone(budget.monthlyBudgets || {});
    if (avail > 0.001) {
      mb[month] = mb[month] || {};
      mb[month][cat.id] = round2((mb[month][cat.id] || 0) - avail);
    }
    return touch(budget, {
      categoryGroups: groups,
      monthlyBudgets: mb,
      categories: budget.categories.map((c) => c.id === cat.id ? { ...c, archived: true, name, previousGroupId: c.groupId, groupId: uc.id } : c),
    });
  }
  const stripped = cat.name.replace(ARCHIVE_RE, "");
  const name = uniqueName(stripped, budget.categories.filter((c) => c.id !== cat.id).map((c) => c.name));
  const groupId = budget.categoryGroups.some((g) => g.id === cat.previousGroupId) ? cat.previousGroupId : cat.groupId;
  return touch(budget, { categories: budget.categories.map((c) => c.id === cat.id ? { ...c, archived: false, name, groupId } : c) });
}

export function deleteCategory(budget, catId) {
  const used = (budget.transactions || []).some((tx) => tx.categoryId === catId || tx.splits?.some((sp) => sp.categoryId === catId));
  if (used) return budget;
  const mb = deepClone(budget.monthlyBudgets || {});
  for (const mk of Object.keys(mb)) delete mb[mk][catId];
  return touch(budget, { categories: budget.categories.filter((c) => c.id !== catId), monthlyBudgets: mb });
}

export function setMonthNote(budget, month, catId, text) {
  const notes = deepClone(budget.categoryNotes || {});
  notes[month] = { ...(notes[month] || {}) };
  const t = (text || "").trim();
  if (t) notes[month][catId] = t;
  else delete notes[month][catId];
  return touch(budget, { categoryNotes: notes });
}

export function setCanonical(budget, originalNames, canonicalName) {
  const name = canonicalName.trim();
  if (!name) return budget;
  let payees = [...(budget.payees || [])];
  for (const n of originalNames) payees = ensurePayee(payees, n, "");
  payees = payees.map((p) => originalNames.includes(p.name) ? { ...p, canonicalName: name } : p);
  return touch(budget, { payees: prunePayees(payees, budget.transactions) });
}

export function unmergeOriginal(budget, originalName) {
  let payees = ensurePayee(budget.payees || [], originalName, "");
  payees = payees.map((p) => p.name === originalName ? { ...p, canonicalName: p.name } : p);
  return touch(budget, { payees: prunePayees(payees, budget.transactions) });
}

export function unmergeAll(budget) {
  const payees = (budget.payees || []).map((p) => ({ ...p, canonicalName: p.name }));
  return touch(budget, { payees: prunePayees(payees, budget.transactions) });
}

export function setPayeeCategory(budget, canonical, categoryId, which) {
  const originals = originalsForCanonical(budget, canonical);
  let payees = [...(budget.payees || [])];
  for (const name of originals) {
    const existing = payees.find((p) => p.name === name);
    if (existing) {
      payees = payees.map((p) => p.name === name ? {
        ...p,
        defaultCategoryId: which === "default" ? categoryId : "",
        suggestedCategoryId: which === "suggested" ? categoryId : "",
      } : p);
    } else {
      payees.push({
        id: uid(), name, canonicalName: canonical,
        defaultCategoryId: which === "default" ? categoryId : "",
        suggestedCategoryId: which === "suggested" ? categoryId : "",
      });
    }
  }
  return touch(budget, { payees });
}

export function rejectMerge(budget, names) {
  const key = [...names].sort().join("|||");
  const rejected = [...(budget.rejectedMerges || [])];
  if (!rejected.includes(key)) rejected.push(key);
  return touch(budget, { rejectedMerges: rejected });
}

export const DEFAULT_GROUPS = [
  { id: "grp-bills", name: "Monthly Bills" },
  { id: "grp-everyday", name: "Everyday Expenses" },
  { id: "grp-savings", name: "Savings Goals" },
];

export const DEFAULT_CATS = [
  { id: "cat-rent", groupId: "grp-bills", name: "Rent / Mortgage", rollover: "rollover" },
  { id: "cat-electric", groupId: "grp-bills", name: "Electric", rollover: "rollover" },
  { id: "cat-internet", groupId: "grp-bills", name: "Internet", rollover: "rollover" },
  { id: "cat-groc", groupId: "grp-everyday", name: "Groceries", rollover: "rollover" },
  { id: "cat-dining", groupId: "grp-everyday", name: "Dining Out", rollover: "rollover" },
  { id: "cat-gas", groupId: "grp-everyday", name: "Gas", rollover: "rollover" },
  { id: "cat-emerg", groupId: "grp-savings", name: "Emergency Fund", rollover: "rollover" },
  { id: "cat-vac", groupId: "grp-savings", name: "Vacation", rollover: "rollover" },
];

export function freshBudgetShell(name, ownerId) {
  return {
    id: uid(), name: name || "My Budget", createdAt: stamp(), archived: false, ownerId: ownerId || null,
    accounts: [], creditCards: [], categoryGroups: [], categories: [],
    monthlyBudgets: {}, inflows: {}, transactions: [], payees: [],
    mergeExcludeWords: ["TST*"], pendingDuplicates: [], rejectedMerges: [],
    moneyMoveLog: [], categoryNotes: {}, csvMappings: {}, reminders: [],
  };
}

export function finishWizard({ name, accounts, creditCards, groups, categories, ownerId }) {
  const today = todayKey();
  const mk = today.slice(0, 7);
  const accs = accounts.map((a) => ({ id: a.id || uid(), name: toTitleCase(a.name.trim()), type: a.type || "checking", balance: 0, archived: false, _seed: round2(a.balance || 0) }));
  const cards = creditCards.map((c) => ({ id: c.id || uid(), name: toTitleCase(c.name.trim()), balance: 0, archived: false, _seed: round2(Math.abs(c.balance || 0)) }));
  const ccGrpId = uid();
  const ccGroup = { id: ccGrpId, name: "Credit Card Payments" };
  const ccCats = cards.map((cc) => ({ id: uid(), groupId: ccGrpId, name: `${cc.name} Payment`, creditCardId: cc.id, rollover: "rollover", archived: false }));
  const preload = {};
  cards.forEach((cc, i) => { if (cc._seed > 0) preload[ccCats[i].id] = cc._seed; });
  const startTx = accs.map((a) => ({
    id: uid(), date: today, payee: "Starting Balance", originalPayee: "Starting Balance",
    note: "", type: "income", subtype: "starting_balance", accountId: a.id, categoryId: null, amount: a._seed, reconciled: true,
  }));
  const ccTx = cards.map((cc, i) => ({
    id: uid(), date: today, payee: "Starting Balance", originalPayee: "Starting Balance",
    note: "", type: "expense", subtype: "starting_balance", accountId: cc.id, categoryId: ccCats[i].id, amount: cc._seed, reconciled: true,
  }));
  const total = accs.reduce((s, a) => s + a._seed, 0);
  const budget = {
    ...freshBudgetShell(name, ownerId),
    accounts: accs.map(({ _seed, ...a }) => a),
    creditCards: cards.map(({ _seed, ...c }) => c),
    categoryGroups: [...groups, ...(cards.length ? [ccGroup] : [])],
    categories: [...categories.map((c) => ({ ...c, rollover: c.rollover || "rollover", archived: false })), ...ccCats],
    monthlyBudgets: Object.keys(preload).length ? { [mk]: preload } : {},
    transactions: [...startTx, ...ccTx],
    inflows: total > 0 ? { [mk]: round2(total) } : {},
  };
  return budget;
}

export function copyCategories(from) {
  const idMap = {};
  const groups = (from.categoryGroups || []).filter((g) => g.name !== "Credit Card Payments").map((g) => {
    const id = uid(); idMap[g.id] = id; return { id, name: g.name };
  });
  const categories = (from.categories || []).filter((c) => !c.creditCardId && !c.archived).map((c) => ({
    id: uid(), groupId: idMap[c.groupId] || groups[0]?.id, name: c.name,
    rollover: c.rollover || "rollover", rolloverMax: c.rolloverMax, goal: c.goal ? { ...c.goal } : undefined, notes: c.notes,
  })).filter((c) => c.groupId);
  return { groups, categories };
}

export function normalizeBudget(b) {
  const budget = {
    id: b.id || uid(),
    name: b.name || "Budget",
    createdAt: b.createdAt || stamp(),
    archived: !!b.archived,
    ownerId: b.ownerId || null,
    accounts: (b.accounts || []).map((a) => ({ balance: 0, archived: false, type: "checking", ...a })),
    creditCards: (b.creditCards || []).map((c) => ({ balance: 0, archived: false, ...c })),
    categoryGroups: b.categoryGroups || [],
    categories: (b.categories || []).map((c) => ({ rollover: "rollover", archived: false, ...c })),
    monthlyBudgets: b.monthlyBudgets || {},
    inflows: b.inflows || {},
    transactions: (b.transactions || []).map((tx) => tx.originalPayee !== undefined ? tx : { ...tx, originalPayee: tx.payee }),
    payees: (b.payees || []).map((p) => ({
      id: p.id || uid(), name: p.name, defaultCategoryId: p.defaultCategoryId || "",
      suggestedCategoryId: p.suggestedCategoryId || "", canonicalName: p.canonicalName || p.name,
    })),
    mergeExcludeWords: b.mergeExcludeWords || ["TST*"],
    pendingDuplicates: b.pendingDuplicates || [],
    rejectedMerges: b.rejectedMerges || [],
    moneyMoveLog: b.moneyMoveLog || [],
    categoryNotes: b.categoryNotes || {},
    csvMappings: b.csvMappings || {},
    reminders: b.reminders || [],
  };
  return budget;
}

export function emptyApp() {
  return { sv: 1, setupComplete: false, activeBudgetId: null, activeUserId: null, users: [], budgets: [] };
}
