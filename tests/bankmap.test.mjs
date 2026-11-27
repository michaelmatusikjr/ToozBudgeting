import { test } from "node:test";
import assert from "node:assert/strict";
import { freshBudgetShell, addAccount, addCreditCard, addCategory, addTransaction, reconcileAccount, normalizeBudget, setPayeeCategory } from "../js/mutate.js?v=140";
import { accountBalances } from "../js/calc.js?v=140";
import {
  applyBankBatch, setBankLink, bankSettings, bankTxId, findBankTx, payeeFromPlaid, BANK_CUTOVER_DEFAULT, setBankSettings, rememberBankAccounts, statsLine, sumStats,
} from "../js/bankmap.js?v=140";

function fixture() {
  let b = normalizeBudget(freshBudgetShell("Test", "u1"));
  b = addAccount(b, { name: "USAA Checking", type: "checking", balance: 1000 });
  b = addAccount(b, { name: "USAA Savings", type: "savings", balance: 500 });
  b = addCreditCard(b, { name: "Chase Sapphire", balance: 0 });
  b = { ...b, categoryGroups: [{ id: "g1", name: "Everyday" }] };
  b = addCategory(b, { name: "Groceries", groupId: "g1" }).budget;
  b = addCategory(b, { name: "Dining Out", groupId: "g1" }).budget;
  // Pin starting balances to a fixed month so the test doesn't depend on today's date.
  b = { ...b, inflows: { "2026-11": 1500 }, transactions: b.transactions.map((t) => ({ ...t, date: "2026-11-01" })) };
  const chk = b.accounts[0].id; const sav = b.accounts[1].id; const card = b.creditCards[0].id;
  b = setBankLink(b, "p-chk", chk, { itemId: "item-usaa", institution: "USAA" });
  b = setBankLink(b, "p-sav", sav, { itemId: "item-usaa", institution: "USAA" });
  b = setBankLink(b, "p-card", card, { itemId: "item-chase", institution: "Chase" });
  return { b, chk, sav, card, cat: (n) => b.categories.find((c) => c.name === n).id };
}

const T = (id, account_id, amount, extra = {}) => ({
  transaction_id: id, account_id, amount, date: "2026-11-28", name: "SHOP", merchant_name: null, pending: false, pending_transaction_id: null,
  pfc: { primary: "GENERAL_MERCHANDISE", detailed: "GENERAL_MERCHANDISE_OTHER" }, ...extra,
});
const batch = (parts) => ({ v: 1, itemId: "item-usaa", institution: "USAA", accounts: [], added: [], modified: [], removed: [], ...parts });
const tx = (b, plaidId) => findBankTx(b, plaidId);

test("defaults: cutover 2026-11-27, posted only", () => {
  const { b } = fixture();
  assert.equal(BANK_CUTOVER_DEFAULT, "2026-11-27");
  assert.equal(bankSettings(b).cutover, "2026-11-27");
  assert.equal(bankSettings(b).includePending, false);
});

test("a purchase on checking becomes an expense with a plaid- id", () => {
  const { b, chk } = fixture();
  const r = applyBankBatch(b, batch({ added: [T("a1", "p-chk", 42.1, { merchant_name: "KROGER" })] }));
  const t = tx(r.budget, "a1");
  assert.equal(t.id, bankTxId("a1"));
  assert.equal(t.id, "plaid-a1");
  assert.equal(t.type, "expense");
  assert.equal(t.amount, 42.1);
  assert.equal(t.accountId, chk);
  assert.equal(t.payee, "Kroger");
  assert.equal(r.stats.added, 1);
  assert.equal(accountBalances(r.budget)[chk], 1000 - 42.1);
});

