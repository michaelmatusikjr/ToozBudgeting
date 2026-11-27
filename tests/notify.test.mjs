import { test } from "node:test";
import assert from "node:assert/strict";
import { collectReminders } from "../js/notify.js?v=154";

const month = "2026-11";
const budget = {
  accounts: [{ id: "chk", name: "Checking", lastReconciled: "2020-01-01" }],
  creditCards: [],
  categories: [{ id: "rent", name: "Rent", dueDay: 1, leadDays: 3, reminderTime: "08:00" }],
  transactions: [],
  reminders: [{ id: "custom-1", kind: "custom", title: "Custom ping", body: "hi", date: "2026-11-27" }],
  monthlyBudgets: {},
  inflows: {},
};

test("collectReminders never returns rta, bill, or custom reminders", () => {
  const rules = collectReminders(budget, month);
  assert.ok(!rules.some((r) => r.kind === "rta"));
  assert.ok(!rules.some((r) => r.kind === "bill"));
  assert.ok(!rules.some((r) => r.kind === "custom"));
  assert.ok(!rules.some((r) => r.id === "custom-1"));
  assert.ok(!rules.some((r) => String(r.id || "").startsWith("bill:")));
  assert.ok(!rules.some((r) => String(r.id || "").startsWith("rta:")));
});
