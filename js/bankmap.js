/**
 * Bank sync mapping. Turns Plaid transactions from the bank Worker into budget transactions.
 * Pure functions: a budget in, a new budget out. No DOM, no network.
 *
 * Plaid amounts are positive when money leaves the account (a purchase, or a charge on a card)
 * and negative when money comes in (a deposit, a refund, or a payment to a card).
 */
import { toTitleCase, isCard, isBank, ccPayCat, makePayFrom, RTA, dateDiffDays, round2 } from "./util.js?v=153";
import { addTransaction, updateTransaction, deleteTransactions, isLocked, touch } from "./mutate.js?v=153";
import { displayName, payeeDefaultCategory, payeeSuggestedCategory } from "./payees.js?v=153";

export const BANK_CUTOVER_DEFAULT = "2026-11-27";
export const bankTxId = (plaidId) => "plaid-" + plaidId;

/** The budget's bank settings with defaults filled in. */
export function bankSettings(budget) {
  const b = budget?.bankLinks || {};
  return {
    accounts: b.accounts || {},
    cutover: /^\d{4}-\d{2}-\d{2}$/.test(b.cutover || "") ? b.cutover : BANK_CUTOVER_DEFAULT,
    includePending: !!b.includePending,
  };
}

export function setBankSettings(budget, patch) {
  const cur = bankSettings(budget);
  return touch(budget, { bankLinks: { ...cur, ...patch } });
}

/** Point a bank account at an app account or card id, or "skip", or "" to decide later. */
export function setBankLink(budget, plaidAccountId, target, info = {}) {
  const cur = bankSettings(budget);
  const prev = cur.accounts[plaidAccountId] || {};
  return setBankSettings(budget, { accounts: { ...cur.accounts, [plaidAccountId]: { ...prev, ...info, target: target || "" } } });
}

/** Record accounts a batch or the server reported, without touching choices already made. */
export function rememberBankAccounts(budget, itemId, institution, accounts) {
  const cur = bankSettings(budget);
  let changed = false;
  const next = { ...cur.accounts };
  for (const a of accounts || []) {
    const id = a.account_id || a.id;
    if (!id) continue;
    const prev = next[id];
    const info = { itemId, institution: institution || prev?.institution || "", name: a.name || prev?.name || "", mask: a.mask || prev?.mask || "", type: a.type || prev?.type || "", subtype: a.subtype || prev?.subtype || "" };
    if (!prev) { next[id] = { ...info, target: "" }; changed = true; continue; }
    if (Object.keys(info).some((k) => (prev[k] || "") !== (info[k] || ""))) { next[id] = { ...prev, ...info }; changed = true; }
  }
  return changed ? setBankSettings(budget, { accounts: next }) : budget;
}

/** A target is usable when it names an open account or card in this budget. */
export function linkTarget(budget, plaidAccountId) {
  const link = bankSettings(budget).accounts[plaidAccountId];
  if (!link || !link.target) return { state: "unmapped" };
  if (link.target === "skip") return { state: "skip" };
  const acct = [...(budget.accounts || []), ...(budget.creditCards || [])].find((a) => a.id === link.target && !a.archived);
  if (!acct) return { state: "unmapped" };
  return { state: "ok", id: acct.id, card: isCard(budget, acct.id) };
}

export const findBankTx = (budget, plaidId) => (budget.transactions || []).find((t) => t.bankId === plaidId);

/** Plaid names often arrive in capitals. Make them read like the rest of the payee list. */
export function payeeFromPlaid(t) {
  let s = String(t.merchant_name || t.name || "").replace(/\s+/g, " ").trim();
  if (!s) return "Bank Transaction";
  if (s === s.toUpperCase() && /[A-Z]/.test(s)) s = s.toLowerCase();
  return toTitleCase(s).slice(0, 80);
}

const PAYMENT_WORDS = /\b(autopay|auto pay|payment|pymt|pmt|epay|e-pay|crd|credit card|card services|thank you)\b/i;

export function looksLikeCardPayment(t) {
  if (t.pfc?.detailed === "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT") return true;
  return PAYMENT_WORDS.test(String(t.name || "")) && (!t.pfc || ["LOAN_PAYMENTS", "TRANSFER_OUT", "TRANSFER_IN"].includes(t.pfc.primary));
}

