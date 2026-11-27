import { normalizeMerge, uid } from "./util.js?v=137";

export const wordsMatch = (a, b) => {
  if (!a || !b || a.length < 3 || b.length < 3) return false;
  return a === b || a.startsWith(b) || b.startsWith(a);
};

export function getSharedWordsDefault(names) {
  if (!names || names.length < 2) return "";
  const normWords = (n) => normalizeMerge(n).split(" ").filter((w) => w.length >= 3);
  const firstWords = normWords(names[0]);
  const shared = firstWords.filter((fw) => names.slice(1).every((n) => normWords(n).some((w) => wordsMatch(fw, w))));
  if (!shared.length) return "";
  const firstNameWords = names[0].split(" ");
  return shared.map((sw) => firstNameWords.find((w) => normalizeMerge(w) === sw) || sw).join(" ");
}

export function buildMergeGroups(canonicals, rejected = [], excludeWords = []) {
  if (!canonicals || canonicals.length < 2) return [];
  const rejectedSet = pairKeys(rejected);
  const isPairRejected = (a, b) => rejectedSet.has([a, b].sort().join("|||"));
  const excludeNormed = new Set(excludeWords.map((w) => normalizeMerge(w)).filter((w) => w.length > 0));
  const normed = canonicals.map((n) => {
    const allWords = normalizeMerge(n).split(" ").filter((w) => w.length >= 3);
    const words = allWords.filter((w) => !excludeNormed.has(w));
    return { canonical: n, words, firstWord: words[0] || "" };
  });
  const sharesWords = (a, b) =>
    (a.firstWord && b.firstWord && wordsMatch(a.firstWord, b.firstWord)) ||
    a.words.some((aw) => b.words.some((bw) => wordsMatch(aw, bw)));
  const canJoin = (b, group) => !group.some((m) => isPairRejected(m.canonical, b.canonical));
  const groups = [];
  const assigned = new Set();
  const collect = (pred) => {
    for (const a of normed) {
      if (assigned.has(a.canonical) || (pred === "first" && !a.firstWord)) continue;
      const group = [a];
      for (const b of normed) {
        if (b === a || assigned.has(b.canonical)) continue;
        const ok = pred === "first" ? b.firstWord && wordsMatch(a.firstWord, b.firstWord) : sharesWords(a, b);
        if (ok && canJoin(b, group)) group.push(b);
      }
      if (group.length > 1) {
        group.forEach((m) => assigned.add(m.canonical));
        groups.push(group.map((m) => m.canonical));
      }
    }
  };
  collect("first");
  collect("any");
  return groups;
}

/** A stored rejection may be one pair, or an older key that listed the whole group. */
function pairKeys(rejected) {
  const set = new Set();
  for (const raw of rejected || []) {
    const parts = String(raw).split("|||").filter(Boolean);
    for (let i = 0; i < parts.length; i++) {
      for (let j = i + 1; j < parts.length; j++) set.add([parts[i], parts[j]].sort().join("|||"));
    }
  }
  return set;
}

const accountKeys = new WeakMap();

function accountKeySet(budget) {
  let set = accountKeys.get(budget);
  if (set) return set;
  set = new Set();
  const add = (name) => {
    const raw = String(name || "").trim().toLowerCase();
    if (!raw) return;
    set.add(raw);
    const key = normalizeMerge(name);
    if (key) set.add(key);
  };
  for (const a of budget?.accounts || []) add(a.name);
  for (const c of budget?.creditCards || []) add(c.name);
  accountKeys.set(budget, set);
  return set;
}

/** True when this string is an account or card, including "Transfer : Checking". Never a payee. */
export function isAccountPayee(budget, name) {
  if (!name || !budget) return false;
  const set = accountKeySet(budget);
  const raw = String(name).trim().toLowerCase();
  const key = normalizeMerge(name);
  if (set.has(raw) || (key && set.has(key))) return true;
  const stripped = raw.replace(/^transfer\s*(:|to|from)\s+/, "").trim();
  if (!stripped || stripped === raw) return false;
  const sk = normalizeMerge(stripped);
  return set.has(stripped) || (!!sk && set.has(sk));
}

export function payeeDirectory(budget) {
  return canonicalNames(budget).filter((n) => n && !isAccountPayee(budget, n));
}

const payeeByName = new WeakMap();

function payeeMap(budget) {
  let map = payeeByName.get(budget);
  if (map) return map;
  map = new Map();
  for (const p of budget?.payees || []) if (p?.name) map.set(p.name, p);
  payeeByName.set(budget, map);
  return map;
}

export function displayName(budget, original) {
  if (!original) return original || "";
  const rec = budget ? payeeMap(budget).get(original) : null;
  return rec?.canonicalName || original;
}

