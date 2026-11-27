import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeBudget, placeGroup, placeCategory, moveGroup, moveCategory } from "../js/mutate.js?v=154";
import { importData, exportData, explode, assemble } from "../js/store.js?v=154";

function sample() {
  return normalizeBudget({
    id: "b1",
    name: "Test",
    categoryGroups: [
      { id: "g1", name: "A" },
      { id: "g2", name: "B" },
      { id: "g3", name: "C" },
    ],
    categories: [
      { id: "c1", name: "One", groupId: "g1" },
      { id: "c2", name: "Two", groupId: "g1" },
      { id: "c3", name: "Three", groupId: "g2" },
    ],
  });
}

test("normalizeBudget fills sort from array order when missing", () => {
  const b = sample();
  assert.deepEqual(b.categoryGroups.map((g) => [g.id, g.sort]), [["g1", 0], ["g2", 1], ["g3", 2]]);
  assert.deepEqual(b.categories.map((c) => [c.id, c.sort]), [["c1", 0], ["c2", 1], ["c3", 2]]);
});

test("moveGroup and placeGroup update sort", () => {
  let b = sample();
  b = moveGroup(b, "g1", 1);
  assert.deepEqual(b.categoryGroups.map((g) => g.id), ["g2", "g1", "g3"]);
  assert.deepEqual(b.categoryGroups.map((g) => g.sort), [0, 1, 2]);
  b = placeGroup(b, "g3", "g2");
  assert.deepEqual(b.categoryGroups.map((g) => g.id), ["g3", "g2", "g1"]);
});

test("placeCategory can move a category across groups", () => {
  let b = sample();
  b = placeCategory(b, "c3", "g1", "c1");
  const inA = b.categories.filter((c) => c.groupId === "g1").sort((a, c) => a.sort - c.sort);
  assert.deepEqual(inA.map((c) => c.id), ["c3", "c1", "c2"]);
  assert.equal(b.categories.find((c) => c.id === "c3").groupId, "g1");
});

test("order survives explode then assemble even if records arrive out of order", () => {
  let b = sample();
  b = placeGroup(b, "g3", "g1");
  b = placeCategory(b, "c3", "g1", "c1");
  const state = { sv: 1, setupComplete: true, activeBudgetId: "b1", users: [], budgets: [b] };
  const records = explode(state);
  const shuffled = new Map([...records.entries()].reverse());
  const again = assemble(shuffled);
  const b2 = again.budgets[0];
  assert.deepEqual(b2.categoryGroups.map((g) => g.id), b.categoryGroups.map((g) => g.id));
  assert.deepEqual(
    b2.categories.slice().sort((a, c) => a.sort - c.sort).map((c) => c.id),
    b.categories.slice().sort((a, c) => a.sort - c.sort).map((c) => c.id),
  );
  assert.equal(b2.categories.find((c) => c.id === "c3").groupId, "g1");
});

test("order survives export then import", () => {
  let b = sample();
  b = placeGroup(b, "g3", "g1");
  b = placeCategory(b, "c2", "g2", null);
  const state = { sv: 1, setupComplete: true, activeBudgetId: "b1", users: [], budgets: [b] };
  const again = importData(exportData(state));
  const b2 = again.budgets[0];
  assert.deepEqual(b2.categoryGroups.map((g) => g.id), ["g3", "g1", "g2"]);
  assert.equal(b2.categories.find((c) => c.id === "c2").groupId, "g2");
  const inG2 = b2.categories.filter((c) => c.groupId === "g2").sort((a, c) => a.sort - c.sort);
  assert.equal(inG2[inG2.length - 1].id, "c2");
});
