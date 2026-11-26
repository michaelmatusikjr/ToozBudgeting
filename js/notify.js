/** Local reminders while the app is open. Closed-app delivery is js/push.js. */
import { deviceGet, deviceSet } from "./store.js";
import { monthKey, todayKey, timeZone } from "./util.js";
import { overspentMonths, staleReconcile, ccMismatches, readyToAssign, getGoalMetrics, available } from "./calc.js";

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

  for (const { month: mk } of overspentMonths(budget).slice(0, 3)) {
    push({
      id: `overspend:${mk}`, kind: "overspend", title: "Overspending",
      body: `Cover overspending in ${mk}.`, url: `./#budget/${mk}`, tag: `overspend:${mk}`,
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
  for (const m of ccMismatches(budget, month || monthKey())) {
    push({
      id: `cc:${m.card.id}`, kind: "cc", title: m.card.name + " payment",
      body: "The payment category doesn’t cover the card balance.",
      url: `./#budget/${month || monthKey()}/${m.pay.id}`, tag: `cc:${m.card.id}`,
      date: today, recur: { type: "none" },
    });
  }
  for (const cat of budget.categories || []) {
    if (cat.archived || !cat.goal) continue;
    const avail = available(budget, cat.id, month || monthKey());
    const metrics = getGoalMetrics(cat, avail, (budget.monthlyBudgets?.[month || monthKey()] || {})[cat.id] || 0, month || monthKey());
    if (metrics?.type === "date" && (metrics.expired || (metrics.targetDate && metrics.targetDate <= nextMonthSafe(monthKey()) && !metrics.complete))) {
      push({
        id: `goal:${cat.id}`, kind: "goal", title: cat.name + " goal",
        body: metrics.expired ? "This date goal has passed." : "A goal deadline is getting close.",
        url: `./#budget/${month || monthKey()}/${cat.id}`, tag: `goal:${cat.id}`,
        date: today, recur: { type: "none" },
      });
    }
    if (cat.dueDay) {
      push({
        id: `bill:${cat.id}`, kind: "bill", title: cat.name + " due",
        body: `Due on day ${cat.dueDay}.`,
        url: `./#budget/${month || monthKey()}/${cat.id}`, tag: `bill:${cat.id}`,
        time: cat.reminderTime || "09:00",
        offsetDays: -(cat.leadDays || 0),
        recur: { type: "monthly", start: today },
      });
    }
  }
  for (const r of budget.reminders || []) push(r);
  return rules;
}

function nextMonthSafe(mk) {
  const [y, m] = mk.split("-").map(Number);
  const d = new Date(y, m, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
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