export function canonicalNames(budget) {
  const set = new Set();
  for (const tx of budget.transactions || []) {
    if (tx.subtype === "starting_balance") continue;
    const n = displayName(budget, tx.originalPayee);
    if (n) set.add(n);
  }
  for (const p of budget.payees || []) if (p.canonicalName) set.add(p.canonicalName);
  return [...set];
}

export function originalsForCanonical(budget, canonical) {
  const fromPayees = (budget.payees || []).filter((p) => p.canonicalName === canonical).map((p) => p.name);
  const fromTx = (budget.transactions || []).map((tx) => tx.originalPayee).filter(Boolean).filter((n) => displayName(budget, n) === canonical);
  return [...new Set([...fromPayees, ...fromTx])];
}

export function payeeDefaultCategory(budget, canonical) {
  if (!canonical) return "";
  for (const p of budget?.payees || []) {
    if ((p.canonicalName || p.name) === canonical && p.defaultCategoryId) return p.defaultCategoryId;
  }
  return "";
}

export function payeeSuggestedCategory(budget, canonical) {
  if (!canonical) return "";
  for (const p of budget?.payees || []) {
    if ((p.canonicalName || p.name) === canonical && p.suggestedCategoryId) return p.suggestedCategoryId;
  }
  return "";
}

export function ensurePayee(list, originalName, defaultCategoryId = "", suggestedCategoryId = "") {
  if (!originalName) return list;
  const existing = list.find((p) => p.name === originalName);
  if (existing) {
    if ((!existing.defaultCategoryId && defaultCategoryId) || (!existing.suggestedCategoryId && suggestedCategoryId)) {
      return list.map((p) => p.name === originalName
        ? { ...p, defaultCategoryId: p.defaultCategoryId || defaultCategoryId || "", suggestedCategoryId: p.suggestedCategoryId || suggestedCategoryId || "" }
        : p);
    }
    return list;
  }
  return [...list, { id: uid(), name: originalName, defaultCategoryId: defaultCategoryId || "", suggestedCategoryId: suggestedCategoryId || "", canonicalName: originalName }];
}

export function prunePayees(list, transactions) {
  const used = new Set((transactions || []).map((tx) => tx.originalPayee));
  return (list || []).filter((p) => used.has(p.name));
}

export function findFuzzyDuplicates(newTx, existing) {
  if (newTx.subtype === "starting_balance") return [];
  const matches = [];
  for (const ex of existing) {
    if (ex.id === newTx.id) continue;
    if (ex.subtype === "starting_balance") continue;
    if (ex.accountId !== newTx.accountId) continue;
    if (Math.abs(Math.abs(ex.amount) - Math.abs(newTx.amount)) > 0.05) continue;
    const a = new Date(ex.date + "T00:00:00").getTime();
    const b = new Date(newTx.date + "T00:00:00").getTime();
    if (Math.abs(a - b) / 86400000 > 2) continue;
    matches.push({ newTxId: newTx.id, existingTxId: ex.id });
  }
  return matches;
}

export function runPaymentMatchScan(transactions, creditCards, accounts) {
  const isCard = (id) => creditCards.some((c) => c.id === id);
  const isBank = (id) => accounts.some((a) => a.id === id);
  const ccSide = transactions.filter((tx) => tx.type === "payment" && !tx.categoryId && isCard(tx.accountId));
  const bankSide = transactions.filter((tx) => tx.type === "payment" && tx.categoryId && isBank(tx.accountId));
  const linked = new Map();
  const used = new Set();
  for (const ccTx of ccSide) {
    if (linked.has(ccTx.id)) continue;
    const preferred = ccTx.paymentFromAccountId;
    const candidates = bankSide.filter((bTx) =>
      !used.has(bTx.id) && !linked.has(bTx.id) &&
      Math.abs(ccTx.amount - bTx.amount) < 0.01 &&
      Math.abs(new Date(ccTx.date) - new Date(bTx.date)) <= 5 * 86400000
    ).sort((a, b) => {
      if (!preferred) return 0;
      if (a.accountId === preferred && b.accountId !== preferred) return -1;
      if (b.accountId === preferred && a.accountId !== preferred) return 1;
      return 0;
    });
    const match = candidates[0];
    if (match) {
      linked.set(ccTx.id, match.id);
      linked.set(match.id, ccTx.id);
      used.add(match.id);
    }
  }
  return transactions.map((tx) => {
    if (tx.type !== "payment") return tx;
    const cc = !tx.categoryId && isCard(tx.accountId);
    const bank = tx.categoryId && isBank(tx.accountId);
    if (!cc && !bank) return tx;
    const partnerId = linked.get(tx.id);
    const status = partnerId ? "linked" : "broken";
    if (tx.paymentLinkStatus === status && tx.paymentLinkId === partnerId) return tx;
    const next = { ...tx, paymentLinkStatus: status };
    if (partnerId) next.paymentLinkId = partnerId;
    else delete next.paymentLinkId;
    return next;
  });
}