const isTransferPfc = (t) => t.pfc?.primary === "TRANSFER_OUT" || t.pfc?.primary === "TRANSFER_IN";
const NOT_SPENDING = new Set(["INCOME", "TRANSFER_IN", "TRANSFER_OUT", "LOAN_PAYMENTS"]);

/** Rough Plaid category to budget category name hints. Only ever a suggestion to confirm. */
const PFC_HINTS = [
  [/^FOOD_AND_DRINK_GROCERIES/, /grocer/i],
  [/^FOOD_AND_DRINK_(COFFEE|FAST_FOOD|RESTAURANT|OTHER)/, /dining|restaurant|eating out|food out|take ?out|fast food|coffee/i],
  [/^TRANSPORTATION_GAS/, /\bgas\b|fuel/i],
  [/^RENT_AND_UTILITIES_GAS_AND_ELECTRICITY/, /electric|power|utilit/i],
  [/^RENT_AND_UTILITIES_WATER/, /water|utilit/i],
  [/^RENT_AND_UTILITIES_INTERNET_AND_CABLE/, /internet|cable|wifi/i],
  [/^RENT_AND_UTILITIES_TELEPHONE/, /phone|cell|mobile/i],
  [/^RENT_AND_UTILITIES_RENT/, /\brent\b/i],
  [/^LOAN_PAYMENTS_MORTGAGE_PAYMENT/, /mortgage/i],
  [/^LOAN_PAYMENTS_CAR_PAYMENT/, /car payment|auto loan|car loan|vehicle/i],
  [/^GENERAL_SERVICES_INSURANCE/, /insurance/i],
  [/^MEDICAL/, /medical|health|doctor|pharmac/i],
  [/^PERSONAL_CARE/, /personal care|hair|beauty/i],
  [/^ENTERTAINMENT/, /entertain|fun|streaming|subscriptions?/i],
  [/^TRAVEL/, /travel|vacation/i],
  [/^GENERAL_MERCHANDISE/, /shopping|household|stuff/i],
  [/^HOME_IMPROVEMENT/, /home (maint|improv|repair)|household/i],
];

export function pfcCategory(budget, pfc) {
  const code = pfc?.detailed || pfc?.primary || "";
  if (!code) return "";
  const cats = (budget.categories || []).filter((c) => !c.archived && !c.creditCardId);
  for (const [codeRe, nameRe] of PFC_HINTS) {
    if (!codeRe.test(code)) continue;
    const hit = cats.find((c) => nameRe.test(c.name));
    if (hit) return hit.id;
  }
  return "";
}

/** A remembered payee category wins. Anything guessed is left unconfirmed so it shows for review. */
export function suggestCategory(budget, named, t) {
  const shown = displayName(budget, named);
  const def = payeeDefaultCategory(budget, shown) || payeeDefaultCategory(budget, named);
  if (def) return { categoryId: def, confirmed: true };
  const sug = payeeSuggestedCategory(budget, shown) || payeeSuggestedCategory(budget, named);
  if (sug) return { categoryId: sug, confirmed: false };
  const byPfc = pfcCategory(budget, t.pfc);
  return { categoryId: byPfc, confirmed: false };
}

/** +1 when an app transaction moved money the way a positive Plaid amount does. */
function plaidSign(budget, tx) {
  const card = isCard(budget, tx.accountId);
  const s = Math.sign(Number(tx.amount) || 0);
  switch (tx.type) {
    case "expense": return s;
    case "income": return -1;
    case "payment": return card ? -1 : 1;
    case "transfer": return card ? s : -s;
    default: return 0;
  }
}

/** A hand-entered transaction that is clearly this bank one: same account, amount, direction, within 3 days. */
function findManualMatch(budget, accountId, t, claimed) {
  const amt = Math.abs(t.amount);
  const dir = Math.sign(t.amount);
  let best = null;
  for (const tx of budget.transactions || []) {
    if (tx.bankId || claimed.has(tx.id) || tx.accountId !== accountId) continue;
    if (tx.subtype === "starting_balance" || tx.type === "adjustment") continue;
    if (Math.abs(Math.abs(Number(tx.amount)) - amt) > 0.005) continue;
    if (plaidSign(budget, tx) !== dir) continue;
    const gap = dateDiffDays(tx.date, t.date);
    if (gap > 3) continue;
    if (!best || gap < best.gap) best = { tx, gap };
  }
  return best?.tx || null;
}

