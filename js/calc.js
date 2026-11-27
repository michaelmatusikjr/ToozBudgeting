/** Zero-based budget math. Matches the ClearBudget rules: rollover, return, max, date goals, RTA. */
import { monthKey, prevMonth, nextMonth, round2 } from "./util.js?v=139";

const spentCache = new WeakMap();
const monthsCache = new WeakMap();

export function dataMonths(budget) {
  if (!budget) return [];
  const hit = monthsCache.get(budget);
  if (hit) return hit;
  const set = new Set();
  for (const k of Object.keys(budget.monthlyBudgets || {})) set.add(k);
  for (const k of Object.keys(budget.inflows || {})) set.add(k);
  for (const tx of budget.transactions || []) if (tx.date) set.add(tx.date.slice(0, 7));
  const out = [...set].sort();
  monthsCache.set(budget, out);
  return out;
}

export function budgetStart(budget) {
  const m = dataMonths(budget);
  return m.length ? m[0] : null;
}

export const hasPriorData = (budget, mk) => {
  const start = budgetStart(budget);
  return start !== null && prevMonth(mk) >= start;
};

export function spentByMonthCat(budget) {
  if (!budget) return {};
  const hit = spentCache.get(budget);
  if (hit) return hit;
  const map = {};
  for (const tx of budget.transactions || []) {
    if (tx.type !== "expense" && tx.type !== "payment") continue;
    if (!tx.date) continue;
    const mk = tx.date.slice(0, 7);
    const bucket = (map[mk] ||= {});
    if (tx.splits?.length) {
      for (const sp of tx.splits) {
        if (!sp.categoryId) continue;
        bucket[sp.categoryId] = (bucket[sp.categoryId] || 0) + Number(sp.amount);
      }
    } else if (tx.categoryId) {
      bucket[tx.categoryId] = (bucket[tx.categoryId] || 0) + Number(tx.amount);
    }
  }
  spentCache.set(budget, map);
  return map;
}

/** Signed effect of one transaction on its account balance. */
export function txBalanceEffect(tx, card) {
  const amt = Number(tx.amount) || 0;
  if (tx.type === "income") return Math.abs(amt);
  if (tx.type === "expense") return card ? amt : -amt;
  if (tx.type === "transfer") return amt;
  if (tx.type === "payment") return -Math.abs(amt);
  if (tx.type === "adjustment") return amt;
  return 0;
}

export function accountBalances(budget) {
  const map = {};
  for (const a of budget.accounts || []) map[a.id] = Number(a.balance) || 0;
  for (const c of budget.creditCards || []) map[c.id] = Number(c.balance) || 0;
  const card = (id) => (budget.creditCards || []).some((c) => c.id === id);
  for (const tx of budget.transactions || []) {
    if (map[tx.accountId] === undefined) continue;
    map[tx.accountId] += txBalanceEffect(tx, card(tx.accountId));
  }
  return map;
}

export function effectiveRollover(cat, mk) {
  if (!cat) return "rollover";
  const changes = cat.rolloverChanges || [];
  if (!changes.length) return cat.rollover || "rollover";
  const applicable = changes.filter((c) => c.month <= mk).sort((a, b) => b.month.localeCompare(a.month));
  return applicable[0]?.type || cat.rollover || "rollover";
}

function earliestKey(obj) {
  let min = null;
  if (!obj) return min;
  for (const k of Object.keys(obj)) if (!min || k < min) min = k;
  return min;
}

/** First month, including any preview assignment maps that start earlier than the saved budget. */
function rangeStart(budget, mb, inf) {
  let start = budgetStart(budget);
  if (mb && mb !== budget.monthlyBudgets) {
    const k = earliestKey(mb);
    if (k && (!start || k < start)) start = k;
  }
  if (inf && inf !== budget.inflows) {
    const k = earliestKey(inf);
    if (k && (!start || k < start)) start = k;
  }
  return start;
}

function monthsThrough(budget, mk, mb, inf) {
  const start = rangeStart(budget, mb, inf) || mk;
  const out = [];
  let k = start;
  let guard = 0;
  while (k <= mk && guard < 240) {
    out.push(k);
    k = nextMonth(k);
    guard++;
  }
  if (!out.length) out.push(mk);
  return out;
}

