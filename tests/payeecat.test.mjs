import { test } from "node:test";
import assert from "node:assert/strict";
import { payeeCategoryState, payeeDefaultCategory, payeeSuggestedCategory } from "../js/payees.js?v=154";

function budgetWith(payees) {
  return { payees, transactions: [], categories: [{ id: "groc", name: "Groceries" }, { id: "din", name: "Dining Out" }] };
}

test("when a payee has no default, the suggested category is shown", () => {
  const b = budgetWith([
    { name: "Whole Foods", canonicalName: "Whole Foods", defaultCategoryId: "", suggestedCategoryId: "groc" },
  ]);
  assert.equal(payeeDefaultCategory(b, "Whole Foods"), "");
  assert.equal(payeeSuggestedCategory(b, "Whole Foods"), "groc");
  const state = payeeCategoryState(b, "Whole Foods");
  assert.equal(state.mode, "suggested");
  assert.equal(state.catId, "groc");
});

test("a default category wins over a suggested one", () => {
  const b = budgetWith([
    { name: "Starbucks", canonicalName: "Starbucks", defaultCategoryId: "din", suggestedCategoryId: "groc" },
  ]);
  const state = payeeCategoryState(b, "Starbucks");
  assert.equal(state.mode, "default");
  assert.equal(state.catId, "din");
});

test("a payee with neither default nor suggested is none", () => {
  const b = budgetWith([
    { name: "Unknown Co", canonicalName: "Unknown Co", defaultCategoryId: "", suggestedCategoryId: "" },
  ]);
  const state = payeeCategoryState(b, "Unknown Co");
  assert.equal(state.mode, "none");
  assert.equal(state.catId, "");
});