/** Find which card a bank-side payment went to. */
function resolveCard(budget, t, batchCardSide) {
  const amt = Math.abs(t.amount);
  const near = (d) => dateDiffDays(d, t.date) <= 5;
  const open = (budget.creditCards || []).filter((c) => !c.archived);
  const fromBatch = batchCardSide.filter((x) => Math.abs(Math.abs(x.t.amount) - amt) < 0.005 && near(x.t.date));
  if (fromBatch.length === 1) return fromBatch[0].cardId;
  const ccSide = (budget.transactions || []).filter((x) => x.type === "payment" && !x.categoryId && isCard(budget, x.accountId)
    && x.paymentLinkStatus !== "linked" && Math.abs(Math.abs(x.amount) - amt) < 0.005 && near(x.date));
  if (ccSide.length === 1) return ccSide[0].accountId;
  const name = String(t.name || "").toLowerCase();
  const links = bankSettings(budget).accounts;
  const byName = open.filter((c) => {
    const words = String(c.name || "").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !["card", "visa", "credit", "the", "rewards", "mastercard"].includes(w));
    if (words.some((w) => name.includes(w))) return true;
    const inst = Object.values(links).find((l) => l.target === c.id)?.institution;
    return !!inst && name.includes(String(inst).toLowerCase().split(/\s+/)[0]);
  });
  if (byName.length === 1) return byName[0].id;
  if (open.length === 1) return open[0].id;
  return null;
}

/** For a payment seen on the card, guess which bank account paid it. */
function resolvePayFrom(budget, cardId, t) {
  const amt = Math.abs(t.amount);
  const cat = ccPayCat(budget, cardId);
  const hit = (budget.transactions || []).find((x) => x.type === "payment" && x.categoryId && x.categoryId === cat?.id
    && isBank(budget, x.accountId) && Math.abs(Math.abs(x.amount) - amt) < 0.005 && dateDiffDays(x.date, t.date) <= 5);
  return hit?.accountId || "";
}

function annotate(budget, ids, fields) {
  const set = new Set(ids);
  return { ...budget, transactions: (budget.transactions || []).map((tx) => set.has(tx.id) ? { ...tx, ...fields(tx) } : tx) };
}

const bankFields = (t) => () => ({
  bankId: t.transaction_id,
  bankAccountId: t.account_id,
  bankPending: !!t.pending,
  bankName: payeeFromPlaid(t),
  bankPfc: t.pfc?.primary || null,
});

/** Build the addTransaction form for one Plaid transaction. */
export function formFor(budget, target, t, batchCardSide = []) {
  const named = payeeFromPlaid(t);
  const amount = round2(Math.abs(t.amount));
  const base = { id: bankTxId(t.transaction_id), date: t.date, payee: named, amount, accountId: target.id };
  if (target.card) {
    if (t.amount > 0) {
      const s = suggestCategory(budget, named, t);
      return { ...base, type: "expense", categoryId: s.categoryId, categoryConfirmed: s.confirmed };
    }
    if (looksLikeCardPayment(t) || t.pfc?.primary === "TRANSFER_IN") {
      return { ...base, categoryId: makePayFrom(resolvePayFrom(budget, target.id, t)) };
    }
    const s = suggestCategory(budget, named, t);
    return { ...base, type: "expense", isRefund: true, categoryId: s.categoryId, categoryConfirmed: false };
  }
  if (t.amount > 0) {
    if (looksLikeCardPayment(t)) {
      const cardId = resolveCard(budget, t, batchCardSide);
      const cat = cardId ? ccPayCat(budget, cardId) : null;
      if (cat) return { ...base, categoryId: cat.id };
    }
    const s = suggestCategory(budget, named, t);
    return { ...base, type: "expense", categoryId: s.categoryId, categoryConfirmed: s.confirmed };
  }
  if (t.pfc && !NOT_SPENDING.has(t.pfc.primary)) {
    const s = suggestCategory(budget, named, t);
    return { ...base, type: "expense", isRefund: true, categoryId: s.categoryId, categoryConfirmed: false };
  }
  return { ...base, type: "income", categoryId: RTA };
}