/** Available for one category at mk, walking forward from the budget's first month. */
export function available(budget, catId, mk, mb = budget.monthlyBudgets || {}, inf = budget.inflows || {}) {
  const cat = (budget.categories || []).find((c) => c.id === catId);
  const spent = spentByMonthCat(budget);
  const months = monthsThrough(budget, mk, mb, inf);
  let prevAvail = 0;
  let seen = false;
  for (const m of months) {
    const budgeted = Number((mb[m] || {})[catId] || 0);
    const sp = spent[m]?.[catId] || 0;
    if (!seen) {
      prevAvail = budgeted - sp;
      seen = true;
      continue;
    }
    const pk = prevMonth(m);
    let roll;
    if (prevAvail < 0) roll = prevAvail;
    else if (cat?.goal?.type === "date") roll = Math.min(prevAvail, cat.goal.target || 0);
    else {
      const s = effectiveRollover(cat, pk);
      if (s === "return") roll = 0;
      else if (s === "max") roll = Math.min(prevAvail, cat?.rolloverMax || 0);
      else roll = prevAvail;
    }
    prevAvail = budgeted - sp + roll;
  }
  return prevAvail;
}

export function catReturned(budget, cat, mk, mb, inf) {
  const start = rangeStart(budget, mb, inf);
  if (!start || prevMonth(mk) < start) return 0;
  const pk = prevMonth(mk);
  if (cat?.goal?.type !== "date") {
    const s = effectiveRollover(cat, pk);
    if (s !== "return" && s !== "max") return 0;
  }
  const pv = available(budget, cat.id, pk, mb, inf);
  if (pv <= 0) return 0;
  if (cat.goal?.type === "date") return Math.max(0, pv - Math.min(pv, cat.goal.target || 0));
  const s = effectiveRollover(cat, pk);
  if (s === "return") return pv;
  if (s === "max") return Math.max(0, pv - (cat.rolloverMax || 0));
  return 0;
}

export function returnedToRTA(budget, mk, mb = budget.monthlyBudgets || {}, inf = budget.inflows || {}, today = monthKey()) {
  const start = rangeStart(budget, mb, inf);
  if (!start || prevMonth(mk) < start) return 0;
  if (prevMonth(mk) >= today) return 0;
  return (budget.categories || []).reduce((t, cat) => t + catReturned(budget, cat, mk, mb, inf), 0);
}

const rtaCache = new WeakMap();

export function readyToAssign(budget, mk, mb = budget.monthlyBudgets || {}, inf = budget.inflows || {}, today = monthKey()) {
  const start = rangeStart(budget, mb, inf);
  if (!start || mk < start) {
    const budgeted = Object.values(mb[mk] || {}).reduce((s, v) => s + Number(v), 0);
    return Number(inf[mk] || 0) - budgeted;
  }
  let prev = 0;
  let k = start;
  let guard = 0;
  while (k <= mk && guard < 240) {
    const budgeted = Object.values(mb[k] || {}).reduce((s, v) => s + Number(v), 0);
    const inflow = Number(inf[k] || 0);
    const returned = returnedToRTA(budget, k, mb, inf, today);
    prev = prev + inflow + returned - budgeted;
    if (k === mk) return prev;
    k = nextMonth(k);
    guard++;
  }
  return prev;
}

export function furthestMonth(budget, viewMonth) {
  const keys = [viewMonth, ...Object.keys(budget.monthlyBudgets || {})].filter(Boolean).sort();
  return keys[keys.length - 1] || viewMonth;
}

export function globalFree(budget, viewMonth, today = monthKey()) {
  return readyToAssign(budget, furthestMonth(budget, viewMonth), budget.monthlyBudgets || {}, budget.inflows || {}, today);
}

export function assignedAhead(budget, month) {
  return Object.entries(budget.monthlyBudgets || {})
    .filter(([mk]) => mk > month)
    .reduce((sum, [, vals]) => sum + Object.values(vals).reduce((s, v) => s + Number(v), 0), 0);
}

