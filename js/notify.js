/** Local reminders while the app is open. Closed-app delivery is js/push.js. */
import { deviceGet, deviceSet } from "./store.js?v=154";
import { monthKey, todayKey, timeZone, monthLabel, fmt, daysSince } from "./util.js?v=154";
import { overspentMonths, staleReconcile, ccMismatches } from "./calc.js?v=154";
import { buildMergeGroups, payeeDirectory, displayName } from "./payees.js?v=154";

const timers = new Set();

export function clearLocalTimers() {
  for (const t of timers) clearTimeout(t);
  timers.clear();
}

async function firedSet() {
  return new Set((await deviceGet("firedReminders")) || []);
}
async function markFired(id) {
  const s = await firedSet();
  s.add(id);
  const arr = [...s].slice(-400);
  await deviceSet("firedReminders", arr);
}

export async function showLocal(title, body, url, tag) {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  const reg = await navigator.serviceWorker?.getRegistration();
  const data = { url: url || "./", title, body };
  if (reg?.showNotification) {
    await reg.showNotification(title, { body, tag: tag || title, data, icon: "./icons/icon-192.png", badge: "./icons/icon-192.png" });
  } else {
    const n = new Notification(title, { body, tag, data });
    n.onclick = () => { location.hash = (url || "").replace(/^\.\//, ""); };
  }
}

function atTime(dateKey, hhmm) {
  const [y, m, d] = dateKey.split("-").map(Number);
  const [hh, mm] = (hhmm || "09:00").split(":").map(Number);
  return new Date(y, m - 1, d, hh || 9, mm || 0, 0, 0).getTime();
}

function suggestedMergeGroups(budget) {
  const counts = {};
  for (const tx of budget.transactions || []) {
    if (tx.subtype === "starting_balance") continue;
    const n = displayName(budget, tx.originalPayee || tx.payee);
    if (!n) continue;
    counts[n] = (counts[n] || 0) + 1;
  }
  const shown = payeeDirectory(budget).filter((n) => counts[n]);
  return buildMergeGroups(shown, budget.rejectedMerges || [], budget.mergeExcludeWords || ["TST*"]);
}

function pendingFuzzyDuplicates(budget) {
  return (budget.pendingDuplicates || []).filter((p) =>
    (budget.transactions || []).some((t) => t.id === p.newTxId)
    && (budget.transactions || []).some((t) => t.id === p.existingTxId)
  );
}

function dateLabel(date) {
  if (!date) return "";
  return new Date(date + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** Alerts for the bell panel. Custom reminders, bills, and low Ready to Assign are not included. */
export function collectReminders(budget, month) {
  if (!budget) return [];
  const today = todayKey();
  const rules = [];
  const push = (r) => rules.push({ time: "09:00", offsetDays: 0, date: today, recur: { type: "none" }, ...r });

  const merges = suggestedMergeGroups(budget);
  if (merges.length) {
    const n = merges.length;
    push({
      id: "merge-suggestions", kind: "merge", icon: "🔀", tag: "Payees",
      title: `${n} payee merge suggestion${n !== 1 ? "s" : ""}`,
      body: `${n} group${n !== 1 ? "s" : ""} of payees look like they might be the same vendor. Merging duplicates keeps your payee list clean and makes reports more accurate.`,
      action: { label: "Review Merge Suggestions", color: "purple" },
      panelOnly: true,
    });
  }

  const overs = overspentMonths(budget);
  if (overs.length) {
    const oldest = overs[0].month;
    const count = overs.length;
    const more = count > 1 ? ` (+${count - 1} more month${count - 1 !== 1 ? "s" : ""})` : "";
    push({
      id: `overspend:${oldest}`, kind: "overspend", icon: "🔴", tag: "Budget",
      title: `Overspending in ${monthLabel(oldest)}${more}`,
      body: `${count > 1 ? `${count} months have` : `${monthLabel(oldest)} has`} unresolved overspending. Covering overspending moves funds from other categories to bring the overspent categories back to zero. Start with the oldest month first — after covering it the notification will advance to the next.`,
      action: { label: `Cover Overspending in ${monthLabel(oldest)}`, color: "danger" },
      url: `./#budget/${oldest}`, targetMonth: oldest,
    });
  }
  for (const tx of budget.transactions || []) {
    if (tx.type !== "payment" || tx.paymentLinkStatus !== "broken") continue;
    const cardSide = (budget.creditCards || []).some((c) => c.id === tx.accountId);
    const acct = cardSide
      ? (budget.creditCards || []).find((c) => c.id === tx.accountId)
      : (budget.accounts || []).find((a) => a.id === tx.accountId);
    const who = acct?.name || "Unknown";
    const when = dateLabel(tx.date);
    const amt = fmt(Math.abs(tx.amount));
    push({
      id: `payment:${tx.id}`, kind: "payment", icon: "⛓️‍💥", tag: who,
      title: `${amt} payment on ${when} — unmatched`,
      body: cardSide
        ? `A ${amt} payment on ${when} was recorded on ${who} but hasn't been matched to the bank side. Tap to enter the missing bank transaction.`
        : `A ${amt} payment on ${when} from ${who} hasn't been matched to the credit card side. Tap to enter the missing card transaction.`,
      action: { label: "Enter Missing Transaction", color: "primary" },
      url: "./#transactions",
    });
  }
  const mk = month || monthKey();
  for (const m of ccMismatches(budget, mk)) {
    push({
      id: `cc:${m.card.id}`, kind: "cc", icon: "💳", tag: "Credit Cards",
      title: `${m.card.name} payment category is underfunded`,
      body: `Your ${m.card.name} balance is ${fmt(m.owed)}, but you've only set aside ${fmt(Math.max(0, m.setAside))} in the payment category — a shortfall of ${fmt(m.short)}. Budget an additional ${fmt(m.short)} to the ${m.card.name} payment category to cover the full balance.`,
      action: { label: "Go to Budget", color: "primary" },
      url: `./#budget/${mk}`,
    });
  }
  for (const s of staleReconcile(budget)) {
    const days = s.when ? daysSince(s.when) : null;
    push({
      id: `recon:${s.id}`, kind: "reconcile", icon: "📋", tag: s.isCard ? "Credit Card" : "Account",
      title: `${s.name} hasn't been reconciled${days !== null ? ` in ${days} days` : " yet"}`,
      body: `Regular reconciliation confirms your ToozBudgeting balances match your actual bank statements and helps catch errors early. ${days !== null ? `${s.name} was last reconciled ${days} days ago.` : `${s.name} has never been reconciled.`} Go to the Accounts tab to reconcile.`,
      action: { label: `Reconcile ${s.name}`, color: "primary" },
      url: `./#accounts/${s.id}`,
    });
  }
  const dups = pendingFuzzyDuplicates(budget);
  if (dups.length) {
    const n = dups.length;
    push({
      id: "fuzzy-duplicates", kind: "fuzzy", icon: "⚠️", tag: "Transactions",
      title: `Potential duplicate transaction${n !== 1 ? "s" : ""} found`,
      body: `${n} transaction${n !== 1 ? "s" : ""} may be duplicated — similar amount and date found in the same account. Review each pair and choose which to keep.`,
      action: { label: "Review Duplicates", color: "gold" },
      panelOnly: true,
    });
  }
  return rules;
}

export async function scheduleLocal(budget, month) {
  clearLocalTimers();
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  const fired = await firedSet();
  const now = Date.now();
  const horizon = now + 36 * 3600000;
  for (const r of collectReminders(budget, month)) {
    if (r.panelOnly) continue;
    const day = r.date || todayKey();
    const when = atTime(day, r.time || "09:00") + (r.offsetDays || 0) * 86400000;
    const key = `${r.id}:${day}`;
    if (fired.has(key)) continue;
    if (when < now - 60000) continue;
    if (when > horizon) continue;
    const delay = Math.max(0, when - now);
    const t = setTimeout(async () => {
      const again = await firedSet();
      if (again.has(key)) return;
      await showLocal(r.title, r.body, r.url, r.id);
      await markFired(key);
    }, Math.min(delay, 2 ** 31 - 1));
    timers.add(t);
  }
}

export async function requestPermission() {
  if (!("Notification" in window)) return "unsupported";
  if (Notification.permission === "granted") return "granted";
  if (Notification.permission === "denied") return "denied";
  return Notification.requestPermission();
}

export { timeZone };