test("deposits go to Ready to Assign; refunds go back to a category", () => {
  const { b, chk } = fixture();
  const r = applyBankBatch(b, batch({ added: [
    T("in1", "p-chk", -2500, { name: "PAYROLL ACME", pfc: { primary: "INCOME", detailed: "INCOME_WAGES" } }),
    T("rf1", "p-chk", -19.99, { merchant_name: "Target", pfc: { primary: "GENERAL_MERCHANDISE", detailed: "GENERAL_MERCHANDISE_SUPERSTORES" } }),
  ] }));
  assert.equal(tx(r.budget, "in1").type, "income");
  assert.equal(tx(r.budget, "in1").amount, 2500);
  assert.equal(r.budget.inflows["2026-11"], 1000 + 500 + 2500);
  const rf = tx(r.budget, "rf1");
  assert.equal(rf.type, "expense");
  assert.equal(rf.amount, -19.99);
  assert.ok(!rf.categoryId || rf.categoryConfirmed === false, "never auto-confirmed");
  assert.equal(accountBalances(r.budget)[chk], 1000 + 2500 + 19.99);
});

test("card charges and card refunds", () => {
  const { b, card, cat } = fixture();
  const r = applyBankBatch(b, batch({ itemId: "item-chase", added: [
    T("c1", "p-card", 60, { merchant_name: "Chipotle", pfc: { primary: "FOOD_AND_DRINK", detailed: "FOOD_AND_DRINK_FAST_FOOD" } }),
    T("c2", "p-card", -15, { merchant_name: "Amazon", pfc: { primary: "GENERAL_MERCHANDISE", detailed: "GENERAL_MERCHANDISE_ONLINE_MARKETPLACES" } }),
  ] }));
  const c1 = tx(r.budget, "c1");
  assert.equal(c1.type, "expense");
  assert.equal(c1.accountId, card);
  assert.equal(c1.categoryId, cat("Dining Out"), "Plaid category suggests a matching budget category");
  assert.equal(c1.categoryConfirmed, false, "a guess is marked for review");
  const c2 = tx(r.budget, "c2");
  assert.equal(c2.amount, -15);
  assert.equal(accountBalances(r.budget)[card], 45, "card owes 60 - 15");
});

test("a payee's default category is used and confirmed", () => {
  let { b, chk, cat } = fixture();
  b = addTransaction(b, { date: "2026-11-01", payee: "Kroger", amount: 10, accountId: chk, categoryId: cat("Groceries") }).budget;
  b = setPayeeCategory(b, "Kroger", cat("Groceries"), "default");
  const r = applyBankBatch(b, batch({ added: [T("k1", "p-chk", 33, { merchant_name: "Kroger" })] }));
  assert.equal(tx(r.budget, "k1").categoryId, cat("Groceries"));
  assert.equal(tx(r.budget, "k1").categoryConfirmed, true);
});

test("a card payment links both sides through Pay", () => {
  const { b, chk, card } = fixture();
  let r = applyBankBatch(b, batch({ added: [T("bp1", "p-chk", 145.43, { name: "CHASE CREDIT CRD AUTOPAY", pfc: { primary: "LOAN_PAYMENTS", detailed: "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT" } })] }));
  const bankSide = tx(r.budget, "bp1");
  assert.equal(bankSide.type, "payment");
  assert.equal(bankSide.accountId, chk);
  r = applyBankBatch(r.budget, batch({ itemId: "item-chase", added: [T("cp1", "p-card", -145.43, { date: "2026-11-29", name: "Payment Thank You-Mobile", pfc: { primary: "LOAN_PAYMENTS", detailed: "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT" } })] }));
  const cardSide = tx(r.budget, "cp1");
  assert.equal(cardSide.type, "payment");
  assert.equal(cardSide.accountId, card);
  assert.equal(cardSide.paymentFromAccountId, chk);
  assert.equal(cardSide.paymentLinkStatus, "linked");
  assert.equal(tx(r.budget, "bp1").paymentLinkStatus, "linked");
});