export function getGoalMetrics(cat, avail, budgetedThisMonth, month) {
  if (!cat?.goal?.type) return null;
  const { type, target, targetDate } = cat.goal;
  const tgt = target || 0;
  if (type === "savings") {
    const p = tgt > 0 ? Math.min(100, (avail / tgt) * 100) : 0;
    return { type, target: tgt, current: avail, progress: p, complete: avail >= tgt - 0.005 };
  }
  if (type === "monthly") {
    const needed = Math.max(0, tgt - budgetedThisMonth);
    return { type, target: tgt, budgeted: budgetedThisMonth, needed, underfunded: budgetedThisMonth < tgt - 0.005 };
  }
  if (type === "date" && targetDate) {
    const [ty, tm] = targetDate.split("-").map(Number);
    const [cy, cm] = month.split("-").map(Number);
    const monthsLeft = Math.max(1, (ty - cy) * 12 + (tm - cm));
    const stillNeeded = Math.max(0, tgt - avail);
    const monthlyNeeded = Math.round((stillNeeded / monthsLeft) * 100) / 100;
    const complete = avail >= tgt - 0.005;
    const onTrack = complete || budgetedThisMonth >= monthlyNeeded - 0.005;
    const expired = month > targetDate;
    return { type, target: tgt, current: avail, monthsLeft, monthlyNeeded, onTrack, complete, expired, targetDate };
  }
  return null;
}

export function trailingAvg(budget, catId, mk) {
  const spent = spentByMonthCat(budget);
  let k = prevMonth(mk);
  let sum = 0, count = 0, guard = 0;
  while (count < 3 && guard < 3) {
    const monthSpend = spent[k]?.[catId];
    if (monthSpend !== undefined) { sum += monthSpend; count++; }
    k = prevMonth(k);
    guard++;
  }
  if (!count) return null;
  return { avg: sum / count, monthsUsed: count };
}

export function monthHasAssigned(budget, mk) {
  return Object.values((budget.monthlyBudgets || {})[mk] || {}).some((v) => Number(v) !== 0);
}
export function monthHasActivity(budget, mk) {
  return (budget.transactions || []).some((tx) => tx.date?.startsWith(mk));
}
export function monthAccessible(budget, mk, today = monthKey()) {
  if (mk <= today) {
    if (mk === today) return true;
    return monthHasActivity(budget, mk) || monthHasAssigned(budget, mk);
  }
  if (mk === nextMonth(today)) return true;
  return monthHasAssigned(budget, prevMonth(mk));
}

/** Build a snapshot used by the budget view so rows don't recompute independently. */
export function budgetSnapshot(budget, month, today = monthKey()) {
  const mb = budget.monthlyBudgets || {};
  const inf = budget.inflows || {};
  const cats = {};
  for (const cat of budget.categories || []) {
    cats[cat.id] = available(budget, cat.id, month, mb, inf);
  }
  const spent = spentByMonthCat(budget)[month] || {};
  const balances = accountBalances(budget);
  return {
    month,
    today,
    available: cats,
    activity: spent,
    budgeted: mb[month] || {},
    rta: readyToAssign(budget, month, mb, inf, today),
    free: globalFree(budget, month, today),
    ahead: assignedAhead(budget, month),
    returned: returnedToRTA(budget, month, mb, inf, today),
    balances,
    inflow: Number(inf[month] || 0),
  };
}

export function historySeries(budget, today = monthKey()) {
  const months = dataMonths(budget).filter((m) => m <= today);
  const spent = spentByMonthCat(budget);
  const ccIds = new Set((budget.categories || []).filter((c) => c.creditCardId).map((c) => c.id));
  return months.map((mk) => {
    const inflow = Number((budget.inflows || {})[mk] || 0);
    let activity = 0;
    for (const [catId, amt] of Object.entries(spent[mk] || {})) {
      if (!ccIds.has(catId)) activity += Number(amt) || 0;
    }
    const rta = readyToAssign(budget, mk, budget.monthlyBudgets || {}, budget.inflows || {}, today);
    return { month: mk, income: round2(inflow), spent: round2(Math.max(0, activity)), free: round2(rta) };
  });
}

