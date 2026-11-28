import { test } from "node:test";
import assert from "node:assert/strict";
import { expiredDateGoals, validateNewDateGoal, applyExpiredGoalResolutions } from "../js/mutate.js?v=154";

function budget(cats) {
  return { categories: cats, t: 1 };
}

const today = "2026-11";

test("expiredDateGoals lists only unarchived by-date goals past today", () => {
  const cats = [
    { id: "a", name: "Vacation", archived: false, goal: { type: "date", target: 3000, targetDate: "2026-10" } },
    { id: "b", name: "Future", archived: false, goal: { type: "date", target: 100, targetDate: "2026-12" } },
    { id: "c", name: "This month", archived: false, goal: { type: "date", target: 100, targetDate: "2026-11" } },
    { id: "d", name: "Monthly", archived: false, goal: { type: "monthly", target: 50 } },
    { id: "e", name: "Old archived", archived: true, goal: { type: "date", target: 10, targetDate: "2020-01" } },
    { id: "f", name: "No date", archived: false, goal: { type: "date", target: 10 } },
    { id: "g", name: "No goal", archived: false },
  ];
  const expired = expiredDateGoals(budget(cats), today);
  assert.deepEqual(expired.map((c) => c.id), ["a"]);
});

test("validateNewDateGoal requires a future date and a positive amount", () => {
  assert.equal(validateNewDateGoal({ date: "", amount: 100, todayMonth: today }), "Please select a target date.");
  assert.equal(validateNewDateGoal({ date: "2026-12", amount: 0, todayMonth: today }), "Please enter a target amount.");
  assert.equal(validateNewDateGoal({ date: "2026-12", amount: -5, todayMonth: today }), "Please enter a target amount.");
  assert.equal(validateNewDateGoal({ date: "2026-11", amount: 100, todayMonth: today }), "Target date must be in the future.");
  assert.equal(validateNewDateGoal({ date: "2026-10", amount: 100, todayMonth: today }), "Target date must be in the future.");
  assert.equal(validateNewDateGoal({ date: "2026-12", amount: 100, todayMonth: today }), "");
});

test("applyExpiredGoalResolutions removes a goal and sets rollover to rollover", () => {
  const start = budget([
    { id: "a", name: "Vacation", rollover: "return", goal: { type: "date", target: 3000, targetDate: "2026-10" } },
    { id: "b", name: "Keep", rollover: "max", goal: { type: "monthly", target: 50 } },
  ]);
  const next = applyExpiredGoalResolutions(start, { a: "remove" });
  const a = next.categories.find((c) => c.id === "a");
  const b = next.categories.find((c) => c.id === "b");
  assert.equal(a.goal, null);
  assert.equal(a.rollover, "rollover");
  assert.equal(b.goal.target, 50);
  assert.notEqual(next, start);
  assert.equal(start.categories[0].goal.target, 3000);
});

test("applyExpiredGoalResolutions writes a new by-date goal and leaves unresolved categories alone", () => {
  const start = budget([
    { id: "a", name: "Vacation", rollover: "rollover", goal: { type: "date", target: 3000, targetDate: "2026-10" } },
    { id: "b", name: "Other", rollover: "rollover", goal: { type: "date", target: 500, targetDate: "2026-09" } },
  ]);
  const next = applyExpiredGoalResolutions(start, { a: { date: "2027-06", amount: 2000 } });
  const a = next.categories.find((c) => c.id === "a");
  const b = next.categories.find((c) => c.id === "b");
  assert.deepEqual(a.goal, { type: "date", target: 2000, targetDate: "2027-06" });
  assert.deepEqual(b.goal, { type: "date", target: 500, targetDate: "2026-09" });
});