test("a transfer between two mapped bank accounts becomes one transfer", () => {
  const { b, chk, sav } = fixture();
  const r = applyBankBatch(b, batch({ added: [
    T("to1", "p-chk", 200, { name: "Transfer to savings", pfc: { primary: "TRANSFER_OUT", detailed: "TRANSFER_OUT_ACCOUNT_TRANSFER" } }),
    T("ti1", "p-sav", -200, { name: "Transfer from checking", pfc: { primary: "TRANSFER_IN", detailed: "TRANSFER_IN_ACCOUNT_TRANSFER" } }),
  ] }));
  const out = tx(r.budget, "to1"); const inn = tx(r.budget, "ti1");
  assert.equal(out.type, "transfer");
  assert.equal(inn.type, "transfer");
  assert.equal(out.transferLinkId, inn.transferLinkId);
  assert.equal(out.accountId, chk);
  assert.equal(inn.accountId, sav);
  assert.equal(r.stats.transfers, 1);
  assert.equal(r.budget.inflows["2026-11"], 1500, "a transfer is not income");
});

test("a transfer that arrives in two syncs is joined up", () => {
  const { b } = fixture();
  let r = applyBankBatch(b, batch({ added: [T("ti2", "p-sav", -50, { pfc: { primary: "TRANSFER_IN", detailed: "TRANSFER_IN_ACCOUNT_TRANSFER" } })] }));
  assert.equal(tx(r.budget, "ti2").type, "income");
  r = applyBankBatch(r.budget, batch({ added: [T("to2", "p-chk", 50, { pfc: { primary: "TRANSFER_OUT", detailed: "TRANSFER_OUT_ACCOUNT_TRANSFER" } })] }));
  assert.equal(tx(r.budget, "to2").type, "transfer");
  assert.equal(tx(r.budget, "ti2").type, "transfer");
  assert.equal(r.budget.inflows["2026-11"], 1500);
});

test("dedup: the same bank id never imports twice, across batches", () => {
  const { b } = fixture();
  const one = T("d1", "p-chk", 5);
  let r = applyBankBatch(b, batch({ added: [one] }));
  r = applyBankBatch(r.budget, batch({ added: [one] }));
  assert.equal(r.budget.transactions.filter((t) => t.bankId === "d1").length, 1);
  assert.equal(r.stats.added, 0);
});

test("dedup: a hand-entered transaction is matched instead of doubled", () => {
  let { b, chk, cat } = fixture();
  b = addTransaction(b, { date: "2026-11-27", payee: "Grocery run", amount: 88.5, accountId: chk, categoryId: cat("Groceries") }).budget;
  const r = applyBankBatch(b, batch({ added: [T("m1", "p-chk", 88.5, { merchant_name: "Kroger" })] }));
  assert.equal(r.stats.matched, 1);
  assert.equal(r.stats.added, 0);
  const t = tx(r.budget, "m1");
  assert.equal(t.payee, "Grocery Run", "the user's entry is kept");
  assert.equal(t.categoryId, cat("Groceries"));
  assert.equal(r.budget.transactions.filter((x) => x.accountId === chk && x.subtype !== "starting_balance").length, 1);
});

test("cutover and pending are respected", () => {
  const { b } = fixture();
  const r = applyBankBatch(b, batch({ added: [
    T("old", "p-chk", 9, { date: "2026-11-20" }),
    T("pend", "p-chk", 9, { pending: true }),
    T("ok", "p-chk", 9, { date: "2026-11-27" }),
  ] }));
  assert.equal(r.stats.old, 1);
  assert.equal(r.stats.pending, 1);
  assert.equal(r.stats.added, 1);
  assert.ok(!tx(r.budget, "old"));
  assert.ok(!tx(r.budget, "pend"));
  const r2 = applyBankBatch(setBankSettings(b, { includePending: true }), batch({ added: [T("pend", "p-chk", 9, { pending: true })] }));
  assert.equal(tx(r2.budget, "pend").bankPending, true);
});

test("pending then posted keeps the user's category and doesn't double", () => {
  const { b, cat } = fixture();
  const withPending = setBankSettings(b, { includePending: true });
  let r = applyBankBatch(withPending, batch({ added: [T("p1", "p-chk", 30, { pending: true, merchant_name: "Shell" })] }));
  const pid = tx(r.budget, "p1").id;
  r.budget = { ...r.budget, transactions: r.budget.transactions.map((t) => t.id === pid ? { ...t, categoryId: cat("Groceries"), categoryConfirmed: true } : t) };
  r = applyBankBatch(r.budget, batch({ added: [T("posted1", "p-chk", 31.25, { merchant_name: "Shell", pending_transaction_id: "p1" })], removed: [{ transaction_id: "p1", account_id: "p-chk" }] }));
  const posted = tx(r.budget, "posted1");
  assert.ok(posted);
  assert.equal(posted.amount, 31.25);
  assert.equal(posted.categoryId, cat("Groceries"));
  assert.equal(posted.bankPending, false);
  assert.ok(!tx(r.budget, "p1"));
  assert.equal(r.budget.transactions.filter((t) => t.bankId).length, 1);
});