export function overspentMonths(budget, today = monthKey()) {
  const start = budgetStart(budget);
  if (!start) return [];
  const spent = spentByMonthCat(budget);
  const cats = (budget.categories || []).filter((c) => !c.archived && !c.creditCardId);
  const prev = new Map();
  const out = [];
  let mk = start;
  let guard = 0;
  let first = true;
  while (mk <= today && guard < 240) {
    const bad = [];
    for (const cat of cats) {
      const budgeted = Number((budget.monthlyBudgets?.[mk] || {})[cat.id] || 0);
      const sp = spent[mk]?.[cat.id] || 0;
      let avail;
      if (first) avail = budgeted - sp;
      else {
        const p = prev.get(cat.id) || 0;
        let roll;
        if (p < 0) roll = p;
        else if (cat.goal?.type === "date") roll = Math.min(p, cat.goal.target || 0);
        else {
          const s = effectiveRollover(cat, prevMonth(mk));
          if (s === "return") roll = 0;
          else if (s === "max") roll = Math.min(p, cat.rolloverMax || 0);
          else roll = p;
        }
        avail = budgeted - sp + roll;
      }
      prev.set(cat.id, avail);
      if (avail < -0.005) bad.push(cat);
    }
    if (bad.length) out.push({ month: mk, cats: bad });
    first = false;
    mk = nextMonth(mk);
    guard++;
  }
  return out;
}

export function staleReconcile(budget, today = monthKey()) {
  const cutoff = (() => {
    const [y, m, d] = today.split("-").map(Number);
    const dt = new Date(y, m - 1, d);
    dt.setDate(dt.getDate() - 30);
    return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
  })();
  const stale = [];
  for (const a of budget.accounts || []) {
    if (a.archived) continue;
    const when = a.reconciledDate || a.lastReconciledDisplay;
    if (!when || when < cutoff) stale.push({ id: a.id, name: a.name, isCard: false, when: when || null });
  }
  for (const c of budget.creditCards || []) {
    if (c.archived) continue;
    const when = c.reconciledDate || c.lastReconciledDisplay;
    if (!when || when < cutoff) stale.push({ id: c.id, name: c.name, isCard: true, when: when || null });
  }
  return stale;
}

export function ccMismatches(budget, month) {
  const bal = accountBalances(budget);
  const out = [];
  for (const cc of budget.creditCards || []) {
    if (cc.archived) continue;
    const pay = (budget.categories || []).find((c) => c.creditCardId === cc.id);
    if (!pay) continue;
    const owed = bal[cc.id] || 0;
    const setAside = available(budget, pay.id, month);
    if (owed > 0.005 && setAside < owed - 0.005) out.push({ card: cc, pay, owed, setAside, short: owed - Math.max(0, setAside) });
  }
  return out;
}

void rtaCache;

/** Subset of transactions whose signed amounts sum to -target. Newest first. */
export function findUnclearedSuggestion(txList, target) {
  const need = Math.round(-target * 100);
  if (need === 0 || !txList?.length) return null;
  const sorted = [...txList].sort((a, b) => String(b.date).localeCompare(String(a.date)));
  const cents = sorted.map((tx) => Math.round(round2(Number(tx.amount)) * 100));
  if (sorted.length > 22) return null;
  let reach = new Map([[0, null]]);
  for (let i = 0; i < sorted.length; i++) {
    const additions = [];
    for (const [sum] of reach) {
      const next = sum + cents[i];
      if (!reach.has(next)) additions.push([next, { idx: i, prev: sum }]);
    }
    for (const [s, info] of additions) reach.set(s, info);
    if (reach.has(need)) break;
  }
  if (!reach.has(need)) return null;
  const ids = [];
  let cur = need;
  while (cur !== 0) {
    const info = reach.get(cur);
    if (!info) break;
    ids.push(sorted[info.idx].id);
    cur = info.prev;
  }
  return ids.length ? ids : null;
}