/** Amount for an existing app transaction after the bank changed it. */
function amountFor(tx, t) {
  if (tx.type === "expense") return round2(t.amount);
  return round2(Math.abs(t.amount));
}

const emptyStats = () => ({ added: 0, matched: 0, updated: 0, removed: 0, locked: 0, old: 0, pending: 0, skipped: 0, held: 0, transfers: 0 });

/**
 * Apply one decrypted batch from the bank Worker.
 * Returns { budget, stats, held } where held is a batch of transactions whose bank account isn't mapped yet.
 */
export function applyBankBatch(budget, batch, opts = {}) {
  const settings = bankSettings(budget);
  const cutover = opts.cutover || settings.cutover;
  const includePending = opts.includePending ?? settings.includePending;
  const stats = emptyStats();
  const held = { v: 1, itemId: batch.itemId, institution: batch.institution, accounts: batch.accounts || [], added: [], modified: [], removed: [] };
  let b = rememberBankAccounts(budget, batch.itemId, batch.institution, batch.accounts);
  const claimed = new Set();

  const added = [...(batch.added || [])];
  const modified = [];
  for (const t of batch.modified || []) {
    if (findBankTx(b, t.transaction_id)) modified.push(t);
    else added.push(t);
  }
  added.sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0));

  // Decide what each added transaction is allowed to become before creating anything.
  const ready = [];
  for (const t of added) {
    const target = linkTarget(b, t.account_id);
    if (target.state === "unmapped") { held.added.push(t); stats.held++; continue; }
    if (target.state === "skip") { stats.skipped++; continue; }
    if (t.pending && !includePending) { stats.pending++; continue; }
    if (t.date < cutover) { stats.old++; continue; }
    if (findBankTx(b, t.transaction_id)) { stats.skipped++; continue; }
    ready.push({ t, target });
  }

  // A posted transaction replaces the pending one it came from, keeping any category already chosen.
  const rest = [];
  for (const r of ready) {
    const prev = r.t.pending_transaction_id ? findBankTx(b, r.t.pending_transaction_id) : null;
    if (!prev) { rest.push(r); continue; }
    if (isLocked(b, prev)) {
      b = annotate(b, [prev.id], bankFields(r.t));
      stats.locked++;
      continue;
    }
    b = updateTransaction(b, prev.id, { date: r.t.date, amount: amountFor(prev, r.t) });
    b = annotate(b, [prev.id], bankFields(r.t));
    stats.updated++;
  }

  // Transfers between two mapped bank accounts in this batch become one app transfer.
  const used = new Set();
  const outs = rest.filter((r) => !r.target.card && isTransferPfc(r.t) && r.t.amount > 0);
  for (const o of outs) {
    const i = rest.find((r) => !used.has(r) && r !== o && !r.target.card && isTransferPfc(r.t) && r.t.amount < 0
      && r.target.id !== o.target.id && Math.abs(Math.abs(r.t.amount) - o.t.amount) < 0.005 && dateDiffDays(r.t.date, o.t.date) <= 3);
    if (!i || used.has(o)) continue;
    const res = addTransaction(b, {
      type: "transfer", id: bankTxId(o.t.transaction_id), partnerId: bankTxId(i.t.transaction_id),
      accountId: o.target.id, transferAccountId: i.target.id, amount: Math.abs(o.t.amount), date: o.t.date, payee: "Transfer",
    });
    if (res.error) continue;
    b = annotate(res.budget, [bankTxId(o.t.transaction_id)], bankFields(o.t));
    b = annotate(b, [bankTxId(i.t.transaction_id)], bankFields(i.t));
    used.add(o); used.add(i);
    stats.added += 2; stats.transfers++;
  }

  const cardSide = rest.filter((r) => r.target.card && r.t.amount < 0).map((r) => ({ t: r.t, cardId: r.target.id }));
  for (const r of rest) {
    if (used.has(r)) continue;
    const { t, target } = r;
    const manual = findManualMatch(b, target.id, t, claimed);
    if (manual) {
      claimed.add(manual.id);
      b = annotate(b, [manual.id], bankFields(t));
      stats.matched++;
      continue;
    }
    if (!target.card && isTransferPfc(t)) {
      const partner = transferPartner(b, target.id, t);
      if (partner) {
        const out = t.amount > 0 ? { id: bankTxId(t.transaction_id), acct: target.id, t } : { id: partner.id, acct: partner.accountId, t: null };
        const inn = t.amount > 0 ? { id: partner.id, acct: partner.accountId, t: null } : { id: bankTxId(t.transaction_id), acct: target.id, t };
        const partnerFields = { bankId: partner.bankId, bankAccountId: partner.bankAccountId, bankPending: partner.bankPending, bankName: partner.bankName, bankPfc: partner.bankPfc };
        const cleared = deleteTransactions(b, [partner.id]);
        const res = addTransaction(cleared, {
          type: "transfer", id: out.id, partnerId: inn.id, accountId: out.acct, transferAccountId: inn.acct,
          amount: Math.abs(t.amount), date: t.amount > 0 ? t.date : partner.date, payee: "Transfer",
        });
        if (!res.error) {
          b = annotate(res.budget, [bankTxId(t.transaction_id)], bankFields(t));
          b = annotate(b, [partner.id], () => partnerFields);
          stats.added++; stats.transfers++;
          continue;
        }
      }
    }
    const res = addTransaction(b, formFor(b, target, t, cardSide));
    if (res.error) { stats.skipped++; continue; }
    b = annotate(res.budget, [bankTxId(t.transaction_id)], bankFields(t));
    stats.added++;
  }

  for (const t of modified) {
    const tx = findBankTx(b, t.transaction_id);
    if (!tx) continue;
    if (isLocked(b, tx)) { stats.locked++; continue; }
    if (tx.type === "transfer") { stats.skipped++; continue; }
    if (t.pending && !includePending && !tx.bankPending) { stats.skipped++; continue; }
    const patch = { date: t.date, amount: amountFor(tx, t) };
    const fresh = payeeFromPlaid(t);
    if (tx.originalPayee === tx.bankName && tx.payee === tx.bankName && fresh !== tx.bankName) patch.payee = fresh;
    b = updateTransaction(b, tx.id, patch);
    b = annotate(b, [tx.id], bankFields(t));
    stats.updated++;
  }

  const toRemove = [];
  for (const r of batch.removed || []) {
    const tx = findBankTx(b, r.transaction_id);
    if (!tx) {
      if (r.account_id && linkTarget(b, r.account_id).state === "unmapped") { held.removed.push(r); stats.held++; }
      continue;
    }
    if (isLocked(b, tx)) { stats.locked++; continue; }
    if (tx.type === "transfer") {
      b = annotate(b, [tx.id], () => ({ bankId: null }));
      stats.skipped++;
      continue;
    }
    toRemove.push(tx.id);
  }
  if (toRemove.length) {
    const before = (b.transactions || []).length;
    b = deleteTransactions(b, toRemove);
    stats.removed += before - (b.transactions || []).length;
  }

  if (b !== budget) b = touch(b, {});
  return { budget: b, stats, held: held.added.length || held.removed.length ? held : null };
}

