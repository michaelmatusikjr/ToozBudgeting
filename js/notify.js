/** Local reminders while the app is open. Closed-app delivery is js/push.js. */
import { deviceGet, deviceSet } from "./store.js?v=138";
import { monthKey, todayKey, timeZone, monthLabel, fmt } from "./util.js?v=138";
import { overspentMonths, staleReconcile, ccMismatches, readyToAssign } from "./calc.js?v=138";

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

/** Derived rules from the budget plus any custom reminders the user saved. */
export function collectReminders(budget, month) {
  if (!budget) return [];
  const today = todayKey();
  const rules = [];
  const push = (r) => rules.push({ time: "09:00", offsetDays: 0, ...r });

  const overs = overspentMonths(budget);
  if (overs.length) {
    const oldest = overs[0].month;
    const count = overs.length;
    const extra = count > 1 ? ` (+${count - 1} more)` : "";
    push({
      id: `overspend:${oldest}`, kind: "overspend",
      title: `Overspending in ${monthLabel(oldest)}${extra}`,
      body: `${count > 1 ? `${count} months have` : `${monthLabel(oldest)} has`} unresolved overspending. Covering moves funds from other categories to bring them back to zero. Start with the oldest month.`,
      url: `./#budget/${oldest}`, tag: `overspend:${oldest}`,
      date: today, recur: { type: "none" },
    });
  }
  for (const s of staleReconcile(budget)) {
    push({
      id: `recon:${s.id}`, kind: "reconcile", title: "Reconcile " + s.name,
      body: s.when ? `${s.name} hasn’t been reconciled since ${s.when}.` : `${s.name} has never been reconciled.`,
      url: `./#accounts/${s.id}`, tag: `recon:${s.id}`, date: today, recur: { type: "none" },
    });
  }
  const rta = readyToAssign(budget, monthKey());
  if (rta < 0.005) {
    push({
      id: `rta:${monthKey()}`, kind: "rta", title: "Ready to Assign is low",
      body: rta < -0.005 ? "Ready to Assign is negative. Move money before new spending." : "Ready to Assign is empty for this month.",
      url: "./#budget", tag: `rta:${monthKey()}`, date: today, recur: { type: "none" },
    });
  }
  for (const m of ccMismatches(budget, monthKey())) {
    push({
      id: `cc:${m.card.id}`, kind: "cc", title: `${m.card.name} payment is short`,
      body: `The card balance is ${fmt(m.owed)}, and ${fmt(Math.max(0, m.setAside))} is set aside. Assign ${fmt(m.short)} more to the payment category.`,
      url: `./#budget/${monthKey()}`, tag: `cc:${m.card.id}`,
      date: today, recur: { type: "none" },
    });
  }
  for (const tx of budget.transactions || []) {
    if (tx.type !== "payment" || tx.paymentLinkStatus !== "broken") continue;
    const cardSide = (budget.creditCards || []).some((c) => c.id === tx.accountId);
    const acct = cardSide
      ? (budget.creditCards || []).find((c) => c.id === tx.accountId)
      : (budget.accounts || []).find((a) => a.id === tx.accountId);
    const who = acct?.name || (cardSide ? "a card" : "a bank account");
    push({
      id: `payment:${tx.id}`, kind: "payment",
      title: `${fmt(Math.abs(tx.amount))} payment unmatched`,
      body: cardSide
        ? `A payment on ${tx.date} was recorded on ${who}, but the bank side is missing.`
        : `A payment on ${tx.date} from ${who} hasn’t been matched to the card.`,
      url: "./#transactions", tag: `payment:${tx.id}`,
      date: today, recur: { type: "none" },
    });
  }
  for (const cat of budget.categories || []) {
    if (cat.archived || !cat.dueDay) continue;
    push({
      id: `bill:${cat.id}`, kind: "bill", title: cat.name + " due",
      body: `Due on day ${cat.dueDay}.`,
      url: `./#budget/${month || monthKey()}/${cat.id}`, tag: `bill:${cat.id}`,
      time: cat.reminderTime || "09:00",
      offsetDays: -(cat.leadDays || 0),
      recur: { type: "monthly", start: today },
    });
  }
  for (const r of budget.reminders || []) push(r);
  return rules;
}

export async function scheduleLocal(budget, month) {
  clearLocalTimers();
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  const fired = await firedSet();
  const now = Date.now();
  const horizon = now + 36 * 3600000;
  for (const r of collectReminders(budget, month)) {
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
      await showLocal(r.title, r.body, r.url, r.tag);
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