test("modified updates amount and date; removed deletes", () => {
  const { b } = fixture();
  let r = applyBankBatch(b, batch({ added: [T("x1", "p-chk", 10), T("x2", "p-chk", 20)] }));
  r = applyBankBatch(r.budget, batch({ modified: [T("x1", "p-chk", 12, { date: "2026-11-29" })], removed: [{ transaction_id: "x2", account_id: "p-chk" }] }));
  assert.equal(tx(r.budget, "x1").amount, 12);
  assert.equal(tx(r.budget, "x1").date, "2026-11-29");
  assert.ok(!tx(r.budget, "x2"));
  assert.equal(r.stats.updated, 1);
  assert.equal(r.stats.removed, 1);
});

test("reconciled transactions are never changed or removed", () => {
  const { b, chk } = fixture();
  let r = applyBankBatch(b, batch({ added: [T("l1", "p-chk", 10), T("l2", "p-chk", 20)] }));
  let locked = reconcileAccount(r.budget, chk, "2026-11-30", 0, [bankTxId("l1"), bankTxId("l2")]);
  r = applyBankBatch(locked, batch({ modified: [T("l1", "p-chk", 99)], removed: [{ transaction_id: "l2", account_id: "p-chk" }] }));
  assert.equal(tx(r.budget, "l1").amount, 10);
  assert.ok(tx(r.budget, "l2"));
  assert.equal(r.stats.locked, 2);
});

test("unmapped accounts are held, skipped accounts are dropped", () => {
  let { b } = fixture();
  b = setBankLink(b, "p-sav", "skip");
  const r = applyBankBatch(b, batch({
    accounts: [{ account_id: "p-new", name: "Kids Checking", mask: "1111", type: "depository", subtype: "checking" }],
    added: [T("h1", "p-new", 5), T("s1", "p-sav", 5)],
  }));
  assert.equal(r.stats.held, 1);
  assert.equal(r.stats.skipped, 1);
  assert.equal(r.held.added[0].transaction_id, "h1");
  assert.equal(bankSettings(r.budget).accounts["p-new"].name, "Kids Checking");
  assert.equal(bankSettings(r.budget).accounts["p-new"].target, "");
  const mapped = setBankLink(r.budget, "p-new", r.budget.accounts[0].id);
  const again = applyBankBatch(mapped, r.held);
  assert.equal(again.stats.added, 1);
  assert.ok(tx(again.budget, "h1"));
});

test("rememberBankAccounts keeps choices", () => {
  const { b, chk } = fixture();
  const n = rememberBankAccounts(b, "item-usaa", "USAA", [{ account_id: "p-chk", name: "Renamed", mask: "3769" }]);
  assert.equal(bankSettings(n).accounts["p-chk"].target, chk);
  assert.equal(bankSettings(n).accounts["p-chk"].name, "Renamed");
});

test("payee clean-up and stats text", () => {
  assert.equal(payeeFromPlaid({ name: "AMAZON MKTPL*2K3" }), "Amazon Mktpl*2k3");
  assert.equal(payeeFromPlaid({ merchant_name: "Starbucks", name: "SBUX 123" }), "Starbucks");
  assert.equal(statsLine(sumStats([{ added: 2 }, { added: 1, removed: 1 }])), "3 new, 1 removed");
});

test("bankLinks survive normalize (store round trip)", () => {
  const { b } = fixture();
  const n = normalizeBudget(JSON.parse(JSON.stringify(b)));
  assert.deepEqual(n.bankLinks, b.bankLinks);
});