/** An earlier bank transfer on another of the user's bank accounts that this one completes. */
function transferPartner(budget, accountId, t) {
  const amt = Math.abs(t.amount);
  const wantType = t.amount > 0 ? "income" : "expense";
  return (budget.transactions || []).find((x) => x.bankId && x.accountId !== accountId && isBank(budget, x.accountId)
    && (x.bankPfc === "TRANSFER_OUT" || x.bankPfc === "TRANSFER_IN") && x.type === wantType
    && Math.abs(Math.abs(x.amount) - amt) < 0.005 && dateDiffDays(x.date, t.date) <= 3 && !isLocked(budget, x)) || null;
}

/** Add up stats from several batches. */
export function sumStats(list) {
  const out = emptyStats();
  for (const s of list) for (const k of Object.keys(out)) out[k] += s?.[k] || 0;
  return out;
}

export function statsLine(s) {
  const parts = [];
  if (s.added) parts.push(`${s.added} new`);
  if (s.updated) parts.push(`${s.updated} updated`);
  if (s.removed) parts.push(`${s.removed} removed`);
  if (s.matched) parts.push(`${s.matched} matched to ones you entered`);
  if (s.locked) parts.push(`${s.locked} left alone because they’re reconciled`);
  if (s.held) parts.push(`${s.held} waiting for an account choice`);
  return parts.length ? parts.join(", ") : "Nothing new";
}
