// ClearBudget v6.1 — cache bust
import { useState, useEffect, useCallback, useRef, useMemo, useContext } from "react";
import { ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from "recharts";

const STORAGE_KEY = "clearbudget-v3";
const USER_STORAGE_KEY = "clearbudget-user-v1";
const APP_VERSION = "2026.06.22";

// RFC4122-ish v4 UUID using Math.random (no crypto dependency required)
const genUserId = () => {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
};
// Derive a 4-char uppercase alphanumeric suffix from a UUID for guest display names
const guestSuffixFromId = (id) => {
  const stripped = id.replace(/-/g, "").toUpperCase();
  return stripped.slice(0, 4);
};

// One-time migration to the originalPayee/canonicalName payee model: every transaction gets
// an `originalPayee` (defaulting to its current displayed `payee`), and every payee record
// gets a `canonicalName` (defaulting to its own `name`, i.e. no remapping). Old merge-history
// fields (mergedFrom, originalName) are dropped — their effect is now captured by canonicalName.
const migratePayeeModel = (appData) => {
  if (!appData?.budgets) return appData;
  return {
    ...appData,
    budgets: appData.budgets.map(b => ({
      ...b,
      transactions: (b.transactions || []).map(tx => tx.originalPayee !== undefined ? tx : { ...tx, originalPayee: tx.payee }),
      payees: (b.payees || []).map(p => ({ id: p.id, name: p.name, defaultCategoryId: p.defaultCategoryId || "", suggestedCategoryId: p.suggestedCategoryId || "", canonicalName: p.canonicalName || p.name })),
      mergeExcludeWords: b.mergeExcludeWords || ["TST*"],
    })),
  };
};

const DEFAULT_GROUPS = [
  { id: "grp-1", name: "Monthly Bills" },
  { id: "grp-2", name: "Everyday Expenses" },
  { id: "grp-3", name: "Savings Goals" },
];
const DEFAULT_CATS = [
  { id: "cat-1", groupId: "grp-1", name: "Rent / Mortgage", rollover: "rollover" },
  { id: "cat-2", groupId: "grp-1", name: "Electric", rollover: "rollover" },
  { id: "cat-3", groupId: "grp-1", name: "Internet", rollover: "rollover" },
  { id: "cat-4", groupId: "grp-2", name: "Groceries", rollover: "rollover" },
  { id: "cat-5", groupId: "grp-2", name: "Dining Out", rollover: "rollover" },
  { id: "cat-6", groupId: "grp-2", name: "Gas", rollover: "rollover" },
  { id: "cat-7", groupId: "grp-3", name: "Emergency Fund", rollover: "rollover" },
  { id: "cat-8", groupId: "grp-3", name: "Vacation", rollover: "rollover" },
];

// ── Helpers ──────────────────────────────────────────────────
const fmt = (v) => { const a = Math.abs(v); const s = a.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); return (v < 0 && a >= 0.005) ? `-$${s}` : `$${s}`; };
const uid = () => `id-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

// ── Test budget builder — for QA testing only, easily removable ──
const buildTestBudget = () => {
  const today = new Date();
  const mk = (mo = 0) => { const dt = new Date(today.getFullYear(), today.getMonth() + mo, 1); return `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,"0")}`; };
  // Local-date helpers (avoid UTC off-by-one)
  const fmtLocal = (dt) => `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,"0")}-${String(dt.getDate()).padStart(2,"0")}`;
  const d = (offset = 0) => { const dt = new Date(today); dt.setDate(dt.getDate() + offset); return fmtLocal(dt); };
  const mkDate = (monthOffset, day) => fmtLocal(new Date(today.getFullYear(), today.getMonth() + monthOffset, day));

  // ── Accounts & Cards ──
  const chkId = uid(); const savId = uid(); const cashId = uid();
  const visaId = uid(); const amexId = uid();

  // ── Category Groups ──
  const housingGrp = uid(); const foodGrp = uid(); const transGrp = uid();
  const healthGrp = uid(); const savingsGrp = uid(); const entGrp = uid();
  const billsGrp = uid(); const ccGrp = uid();

  // ── Categories ──
  const rentCat = uid(); const electricCat = uid(); const internetCat = uid();
  const phoneCat = uid(); const grocCat = uid(); const diningCat = uid();
  const coffeeCat = uid(); const gasCat = uid(); const carInsCat = uid();
  const carPayCat = uid(); const gymCat = uid(); const medCat = uid();
  const emergFundCat = uid(); const vacationCat = uid(); const newCarCat = uid();
  const streamCat = uid(); const hobbyDat = uid(); const clothCat = uid();
  const visaPayCat = uid(); const amexPayCat = uid();

  const vacTargetDate = mk(9);

  const categoryGroups = [
    { id: housingGrp, name: "Housing" },
    { id: foodGrp, name: "Food & Dining" },
    { id: transGrp, name: "Transportation" },
    { id: healthGrp, name: "Health & Fitness" },
    { id: savingsGrp, name: "Savings Goals" },
    { id: entGrp, name: "Entertainment" },
    { id: billsGrp, name: "Bills & Subscriptions" },
    { id: ccGrp, name: "Credit Card Payments" },
  ];

  const categories = [
    { id: rentCat,      groupId: housingGrp, name: "Rent / Mortgage",   rollover: "return", goal: { type: "monthly", target: 1850 } },
    { id: electricCat,  groupId: housingGrp, name: "Electric",           rollover: "rollover" },
    { id: internetCat,  groupId: housingGrp, name: "Internet",           rollover: "return" },
    { id: phoneCat,     groupId: billsGrp,   name: "Phone Bill",         rollover: "return" },
    { id: grocCat,      groupId: foodGrp,    name: "Groceries",          rollover: "rollover", goal: { type: "monthly", target: 600 } },
    { id: diningCat,    groupId: foodGrp,    name: "Dining Out",         rollover: "rollover" },
    { id: coffeeCat,    groupId: foodGrp,    name: "Coffee Shops",       rollover: "rollover" },
    { id: gasCat,       groupId: transGrp,   name: "Gas",                rollover: "rollover" },
    { id: carInsCat,    groupId: transGrp,   name: "Auto Insurance",     rollover: "return", goal: { type: "monthly", target: 130 } },
    { id: carPayCat,    groupId: transGrp,   name: "Car Payment",        rollover: "return", goal: { type: "monthly", target: 420 } },
    { id: gymCat,       groupId: healthGrp,  name: "Gym & Fitness",      rollover: "return" },
    { id: medCat,       groupId: healthGrp,  name: "Medical",            rollover: "rollover" },
    { id: emergFundCat, groupId: savingsGrp, name: "Emergency Fund",     rollover: "max", rolloverMax: 10000, goal: { type: "savings", target: 10000 } },
    { id: vacationCat,  groupId: savingsGrp, name: "Vacation Fund",      rollover: "rollover", goal: { type: "date", target: 3000, targetDate: vacTargetDate } },
    { id: newCarCat,    groupId: savingsGrp, name: "New Car Down Payment",rollover: "rollover", goal: { type: "savings", target: 5000 } },
    { id: streamCat,    groupId: entGrp,     name: "Streaming Services", rollover: "return" },
    { id: hobbyDat,     groupId: entGrp,     name: "Hobbies",            rollover: "rollover" },
    { id: clothCat,     groupId: entGrp,     name: "Clothing",           rollover: "rollover" },
    { id: visaPayCat,   groupId: ccGrp,      name: "Visa Payment",       creditCardId: visaId, rollover: "rollover" },
    { id: amexPayCat,   groupId: ccGrp,      name: "Amex Payment",       creditCardId: amexId, rollover: "rollover" },
  ];

  // ── Starting balances (3 months back) ──
  // Cards start at $0 — fully paid off, no carried balance
  const startTxs = [
    { id: uid(), date: mkDate(-3, 1), payee: "Starting Balance", originalPayee: "Starting Balance", note: "", type: "income", subtype: "starting_balance", accountId: chkId,  amount: 6200,  reconciled: true },
    { id: uid(), date: mkDate(-3, 1), payee: "Starting Balance", originalPayee: "Starting Balance", note: "", type: "income", subtype: "starting_balance", accountId: savId,  amount: 12000, reconciled: true },
    { id: uid(), date: mkDate(-3, 1), payee: "Starting Balance", originalPayee: "Starting Balance", note: "", type: "income", subtype: "starting_balance", accountId: cashId, amount: 200,   reconciled: true },
  ];

  // ── Payment link IDs ──
  const visa2mChk = uid(); const visa2mCard = uid();
  const amex2mChk = uid(); const amex2mCard = uid();
  const visa1mChk = uid(); const visa1mCard = uid();
  const amex1mChk = uid(); const amex1mCard = uid();

  // Helper: each month's card charges, fully paid the following month.
  // Cards end fully paid off because every charge is matched by a payment.
  const txs = [
    // ═══════════════════════════════════════════════
    // 2 MONTHS AGO — fully reconciled
    // ═══════════════════════════════════════════════
    { type: "income",  accountId: chkId, payee: "Acme Corp Payroll", amount: 3600, date: mkDate(-2, 1),  categoryId: null, reconciled: true },
    { type: "income",  accountId: chkId, payee: "Acme Corp Payroll", amount: 3600, date: mkDate(-2, 15), categoryId: null, reconciled: true },
    { type: "expense", accountId: chkId, payee: "Sunset Apartments",     categoryId: rentCat,     amount: 1850,  date: mkDate(-2, 2),  categoryConfirmed: true, reconciled: true },
    { type: "expense", accountId: chkId, payee: "City Electric Co",      categoryId: electricCat, amount: 162,   date: mkDate(-2, 5),  categoryConfirmed: true, reconciled: true },
    { type: "expense", accountId: chkId, payee: "Comcast Internet",      categoryId: internetCat, amount: 65,    date: mkDate(-2, 6),  categoryConfirmed: true, reconciled: true },
    { type: "expense", accountId: chkId, payee: "T-Mobile",              categoryId: phoneCat,    amount: 85,    date: mkDate(-2, 7),  categoryConfirmed: true, reconciled: true },
    { type: "expense", accountId: chkId, payee: "Progressive Insurance", categoryId: carInsCat,   amount: 130,   date: mkDate(-2, 8),  categoryConfirmed: true, reconciled: true },
    { type: "expense", accountId: chkId, payee: "Honda Financial",       categoryId: carPayCat,   amount: 420,   date: mkDate(-2, 9),  categoryConfirmed: true, reconciled: true },
    // Visa charges (-2mo)
    { type: "expense", accountId: visaId, payee: "Whole Foods Market", categoryId: grocCat,   amount: 134,   date: mkDate(-2, 10), categoryConfirmed: true, reconciled: true },
    { type: "expense", accountId: visaId, payee: "Trader Joe's",       categoryId: grocCat,   amount: 92,    date: mkDate(-2, 14), categoryConfirmed: true, reconciled: true },
    { type: "expense", accountId: visaId, payee: "Chipotle",           categoryId: diningCat, amount: 18,    date: mkDate(-2, 16), categoryConfirmed: true, reconciled: true },
    { type: "expense", accountId: visaId, payee: "Starbucks #4421",    categoryId: coffeeCat, amount: 24,    date: mkDate(-2, 17), categoryConfirmed: true, reconciled: true },
    { type: "expense", accountId: visaId, payee: "Shell Gas Station",  categoryId: gasCat,    amount: 55,    date: mkDate(-2, 18), categoryConfirmed: true, reconciled: true },
    // Visa total -2mo = 134+92+18+24+55 = 323
    // Amex charges (-2mo)
    { type: "expense", accountId: amexId, payee: "Netflix", categoryId: streamCat, amount: 15.99, date: mkDate(-2, 20), categoryConfirmed: true, reconciled: true },
    { type: "expense", accountId: amexId, payee: "Spotify", categoryId: streamCat, amount: 9.99,  date: mkDate(-2, 20), categoryConfirmed: true, reconciled: true },
    // Amex total -2mo = 25.98
    // Transfer checking → savings
    { type: "income",  accountId: savId, payee: "Transfer from Checking", amount: 300, date: mkDate(-2, 25), categoryId: null, reconciled: true },
    { type: "expense", accountId: chkId, payee: "Transfer to Savings",    categoryId: emergFundCat, amount: 300, date: mkDate(-2, 25), categoryConfirmed: true, reconciled: true },

    // ═══════════════════════════════════════════════
    // 1 MONTH AGO — pays off the -2mo card balances, has its own charges
    // ═══════════════════════════════════════════════
    { type: "income",  accountId: chkId, payee: "Acme Corp Payroll", amount: 3600, date: mkDate(-1, 1),  categoryId: null, reconciled: true },
    { type: "income",  accountId: chkId, payee: "Acme Corp Payroll", amount: 3600, date: mkDate(-1, 15), categoryId: null, reconciled: true },
    { type: "expense", accountId: chkId, payee: "Sunset Apartments",     categoryId: rentCat,     amount: 1850, date: mkDate(-1, 2), categoryConfirmed: true, reconciled: true },
    { type: "expense", accountId: chkId, payee: "City Electric Co",      categoryId: electricCat, amount: 178,  date: mkDate(-1, 5), categoryConfirmed: true, reconciled: true },
    { type: "expense", accountId: chkId, payee: "Comcast Internet",      categoryId: internetCat, amount: 65,   date: mkDate(-1, 6), categoryConfirmed: true, reconciled: true },
    { type: "expense", accountId: chkId, payee: "T-Mobile",              categoryId: phoneCat,    amount: 85,   date: mkDate(-1, 7), categoryConfirmed: true, reconciled: true },
    { type: "expense", accountId: chkId, payee: "Progressive Insurance", categoryId: carInsCat,   amount: 130,  date: mkDate(-1, 8), categoryConfirmed: true, reconciled: true },
    { type: "expense", accountId: chkId, payee: "Honda Financial",       categoryId: carPayCat,   amount: 420,  date: mkDate(-1, 9), categoryConfirmed: true, reconciled: true },
    // Pay off -2mo Visa balance ($323) — linked payment
    { id: visa2mChk,  type: "payment", accountId: chkId,  categoryId: visaPayCat, amount: 323, date: mkDate(-1, 3), paymentLinkStatus: "linked", paymentLinkId: visa2mCard, payee: "", originalPayee: "", note: "", reconciled: true },
    { id: visa2mCard, type: "payment", accountId: visaId, amount: 323, date: mkDate(-1, 4), paymentLinkStatus: "linked", paymentLinkId: visa2mChk, paymentFromAccountId: chkId, payee: "", originalPayee: "", note: "", reconciled: true },
    // Pay off -2mo Amex balance ($25.98) — linked payment
    { id: amex2mChk,  type: "payment", accountId: chkId,  categoryId: amexPayCat, amount: 25.98, date: mkDate(-1, 3), paymentLinkStatus: "linked", paymentLinkId: amex2mCard, payee: "", originalPayee: "", note: "", reconciled: true },
    { id: amex2mCard, type: "payment", accountId: amexId, amount: 25.98, date: mkDate(-1, 4), paymentLinkStatus: "linked", paymentLinkId: amex2mChk, paymentFromAccountId: chkId, payee: "", originalPayee: "", note: "", reconciled: true },
    // Visa charges (-1mo)
    { type: "expense", accountId: visaId, payee: "Whole Foods Market", categoryId: grocCat,   amount: 148, date: mkDate(-1, 10), categoryConfirmed: true, reconciled: true },
    { type: "expense", accountId: visaId, payee: "Trader Joe's",       categoryId: grocCat,   amount: 109, date: mkDate(-1, 16), categoryConfirmed: true, reconciled: true },
    { type: "expense", accountId: visaId, payee: "Panera Bread",       categoryId: diningCat, amount: 22,  date: mkDate(-1, 12), categoryConfirmed: true, reconciled: true },
    { type: "expense", accountId: visaId, payee: "Shell Gas Station",  categoryId: gasCat,    amount: 62,  date: mkDate(-1, 14), categoryConfirmed: true, reconciled: true },
    // Refund: Amazon return on Visa (negative expense, reduces balance)
    { type: "expense", accountId: visaId, payee: "Amazon", categoryId: clothCat, amount: -42, date: mkDate(-1, 21), categoryConfirmed: true, note: "Returned jacket", reconciled: true },
    // Visa total -1mo = 148+109+22+62-42 = 299
    // Amex charges (-1mo)
    { type: "expense", accountId: amexId, payee: "Netflix", categoryId: streamCat, amount: 15.99, date: mkDate(-1, 20), categoryConfirmed: true, reconciled: true },
    { type: "expense", accountId: amexId, payee: "Spotify", categoryId: streamCat, amount: 9.99,  date: mkDate(-1, 20), categoryConfirmed: true, reconciled: true },
    // Dr. Chen split (medical + emergency fund reimbursement)
    { type: "expense", accountId: amexId, payee: "Dr. Chen Pediatrics", amount: 120, date: mkDate(-1, 22), categoryConfirmed: true, reconciled: true,
      splits: [{ categoryId: medCat, amount: 70 }, { categoryId: emergFundCat, amount: 50 }] },
    // Amex total -1mo = 15.99+9.99+120 = 145.98

    // ═══════════════════════════════════════════════
    // CURRENT MONTH — pays off -1mo card balances, fresh charges, both cards end paid off
    // ═══════════════════════════════════════════════
    { type: "income",  accountId: chkId, payee: "Acme Corp Payroll", amount: 3600, date: d(-14), categoryId: null },
    { type: "income",  accountId: chkId, payee: "Acme Corp Payroll", amount: 3600, date: d(-2),  categoryId: null },
    { type: "expense", accountId: chkId, payee: "Sunset Apartments",     categoryId: rentCat,     amount: 1850, date: d(-12), categoryConfirmed: true },
    { type: "expense", accountId: chkId, payee: "City Electric Co",      categoryId: electricCat, amount: 155,  date: d(-10), categoryConfirmed: true },
    { type: "expense", accountId: chkId, payee: "Comcast Internet",      categoryId: internetCat, amount: 65,   date: d(-10), categoryConfirmed: true },
    { type: "expense", accountId: chkId, payee: "T-Mobile",              categoryId: phoneCat,    amount: 85,   date: d(-9),  categoryConfirmed: true },
    { type: "expense", accountId: chkId, payee: "Progressive Insurance", categoryId: carInsCat,   amount: 130,  date: d(-9),  categoryConfirmed: true },
    { type: "expense", accountId: chkId, payee: "Honda Financial",       categoryId: carPayCat,   amount: 420,  date: d(-8),  categoryConfirmed: true },
    // Pay off -1mo Visa balance ($299) — linked
    { id: visa1mChk,  type: "payment", accountId: chkId,  categoryId: visaPayCat, amount: 299, date: d(-7), paymentLinkStatus: "linked", paymentLinkId: visa1mCard, payee: "", originalPayee: "", note: "" },
    { id: visa1mCard, type: "payment", accountId: visaId, amount: 299, date: d(-7), paymentLinkStatus: "linked", paymentLinkId: visa1mChk, paymentFromAccountId: chkId, payee: "", originalPayee: "", note: "" },
    // Pay off -1mo Amex balance ($145.98) — linked
    { id: amex1mChk,  type: "payment", accountId: chkId,  categoryId: amexPayCat, amount: 145.98, date: d(-7), paymentLinkStatus: "linked", paymentLinkId: amex1mCard, payee: "", originalPayee: "", note: "" },
    { id: amex1mCard, type: "payment", accountId: amexId, amount: 145.98, date: d(-7), paymentLinkStatus: "linked", paymentLinkId: amex1mChk, paymentFromAccountId: chkId, payee: "", originalPayee: "", note: "" },
    // Current Visa charges — paid off by an in-month payment so card ends at $0
    { type: "expense", accountId: visaId, payee: "Whole Foods Market", categoryId: grocCat,   amount: 138, date: d(-6), categoryConfirmed: true },
    { type: "expense", accountId: visaId, payee: "Shell Gas Station",  categoryId: gasCat,    amount: 52,  date: d(-5), categoryConfirmed: true },
    { type: "expense", accountId: visaId, payee: "Starbucks #4421",    categoryId: coffeeCat, amount: 19,  date: d(-4), categoryConfirmed: true },
    // Visa current charges = 138+52+19 = 209 → pay it off in-month
    { type: "expense", accountId: visaId, payee: "Planet Fitness", categoryId: gymCat, amount: 24.99, date: d(-3), categoryConfirmed: true },
    // Visa current total = 209 + 24.99 = 233.99 → paid off below
    // Current Amex charges
    { type: "expense", accountId: amexId, payee: "Netflix", categoryId: streamCat, amount: 15.99, date: d(-2), categoryConfirmed: true },
    { type: "expense", accountId: amexId, payee: "Spotify", categoryId: streamCat, amount: 9.99,  date: d(-2), categoryConfirmed: true },
    // Amex current total = 25.98 → paid off below
    // In-month payoffs so both cards land at exactly $0
    { id: uid(), type: "payment", accountId: chkId,  categoryId: visaPayCat, amount: 233.99, date: d(-1), paymentLinkStatus: "linked", paymentLinkId: "VISA_CURR_CARD", payee: "", originalPayee: "", note: "" },
    { id: "VISA_CURR_CARD", type: "payment", accountId: visaId, amount: 233.99, date: d(-1), paymentLinkStatus: "linked", paymentLinkId: "VISA_CURR_CHK_MARKER", paymentFromAccountId: chkId, payee: "", originalPayee: "", note: "" },
    { id: uid(), type: "payment", accountId: chkId,  categoryId: amexPayCat, amount: 25.98, date: d(-1), paymentLinkStatus: "linked", paymentLinkId: "AMEX_CURR_CARD", payee: "", originalPayee: "", note: "" },
    { id: "AMEX_CURR_CARD", type: "payment", accountId: amexId, amount: 25.98, date: d(-1), paymentLinkStatus: "linked", paymentLinkId: "AMEX_CURR_CHK_MARKER", paymentFromAccountId: chkId, payee: "", originalPayee: "", note: "" },
  ];

  // ── Derive CC payment-category budgets from actual charges (mirrors auto-bump) ──
  // For each month, budget = sum of card expenses charged that month (signed, refunds reduce).
  // With rollover + matching payments (which appear as activity), available nets to card balance.
  const mb = {};
  [-2, -1, 0, 1].forEach(mo => {
    mb[mk(mo)] = {
      [rentCat]:      1850,
      [electricCat]:   180,
      [internetCat]:    65,
      [phoneCat]:       85,
      [grocCat]:       600,
      [diningCat]:     200,
      [coffeeCat]:      60,
      [gasCat]:         90,
      [carInsCat]:     130,
      [carPayCat]:     420,
      [gymCat]:         45,
      [medCat]:         80,
      [emergFundCat]:  400,
      [vacationCat]:   250,
      [newCarCat]:     200,
      [streamCat]:      30,
      [hobbyDat]:        0,
      [clothCat]:      100,
    };
  });
  // Compute CC payment budgets from card expense transactions per month
  const allForBudget = [...startTxs, ...txs];
  const cardOf = (id) => id === visaId ? visaPayCat : id === amexId ? amexPayCat : null;
  allForBudget.forEach(t => {
    if (t.type !== "expense") return;
    const payCat = cardOf(t.accountId);
    if (!payCat) return;
    const m = t.date.slice(0, 7);
    if (!mb[m]) mb[m] = {};
    mb[m][payCat] = (mb[m][payCat] || 0) + Number(t.amount); // signed: refunds reduce
  });

  // ── Inflows ──
  const inflows = {};
  [-2, -1, 0].forEach(mo => { inflows[mk(mo)] = 7200; });

  const allTxs = [...startTxs, ...txs].map(t => ({
    id: t.id || uid(),
    date: t.date,
    payee: t.payee,
    originalPayee: t.originalPayee !== undefined ? t.originalPayee : t.payee,
    note: t.note !== undefined ? t.note : "",
    type: t.type,
    accountId: t.accountId,
    amount: t.amount,
    ...(t.categoryId !== undefined ? { categoryId: t.categoryId } : {}),
    ...(t.categoryConfirmed !== undefined ? { categoryConfirmed: t.categoryConfirmed } : {}),
    ...(t.splits ? { splits: t.splits.map(sp => ({ categoryId: sp.categoryId, amount: sp.amount })) } : {}),
    ...(t.paymentLinkStatus ? { paymentLinkStatus: t.paymentLinkStatus } : {}),
    ...(t.paymentLinkId ? { paymentLinkId: t.paymentLinkId } : {}),
    ...(t.paymentFromAccountId ? { paymentFromAccountId: t.paymentFromAccountId } : {}),
    ...(t.subtype ? { subtype: t.subtype } : {}),
    ...(t.reconciled ? { reconciled: true } : {}),
  }));

  // Fix up the current-month payment link IDs (markers → real partner IDs)
  const visaCurrChk = allTxs.find(t => t.paymentLinkId === "VISA_CURR_CARD");
  const visaCurrCard = allTxs.find(t => t.id === "VISA_CURR_CARD");
  if (visaCurrChk && visaCurrCard) { visaCurrCard.id = uid(); visaCurrChk.paymentLinkId = visaCurrCard.id; visaCurrCard.paymentLinkId = visaCurrChk.id; }
  const amexCurrChk = allTxs.find(t => t.paymentLinkId === "AMEX_CURR_CARD");
  const amexCurrCard = allTxs.find(t => t.id === "AMEX_CURR_CARD");
  if (amexCurrChk && amexCurrCard) { amexCurrCard.id = uid(); amexCurrChk.paymentLinkId = amexCurrCard.id; amexCurrCard.paymentLinkId = amexCurrChk.id; }

  // ── Payees ──
  const payees = [
    { id: uid(), name: "Acme Corp Payroll",    defaultCategoryId: "",          suggestedCategoryId: "", canonicalName: "Acme Corp Payroll" },
    { id: uid(), name: "Sunset Apartments",     defaultCategoryId: rentCat,     suggestedCategoryId: "", canonicalName: "Sunset Apartments" },
    { id: uid(), name: "City Electric Co",      defaultCategoryId: electricCat, suggestedCategoryId: "", canonicalName: "City Electric Co" },
    { id: uid(), name: "Comcast Internet",      defaultCategoryId: internetCat, suggestedCategoryId: "", canonicalName: "Comcast Internet" },
    { id: uid(), name: "T-Mobile",              defaultCategoryId: phoneCat,    suggestedCategoryId: "", canonicalName: "T-Mobile" },
    { id: uid(), name: "Progressive Insurance", defaultCategoryId: carInsCat,   suggestedCategoryId: "", canonicalName: "Progressive Insurance" },
    { id: uid(), name: "Honda Financial",       defaultCategoryId: carPayCat,   suggestedCategoryId: "", canonicalName: "Honda Financial" },
    { id: uid(), name: "Whole Foods Market",    defaultCategoryId: grocCat,     suggestedCategoryId: "", canonicalName: "Whole Foods Market" },
    { id: uid(), name: "Trader Joe's",          defaultCategoryId: grocCat,     suggestedCategoryId: "", canonicalName: "Trader Joe's" },
    { id: uid(), name: "Chipotle",              defaultCategoryId: diningCat,   suggestedCategoryId: "", canonicalName: "Chipotle" },
    { id: uid(), name: "Panera Bread",          defaultCategoryId: diningCat,   suggestedCategoryId: "", canonicalName: "Panera Bread" },
    { id: uid(), name: "Starbucks #4421",       defaultCategoryId: coffeeCat,   suggestedCategoryId: "", canonicalName: "Starbucks" },
    { id: uid(), name: "Shell Gas Station",     defaultCategoryId: gasCat,      suggestedCategoryId: "", canonicalName: "Shell Gas Station" },
    { id: uid(), name: "Planet Fitness",        defaultCategoryId: gymCat,      suggestedCategoryId: "", canonicalName: "Planet Fitness" },
    { id: uid(), name: "Netflix",               defaultCategoryId: streamCat,   suggestedCategoryId: "", canonicalName: "Netflix" },
    { id: uid(), name: "Spotify",               defaultCategoryId: streamCat,   suggestedCategoryId: "", canonicalName: "Spotify" },
    { id: uid(), name: "Amazon",                defaultCategoryId: "",          suggestedCategoryId: clothCat, canonicalName: "Amazon" },
    { id: uid(), name: "Dr. Chen Pediatrics",   defaultCategoryId: medCat,      suggestedCategoryId: "", canonicalName: "Dr. Chen Pediatrics" },
  ];

  return {
    id: uid(), name: "🧪 Test Budget", createdAt: new Date().toISOString(), archived: false,
    accounts: [
      { id: chkId,  name: "Chase Checking", type: "checking", balance: 0, reconciledDate: mkDate(-1, 28) },
      { id: savId,  name: "Chase Savings",  type: "savings",  balance: 0 },
      { id: cashId, name: "Cash Wallet",    type: "cash",     balance: 0 },
    ],
    creditCards: [
      { id: visaId, name: "Chase Visa", balance: 0 },
      { id: amexId, name: "Amex Blue",  balance: 0 },
    ],
    categoryGroups, categories, monthlyBudgets: mb, inflows, payees,
    transactions: allTxs,
    pendingDuplicates: [],
    rejectedMerges: [], moneyMoveLog: [], mergeExcludeWords: ["TST*"],
  };
};

// Capitalizes the first letter of each word, leaving the rest of each word as typed
// (so acronyms like "USA" or "ATM" survive). Used to default names to Title Case.
const toTitleCase = (s) => (s || "").replace(/\b\w/g, c => c.toUpperCase());
// For search: strip all special chars EXCEPT #, collapse spaces, lowercase
const normalizeSearch = (s) => (s || "").toLowerCase().replace(/[^a-z0-9# ]/g, "").replace(/\s+/g, " ").trim();
// For merge detection: strip ALL special chars including #, collapse spaces, lowercase
const normalizeMerge = (s) => (s || "").toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
const daysSince = (dateStr) => Math.floor((new Date().setHours(0, 0, 0, 0) - new Date(dateStr + "T00:00:00").getTime()) / 86400000);
const dateDiffDays = (a, b) => Math.abs((new Date(a + "T00:00:00").getTime() - new Date(b + "T00:00:00").getTime()) / 86400000);

// Fuzzy duplicate detection: same account, amount within $0.05, date within 2 days, any payee.
// Returns array of { newTxId, existingTxId } pairs.
const findFuzzyDuplicates = (newTx, existingTxs) => {
  // Never flag starting balance transactions as duplicates
  if (newTx.subtype === "starting_balance") return [];
  const matches = [];
  for (const ex of existingTxs) {
    if (ex.id === newTx.id) continue;
    if (ex.subtype === "starting_balance") continue;
    if (ex.accountId !== newTx.accountId) continue;
    if (Math.abs(Math.abs(ex.amount) - Math.abs(newTx.amount)) > 0.05) continue;
    if (dateDiffDays(ex.date, newTx.date) > 2) continue;
    matches.push({ newTxId: newTx.id, existingTxId: ex.id });
  }
  return matches;
};

// ── Merge detection helpers (module-level so MainApp and PayeesView share them) ──
const wordsMatch = (a, b) => {
  if (a.length < 3 || b.length < 3) return false;
  return a === b || a.startsWith(b) || b.startsWith(a);
};

const getSharedWordsDefault = (names) => {
  if (!names || names.length < 2) return "";
  const normWords = (n) => normalizeMerge(n).split(" ").filter(w => w.length >= 3);
  const firstWords = normWords(names[0]);
  const sharedNorm = firstWords.filter(fw =>
    names.slice(1).every(n => normWords(n).some(w => wordsMatch(fw, w)))
  );
  if (!sharedNorm.length) return "";
  const firstNameWords = names[0].split(" ");
  return sharedNorm.map(sw => firstNameWords.find(w => normalizeMerge(w) === sw) || sw).join(" ");
};

const buildMergeGroups = (canonicals, rejected, excludeWords = []) => {
  if (!canonicals || canonicals.length < 2) return [];
  const rejectedSet = new Set(rejected);
  const isPairRejected = (a, b) => rejectedSet.has([a, b].sort().join("|||"));
  // Normalize excluded words — strip wildcards, normalize, then exclude from word matching
  // Excluded words matched literally after normalization — "TST*" matches the token "tst*" not a wildcard pattern.
  const excludeNormed = new Set(excludeWords.map(w => normalizeMerge(w)).filter(w => w.length > 0));

  const normed = canonicals.map(n => {
    const allWords = normalizeMerge(n).split(" ").filter(w => w.length >= 3);
    const words = allWords.filter(w => !excludeNormed.has(w)); // excluded words can't trigger merges
    return { canonical: n, words, firstWord: words[0] || "" };
  });

  const sharesWords = (a, b) =>
    (a.firstWord && b.firstWord && wordsMatch(a.firstWord, b.firstWord)) ||
    a.words.some(aw => b.words.some(bw => wordsMatch(aw, bw)));

  // Candidate b can join group only if:
  //   1. It shares words with the seed (a)
  //   2. It is NOT rejected against ANY current group member
  const canJoin = (b, group) =>
    !group.some(m => isPairRejected(m.canonical, b.canonical));

  const groups = [];
  const assigned = new Set();

  // Pass 1: first-word prefix match
  normed.forEach((a) => {
    if (assigned.has(a.canonical) || !a.firstWord) return;
    const group = [a];
    normed.forEach((b) => {
      if (b === a || assigned.has(b.canonical) || !b.firstWord) return;
      if (wordsMatch(a.firstWord, b.firstWord) && canJoin(b, group)) group.push(b);
    });
    if (group.length > 1) { group.forEach(m => assigned.add(m.canonical)); groups.push(group.map(m => m.canonical)); }
  });

  // Pass 2: any-word prefix match for remaining
  normed.forEach((a) => {
    if (assigned.has(a.canonical)) return;
    const group = [a];
    normed.forEach((b) => {
      if (b === a || assigned.has(b.canonical)) return;
      if (sharesWords(a, b) && canJoin(b, group)) group.push(b);
    });
    if (group.length > 1) { group.forEach(m => assigned.add(m.canonical)); groups.push(group.map(m => m.canonical)); }
  });

  return groups;
};

const toModalGroups = (rawGroups) => rawGroups.map(g => ({
  names: g, checked: g, customName: getSharedWordsDefault(g),
}));

// ── Payment link matching ──
// Scans transactions and links CC-side payments (type "payment", no categoryId, on a CC account)
// with checking/savings-side payments (type "payment", with categoryId, on a bank account).
// Matching criteria: same amount (within $0.01) and dates within 5 days.
// paymentLinkStatus: "broken" = unmatched, "linked" = matched. System-only — never user-editable.
const runPaymentMatchScan = (transactions, creditCards, accounts) => {
  const isCardAccount = (id) => creditCards.some(c => c.id === id);
  const isBankAccount = (id) => accounts.some(a => a.id === id);

  // CC-side: type=payment, no categoryId, on a CC account
  const ccSide = transactions.filter(tx =>
    tx.type === "payment" && !tx.categoryId && isCardAccount(tx.accountId)
  );
  // Bank-side: type=payment, has categoryId (CC payment cat), on a bank account
  const bankSide = transactions.filter(tx =>
    tx.type === "payment" && tx.categoryId && isBankAccount(tx.accountId)
  );

  const linked = new Map(); // txId → partnerId
  const usedBankIds = new Set();

  ccSide.forEach(ccTx => {
    if (linked.has(ccTx.id)) return;
    // Prefer a match from the specified paymentFromAccountId if set
    const preferredAccountId = ccTx.paymentFromAccountId;
    const candidates = bankSide
      .filter(bTx =>
        !usedBankIds.has(bTx.id) &&
        !linked.has(bTx.id) &&
        Math.abs(ccTx.amount - bTx.amount) < 0.01 &&
        Math.abs(new Date(ccTx.date) - new Date(bTx.date)) <= 5 * 86400000
      )
      .sort((a, b) => {
        // Prefer candidate from the specified account
        if (preferredAccountId) {
          if (a.accountId === preferredAccountId && b.accountId !== preferredAccountId) return -1;
          if (b.accountId === preferredAccountId && a.accountId !== preferredAccountId) return 1;
        }
        return 0;
      });
    const match = candidates[0];
    if (match) {
      linked.set(ccTx.id, match.id);
      linked.set(match.id, ccTx.id);
      usedBankIds.add(match.id);
    }
  });

  return transactions.map(tx => {
    if (tx.type !== "payment") return tx;
    const isCCSide = !tx.categoryId && isCardAccount(tx.accountId);
    const isBankSide2 = tx.categoryId && isBankAccount(tx.accountId);
    if (!isCCSide && !isBankSide2) return tx;
    const partnerId = linked.get(tx.id);
    const status = partnerId ? "linked" : "broken";
    if (tx.paymentLinkStatus === status && tx.paymentLinkId === partnerId) return tx; // no change
    return { ...tx, paymentLinkStatus: status, ...(partnerId ? { paymentLinkId: partnerId } : { paymentLinkId: undefined }) };
  });
};
const prunePayees = (payeesList, transactions) => {
  const usedNames = new Set(transactions.map(tx => tx.originalPayee));
  return (payeesList || []).filter(p => usedNames.has(p.name));
};

const ensurePayeeRecord = (payeesList, originalName, defaultCategoryId, suggestedCategoryId = "") => {
  if (!originalName) return payeesList;
  const existing = payeesList.find(p => p.name === originalName);
  if (existing) {
    if ((!existing.defaultCategoryId && defaultCategoryId) || (!existing.suggestedCategoryId && suggestedCategoryId)) {
      return payeesList.map(p => p.name === originalName ? { ...p, defaultCategoryId: p.defaultCategoryId || defaultCategoryId || "", suggestedCategoryId: p.suggestedCategoryId || suggestedCategoryId || "" } : p);
    }
    return payeesList;
  }
  return [...payeesList, { id: uid(), name: originalName, defaultCategoryId: defaultCategoryId || "", suggestedCategoryId: suggestedCategoryId || "", canonicalName: originalName }];
};

// ── Payment category virtual option helpers ──
// CC account transactions use "Payment from [Account]" virtual category values to drive type.
// These aren't real budget categories — they're pseudo-options in the category picker.
const PAY_FROM_PREFIX = "__pay_from__";
const isPayFromValue = (v) => !!(v && v.startsWith(PAY_FROM_PREFIX));
const getPayFromAccountId = (v) => v?.slice(PAY_FROM_PREFIX.length) || "";
const makePayFromValue = (accountId) => PAY_FROM_PREFIX + accountId;

// Build category options appropriate for the given account type.
// CC accounts: "Payment from [X]" virtual options + normal cats (no CC payment cats)
// Bank accounts: all normal cats including CC payment cats
// extraTopOptions: e.g. [{ value: "__rta__", label: "→ Ready to Assign" }]
const buildCatOptionsForAccount = (accountId, budget, extraTopOptions = []) => {
  const isCC = budget.creditCards.some(c => c.id === accountId);
  const opts = [{ value: "", label: "No category" }, ...extraTopOptions];
  if (isCC) {
    const payFromOpts = budget.accounts.filter(a => !a.archived).map(a => ({
      value: makePayFromValue(a.id), label: `Payment from ${a.name}`, group: "Credit Card Payments",
    }));
    if (payFromOpts.length) opts.push(...payFromOpts);
    budget.categoryGroups.forEach(g => {
      budget.categories.filter(c => c.groupId === g.id && !c.archived && !c.creditCardId).forEach(c => {
        opts.push({ value: c.id, label: c.name, group: g.name });
      });
    });
  } else {
    budget.categoryGroups.forEach(g => {
      budget.categories.filter(c => c.groupId === g.id && !c.archived).forEach(c => {
        opts.push({ value: c.id, label: c.name, group: g.name });
      });
    });
  }
  return opts;
};

// ── CSV helpers ──
const parseCSV = (text) => {
  const rows = []; let row = [], field = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false; }
      else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { row.push(field); field = ""; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(field); field = "";
        if (row.length > 1 || row[0] !== "") rows.push(row);
        row = [];
      } else field += c;
    }
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
};
const parseCSVDate = (s) => {
  s = (s || "").trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
};
const parseCSVAmount = (s) => { const v = parseFloat(String(s || "").replace(/[$,]/g, "").trim()); return isNaN(v) ? 0 : v; };
// Best-effort guess at column mapping based on common bank CSV header names.
const guessColumnMapping = (headers) => {
  const norm = headers.map(h => (h || "").trim().toLowerCase());
  const find = (...keywords) => {
    for (const kw of keywords) {
      const idx = norm.findIndex(h => h === kw);
      if (idx >= 0) return headers[idx];
    }
    for (const kw of keywords) {
      const idx = norm.findIndex(h => h.includes(kw));
      if (idx >= 0) return headers[idx];
    }
    return "";
  };
  const dateCol = find("date", "transaction date", "posted date", "posting date");
  const payeeCol = find("description", "payee", "merchant", "name", "memo", "details");
  const debitCol = find("debit", "withdrawal", "withdrawals");
  const creditCol = find("credit", "deposit", "deposits");
  const amountCol = find("amount", "amt");
  if (debitCol && creditCol) {
    return { dateCol, payeeCol, amountMode: "split", debitCol, creditCol, amountCol: "", signConvention: "neg-expense" };
  }
  return { dateCol, payeeCol, amountMode: "single", amountCol, signConvention: "neg-expense", debitCol: "", creditCol: "" };
};

const toKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
const keyLabel = (k) => { const [y, m] = k.split("-").map(Number); return new Date(y, m - 1, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" }); };
const keyLabelShort = (k) => { const [y, m] = k.split("-").map(Number); return new Date(y, m - 1, 1).toLocaleDateString("en-US", { month: "short", year: "numeric" }); };
const prevKey = (k) => { const [y, m] = k.split("-").map(Number); return toKey(new Date(y, m - 2, 1)); };
const nextKey = (k) => { const [y, m] = k.split("-").map(Number); return toKey(new Date(y, m, 1)); };
// Returns the first and last calendar-day date strings (YYYY-MM-DD) for a month key.
const monthDateRange = (k) => {
  const [y, m] = k.split("-").map(Number);
  const last = new Date(y, m, 0).getDate();
  return { from: `${k}-01`, to: `${k}-${String(last).padStart(2, "0")}` };
};
const evalMath = (expr) => {
  const str = String(expr).trim(); if (!str) return 0;
  const safe = str.replace(/[^0-9+\-*/.() ]/g, ""); if (!safe) return 0;
  try { const r = Function('"use strict"; return (' + safe + ')')(); if (typeof r !== "number" || isNaN(r) || !isFinite(r)) return parseFloat(str) || 0; return Math.round(r * 100) / 100; } catch { return parseFloat(str) || 0; }
};
const hasOp = (s) => /[+\-*/]/.test(String(s).replace(/^\s*-?\s*/, ""));

// ── Colors ───────────────────────────────────────────────────
const C = {
  navy: "#1A2B4A", green: "#27AE60", greenLight: "#5DDF9A",
  red: "#E74C3C", gold: "#D4A853", purple: "#7B5EE8", amber: "#F39C12",
  bg: "#F0EEE9", surface: "#FFFFFF", border: "#E5E2DC",
  muted: "#9590A0", text: "#1A2035", textLight: "#6A6575", inputBg: "#FAFAF8",
};

// ── Shared UI ────────────────────────────────────────────────
const inputSt = { width: "100%", padding: "10px 12px", border: `1.5px solid ${C.border}`, borderRadius: 8, fontSize: 15, fontFamily: "inherit", boxSizing: "border-box", outline: "none", background: C.inputBg, color: C.text };

const Btn = ({ color = C.navy, onClick, children, style, disabled, outline, small, btnRef }) => (
  <button ref={btnRef} onClick={onClick} disabled={disabled} style={{ background: outline ? "transparent" : disabled ? "#ccc" : color, color: outline ? color : "#fff", border: outline ? `2px solid ${color}` : "none", borderRadius: 7, padding: small ? "6px 12px" : "9px 18px", fontSize: small ? 12 : 14, fontWeight: 700, cursor: disabled ? "not-allowed" : "pointer", fontFamily: "inherit", opacity: disabled ? 0.6 : 1, whiteSpace: "nowrap", ...style }}>{children}</button>
);

const IconBtn = ({ onClick, children, disabled, active }) => (
  <button onClick={onClick} disabled={disabled} style={{ background: active ? C.navy : "none", border: `1.5px solid ${disabled ? C.border : active ? C.navy : C.muted}`, borderRadius: 7, width: 30, height: 30, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, color: disabled ? C.border : active ? "#fff" : C.textLight, cursor: disabled ? "not-allowed" : "pointer", fontFamily: "inherit", padding: 0, flexShrink: 0 }}>{children}</button>
);

const Field = ({ label, children }) => (
  <div style={{ marginBottom: 14, width: "100%", minWidth: 0, boxSizing: "border-box" }}>
    {label && <label style={{ display: "block", fontSize: 11, fontWeight: 700, color: C.muted, marginBottom: 5, textTransform: "uppercase", letterSpacing: "0.07em" }}>{label}</label>}
    {children}
  </div>
);

const Inp = ({ label, inputRef, ...props }) => <Field label={label}><input ref={inputRef} style={inputSt} autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false} {...props} /></Field>;
const Sel = ({ label, children, ...props }) => <Field label={label}><select style={{ ...inputSt, background: C.inputBg }} {...props}>{children}</select></Field>;

// Searchable dropdown — renders a text input that filters a flat list of {value, label, group?} options.
// `group` is an optional string used to render optgroup-style section headers.
// Falls back gracefully: if fewer than 6 options, just renders a plain <Sel>.
function SearchableSel({ label, value, onChange, options, placeholder = "Search...", disabled, autoOpen }) {
  const [open, setOpen] = useState(!!autoOpen);
  const [q, setQ] = useState("");
  const inputRef = useRef(null);
  const containerRef = useRef(null);
  const selected = options.find(o => o.value === value);

  // Close on outside click/touch — delay when autoOpen to avoid catching the triggering tap
  useEffect(() => {
    if (!open) return;
    const attach = () => {
      const handler = (e) => { if (containerRef.current && !containerRef.current.contains(e.target)) setOpen(false); };
      document.addEventListener("mousedown", handler);
      document.addEventListener("touchstart", handler);
      return () => { document.removeEventListener("mousedown", handler); document.removeEventListener("touchstart", handler); };
    };
    if (autoOpen) {
      const t = setTimeout(attach, 300);
      return () => clearTimeout(t);
    }
    return attach();
  }, [open]);

  useEffect(() => { if (open && inputRef.current) inputRef.current.focus(); }, [open]);

  if (options.length < 6) {
    const el = <select style={{ ...inputSt, background: C.inputBg }} value={value} onChange={e => onChange(e.target.value)} disabled={disabled}>
      {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>;
    return label ? <Field label={label}>{el}</Field> : el;
  }

  const qLow = q.trim().toLowerCase();
  const filtered = qLow ? options.filter(o => o.label.toLowerCase().includes(qLow) || (o.group || "").toLowerCase().includes(qLow)) : options;

  const groups = [];
  filtered.forEach(o => {
    const g = o.group || "";
    let grp = groups.find(x => x.label === g);
    if (!grp) { grp = { label: g, items: [] }; groups.push(grp); }
    grp.items.push(o);
  });

  // Dropdown renders at top of viewport via fixed overlay
  const el = (
    <div ref={containerRef} style={{ position: "relative", width: "100%" }}>
      <button type="button" onClick={() => { setOpen(p => !p); setQ(""); }} disabled={disabled}
        style={{ ...inputSt, textAlign: "left", cursor: "pointer", color: selected ? C.text : C.muted, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 12px" }}>
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{selected ? selected.label : (placeholder || "Select...")}</span>
        <span style={{ fontSize: 10, color: C.muted, marginLeft: 6, flexShrink: 0 }}>{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div style={{ position: "fixed", top: 0, left: 0, right: 0, bottom: 0, zIndex: 9000, background: "rgba(0,0,0,0.35)", display: "flex", flexDirection: "column" }}
          onMouseDown={e => { if (e.target === e.currentTarget) setOpen(false); }}
          onTouchStart={e => { if (e.target === e.currentTarget) setOpen(false); }}>
          <div style={{ background: C.surface, borderBottom: `1.5px solid ${C.navy}`, boxShadow: "0 4px 24px rgba(0,0,0,0.18)", display: "flex", flexDirection: "column", maxHeight: "60vh" }}>
            <div style={{ padding: "8px 10px", borderBottom: `1px solid ${C.border}`, flexShrink: 0, display: "flex", alignItems: "center", gap: 8 }}>
              <input ref={inputRef} value={q} onChange={e => setQ(e.target.value)} placeholder={placeholder}
                style={{ ...inputSt, flex: 1, padding: "8px 12px", fontSize: 14 }} onClick={e => e.stopPropagation()}
                autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false} />
              <button onClick={() => setOpen(false)} style={{ background: "none", border: "none", color: C.muted, fontSize: 20, cursor: "pointer", padding: "0 4px", flexShrink: 0 }}>×</button>
            </div>
            <div style={{ overflowY: "auto", flex: 1 }}>
              {filtered.length === 0 ? (
                <div style={{ padding: "14px 16px", fontSize: 14, color: C.muted }}>No matches</div>
              ) : groups.map(grp => (
                <div key={grp.label}>
                  {grp.label && <div style={{ padding: "8px 14px 3px", fontSize: 10, fontWeight: 700, color: C.muted, textTransform: "uppercase", letterSpacing: "0.06em", background: "#F8F6F2" }}>{grp.label}</div>}
                  {grp.items.map(o => (
                    <button key={o.value} type="button" onClick={() => { onChange(o.value); setOpen(false); setQ(""); }}
                      style={{ display: "block", width: "100%", textAlign: "left", padding: "11px 16px", background: o.value === value ? "#EAF6F0" : "none", border: "none", fontSize: 14, color: o.value === value ? C.green : C.text, cursor: "pointer", fontFamily: "inherit", fontWeight: o.value === value ? 700 : 400, borderBottom: `1px solid #F4F1EB` }}>
                      {o.label}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
  return label ? <Field label={label}>{el}</Field> : el;
}

// "$1,234.56" style display for a plain numeric string ("1234.5", "-12", "10.", etc).
// "" and "-" pass through unchanged so placeholders/lone-minus show correctly.
const formatPlainAmount = (s) => {
  if (s === "" || s === "-") return s;
  const neg = s.startsWith("-");
  const body = neg ? s.slice(1) : s;
  const dotIdx = body.indexOf(".");
  const ip = dotIdx === -1 ? body : body.slice(0, dotIdx);
  const dp = dotIdx === -1 ? undefined : body.slice(dotIdx + 1);
  const intFmt = Number(ip || "0").toLocaleString("en-US");
  return (neg ? "-" : "") + "$" + intFmt + (dp !== undefined ? "." + dp : "");
};
// Cleans free-typed text down to a plain numeric string: optional leading "-",
// digits, at most one ".", and at most 2 digits after it.
const cleanPlainAmount = (cleaned) => {
  const neg = cleaned.startsWith("-");
  let body = cleaned.replace(/-/g, "").replace(/[^0-9.]/g, "");
  const dotIdx = body.indexOf(".");
  if (dotIdx !== -1) {
    const ip = body.slice(0, dotIdx);
    const dp = body.slice(dotIdx + 1).replace(/\./g, "").slice(0, 2);
    body = ip + "." + dp;
  }
  return (neg ? "-" : "") + body;
};

// ── Custom number pad for touch devices ──────────────────────────────────────
// Replaces the native keyboard for all AmountInput fields on touch devices.
// Shows a calculator-style pad fixed at the bottom, with operator support.
const AmountPadContext = React.createContext(null);

// Touch detection — computed once
const IS_TOUCH = typeof window !== "undefined" && ("ontouchstart" in window || navigator.maxTouchPoints > 0);

function AmountPadProvider({ children }) {
  const [state, setState] = useState({ visible: false, fieldId: null, raw: "", isFirstKey: true, label: "", sign: null, onToggleSign: null, lastCommit: null });
  const cbRef = useRef({ onChange: null });

  const openPad = useCallback((fieldId, initialRaw, fieldLabel, sign, onToggleSign, onChange) => {
    cbRef.current = { onChange: onChange || null };
    setState({ visible: true, fieldId, raw: initialRaw || "", isFirstKey: true, label: fieldLabel || "", sign: sign || null, onToggleSign: onToggleSign || null, lastCommit: null });
  }, []);

  const setPadState = useCallback((updater) => setState(updater), []);
  const closePad = useCallback(() => setState(p => ({ ...p, visible: false, fieldId: null })), []);
  const flipSign = useCallback(() => setState(p => ({ ...p, sign: p.sign === "−" ? "+" : p.sign === "+" ? "−" : p.sign })), []);

  const setRaw = useCallback((updater) =>
    setState(p => {
      const next = typeof updater === "function" ? updater(p.raw) : updater;
      if (cbRef.current.onChange && !hasOp(next)) cbRef.current.onChange(parseFloat(next) || 0);
      return { ...p, raw: next };
    }), []);

  // commitPad: sets lastCommit signal that AmountInput watches, then closes
  const commitPad = useCallback((fieldId, val) => {
    setState(p => ({ ...p, visible: false, fieldId: null, lastCommit: { fieldId, value: val, ts: Date.now() } }));
  }, []);

  const ctx = { ...state, openPad, closePad, commitPad, setRaw, flipSign, setPadState, cbRef };

  // Physical keyboard support: when pad is visible, route keypresses into pad state.
  // Works on touchscreen web (iPad, Surface, etc.) where the custom pad shows
  // but the user also has a physical keyboard.
  const stateRef = useRef(state);
  stateRef.current = state;
  useEffect(() => {
    if (!state.visible) return;
    const onKey = (e) => {
      const s = stateRef.current;
      const raw = s.raw;
      const isFirstKey = s.isFirstKey;
      const fieldId = s.fieldId;

      const pressKey = (val) => {
        setState(p => {
          let newRaw;
          if (p.isFirstKey) {
            const isOp = /[+\-*/]/.test(val);
            newRaw = isOp ? (p.raw + val) : (val === "." ? "0." : val);
          } else if (val === "BACK") {
            newRaw = p.raw.slice(0, -1);
          } else {
            newRaw = p.raw + val;
          }
          if (cbRef.current.onChange && !hasOp(newRaw)) cbRef.current.onChange(parseFloat(newRaw) || 0);
          return { ...p, isFirstKey: false, raw: newRaw };
        });
      };

      if (e.key >= "0" && e.key <= "9") { e.preventDefault(); pressKey(e.key); }
      else if (e.key === ".") { e.preventDefault(); pressKey("."); }
      else if (e.key === "+") { e.preventDefault(); pressKey("+"); }
      else if (e.key === "-") { e.preventDefault(); pressKey("-"); }
      else if (e.key === "*") { e.preventDefault(); pressKey("*"); }
      else if (e.key === "/") { e.preventDefault(); pressKey("/"); }
      else if (e.key === "Backspace") { e.preventDefault(); pressKey("BACK"); }
      else if (e.key === "Enter" || e.key === "Return") {
        e.preventDefault();
        const cur = stateRef.current;
        const val = hasOp(cur.raw) ? (evalMath(cur.raw) || 0) : (parseFloat(cur.raw) || 0);
        commitPad(cur.fieldId, val);
      }
      else if (e.key === "Escape") { e.preventDefault(); closePad(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state.visible]);

  return (
    <AmountPadContext.Provider value={ctx}>
      {children}
      {IS_TOUCH && state.visible && <CustomNumberPad ctx={ctx} />}
    </AmountPadContext.Provider>
  );
}

function CustomNumberPad({ ctx }) {
  const { raw, setRaw, closePad, commitPad, label, sign, onToggleSign, isFirstKey, setPadState, cbRef, fieldId: padFieldId } = ctx;
  const isMath = hasOp(raw);
  const preview = isMath && raw.trim() ? evalMath(raw) : null;
  const displayRaw = isMath ? `$${raw}` : (raw ? formatPlainAmount(raw) : "");

  const press = (val) => {
    if (isFirstKey) {
      const isOp = /[+\-*/]/.test(val);
      const newRaw = isOp ? (raw + val) : (val === "." ? "0." : val);
      setPadState(p => ({ ...p, isFirstKey: false, raw: newRaw }));
      const cb = cbRef?.current;
      if (cb?.onChange && !hasOp(newRaw)) cb.onChange(parseFloat(newRaw) || 0);
      return;
    }
    setRaw(prev => {
      const opMatch = prev.match(/[+\-*/](?=[^+\-*/]*$)/);
      const segment = opMatch ? prev.slice(prev.lastIndexOf(opMatch[0]) + 1) : prev;
      if (val === ".") {
        if (segment.includes(".")) return prev;
        return prev + val;
      }
      if (/[0-9]/.test(val)) {
        const dotIdx = segment.indexOf(".");
        if (dotIdx !== -1 && segment.length - dotIdx > 2) return prev;
      }
      return (prev + val).replace(/[^0-9+\-*/.()]/g, "");
    });
  };

  const backspace = () => setRaw(prev => prev.slice(0, -1));
  const clear = () => { setRaw(""); cbRef?.current?.onChange?.(0); };

  const done = () => {
    const val = isMath ? (evalMath(raw) || 0) : (parseFloat(raw) || 0);
    commitPad(padFieldId, val);
  };

  // Layout matches screenshot: 7-8-9-op / 4-5-6-op / 1-2-3-op / .-0-⌫-op / Clear-Done
  const rows = [
    [["7","7"],["8","8"],["9","9"],["÷","/"]],
    [["4","4"],["5","5"],["6","6"],["×","*"]],
    [["1","1"],["2","2"],["3","3"],["−","-"]],
    [[".","."],[  "0","0"],["⌫","BACK"],["+","+"]],
  ];

  const btnBase = { height: 56, border: "none", cursor: "pointer", fontFamily: "inherit", fontSize: 22, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", WebkitTapHighlightColor: "transparent", userSelect: "none" };
  const numStyle = { ...btnBase, background: "#AEB6C4", color: C.navy };
  const opStyle  = { ...btnBase, background: C.navy, color: "#fff" };
  const backStyle = { ...btnBase, background: "#8A93A6", color: "#fff", fontSize: 20 };

  return (
    <>
      {/* Full-screen backdrop — sits above the modal, below the pad. Catches all touches
          outside the pad so they never reach the modal. Tapping it commits (acts like Done). */}
      <div style={{ position: "fixed", inset: 0, zIndex: 9998, background: "transparent" }}
        onPointerDown={e => { e.preventDefault(); e.stopPropagation(); done(); }} />
      <div style={{ position: "fixed", bottom: 0, left: 0, right: 0, zIndex: 9999, background: "#8A93A6", paddingBottom: "env(safe-area-inset-bottom, 0px)", boxShadow: "0 -2px 12px rgba(0,0,0,0.18)" }}
        onPointerDown={e => e.stopPropagation()}
        onClick={e => e.stopPropagation()}>
      {/* Mirror display — label, optional +/- toggle, current value, discard */}
      <div style={{ background: C.surface, padding: "8px 16px 10px", borderBottom: `1px solid ${C.border}` }}>
        {label && <div style={{ fontSize: 10, fontWeight: 800, color: C.muted, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 4 }}>{label}</div>}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flex: 1, minWidth: 0 }}>
            {/* +/- toggle (interactive) or static sign */}
            {(sign || onToggleSign) && (
              onToggleSign
                ? <button onPointerDown={e => { e.preventDefault(); onToggleSign(); }}
                    style={{ width: 40, height: 40, borderRadius: 8, border: `2px solid ${C.navy}`, background: sign === "+" ? C.green : C.red, color: "#fff", fontSize: 22, fontWeight: 900, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, fontFamily: "inherit" }}>
                    {sign}
                  </button>
                : <span style={{ fontSize: 24, fontWeight: 800, color: C.muted, flexShrink: 0 }}>{sign}</span>
            )}
            {/* Value — shrinks and wraps for long math expressions */}
            <div style={{
              fontSize: raw.length > 16 ? 16 : raw.length > 10 ? 22 : 28,
              fontWeight: 800, color: raw ? C.navy : C.muted, fontFamily: "inherit",
              letterSpacing: "-0.5px", overflowWrap: "break-word", wordBreak: "break-all",
              flex: 1, minWidth: 0,
            }}>
              {displayRaw || <span style={{ fontWeight: 400, fontSize: 20, color: C.muted }}>0.00</span>}
            </div>
            {/* Math preview — dark text, not green */}
            {preview !== null && preview !== (parseFloat(raw) || 0) && (
              <div style={{ fontSize: 15, color: C.text, fontWeight: 800, flexShrink: 0 }}>= {fmt(preview)}</div>
            )}
          </div>
          {/* Discard */}
          <button onPointerDown={e => { e.preventDefault(); e.stopPropagation(); closePad(); }}
            style={{ width: 36, height: 36, borderRadius: 18, border: `1.5px solid ${C.border}`, background: C.surface, color: C.muted, fontSize: 16, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, marginLeft: 8, fontFamily: "inherit" }}>
            ✕
          </button>
        </div>
      </div>
      {/* Key grid */}
      <div style={{ display: "grid", gap: 1 }}>
        {rows.map((row, ri) => (
          <div key={ri} style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 1 }}>
            {row.map(([label, val]) => {
              const isOp = ["/","*","-","+"].includes(val);
              const isBack = val === "BACK";
              return (
                <button key={label}
                  onPointerDown={e => { e.preventDefault(); e.stopPropagation(); isBack ? backspace() : press(val); }}
                  style={isOp ? opStyle : isBack ? backStyle : numStyle}>
                  {label}
                </button>
              );
            })}
          </div>
        ))}
        {/* Clear / Done row */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 1 }}>
          <button onPointerDown={e => { e.preventDefault(); e.stopPropagation(); clear(); }}
            style={{ ...btnBase, background: "#8A93A6", color: "#fff", fontSize: 17 }}>
            Clear
          </button>
          <button onPointerDown={e => { e.preventDefault(); e.stopPropagation(); done(); }}
            style={{ ...btnBase, background: C.green, color: "#fff", fontSize: 17, fontWeight: 800 }}>
            ✓  Done
          </button>
        </div>
      </div>
    </div>
    </>
  );
}


function AmountInput({ label, initialValue, onCommit, onChange, onCancel, onKeyDown, autoFocus, style, placeholder, signPrefix, signColor, onToggleSign, disabled }) {
  const initRaw = (v) => (v === undefined || v === 0 || isNaN(v)) ? "" : String(Math.round(v * 100) / 100);
  const [raw, setRaw] = useState(() => initRaw(initialValue));
  useEffect(() => { setRaw(initRaw(initialValue)); }, [initialValue]);
  const fieldId = useRef(`amtf-${Math.random().toString(36).slice(2)}`).current;
  const padCtx = useContext(AmountPadContext);
  const isActiveInPad = IS_TOUCH && padCtx?.visible && padCtx?.fieldId === fieldId;

  const isMath = hasOp(raw);
  const preview = isMath && raw.trim() ? evalMath(raw) : null;
  // On touch: when pad is active show pad's raw; when pad is closed show initialValue
  // (initialValue is updated by onChange/onCommit in the same batch as closePad)
  const displayValue = isActiveInPad
    ? (hasOp(padCtx.raw) ? padCtx.raw : formatPlainAmount(padCtx.raw))
    : IS_TOUCH
      ? formatPlainAmount(initRaw(initialValue))
      : (isMath ? raw : formatPlainAmount(raw));

  const handleChange = (e) => {
    const cleaned = e.target.value.replace(/[$,]/g, "");
    const newRaw = hasOp(cleaned) ? cleaned.replace(/[^0-9+\-*/.() ]/g, "") : cleanPlainAmount(cleaned);
    setRaw(newRaw);
    const newDisplay = hasOp(newRaw) ? newRaw : formatPlainAmount(newRaw);
    if (e.target.value !== newDisplay) e.target.value = newDisplay;
    try { e.target.setSelectionRange(newDisplay.length, newDisplay.length); } catch {}
    if (onChange && !hasOp(newRaw)) onChange(parseFloat(newRaw) || 0);
  };

  const commit = () => {
    const r = isMath ? evalMath(raw) : (parseFloat(raw) || 0);
    if (onCommit) onCommit(r);
    setRaw(r !== 0 ? r.toFixed(2) : "");
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter") { e.preventDefault(); commit(); if (onKeyDown) onKeyDown(e); return; }
    if (e.key === "Escape" && onCancel) onCancel();
  };

  // Watch for commit signal from the pad — fires when Done is tapped
  useEffect(() => {
    const lc = padCtx?.lastCommit;
    if (!lc || lc.fieldId !== fieldId) return;
    const val = lc.value;
    const r = val !== 0 ? String(Math.round(val * 100) / 100) : "";
    setRaw(r);
    if (onChange) onChange(val);
    if (onCommit) onCommit(val);
  }, [padCtx?.lastCommit]);
  const handleTouchActivate = (e) => {
    if (!IS_TOUCH || !padCtx) return;
    if (e?.preventDefault) e.preventDefault();
    padCtx.openPad(fieldId, raw, label || "Amount", signPrefix || null,
      onToggleSign ? () => { onToggleSign(); padCtx.flipSign(); } : null,
      onChange || null
    );
  };

  let inputEl;
  if (IS_TOUCH) {
    const touchStyle = signPrefix
      ? { border: "none", outline: "none", background: "transparent", flex: 1, fontSize: "inherit", fontFamily: "inherit", color: isActiveInPad ? C.navy : "inherit", padding: 0, minWidth: 0, cursor: "pointer", WebkitUserSelect: "none", userSelect: "none" }
      : { ...(style || inputSt), cursor: "pointer", WebkitUserSelect: "none", userSelect: "none", display: "flex", alignItems: "center", justifyContent: style?.textAlign === "right" ? "flex-end" : "flex-start" };
    inputEl = (
      <div
        tabIndex={disabled ? -1 : 0}
        onClick={disabled ? undefined : handleTouchActivate}
        onFocus={disabled ? undefined : handleTouchActivate}
        style={touchStyle}
      >
        {displayValue || <span style={{ opacity: 0.4 }}>{placeholder || "0.00"}</span>}
      </div>
    );
  } else {
    inputEl = <input autoFocus={autoFocus} value={displayValue} inputMode="text"
      autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false} disabled={disabled}
      onChange={handleChange} onBlur={commit} onKeyDown={handleKeyDown}
      placeholder={placeholder || "0.00"}
      style={signPrefix ? { border: "none", outline: "none", background: "transparent", flex: 1, fontSize: "inherit", fontFamily: "inherit", color: "inherit", padding: 0, minWidth: 0 } : (style || inputSt)} />;
  }

  const el = signPrefix ? (
    <div style={{ ...inputSt, display: "flex", alignItems: "center", gap: 6, ...style, ...(IS_TOUCH ? { border: "none", background: "transparent", boxShadow: "none", padding: 0 } : {}) }}>
      <span style={{ fontWeight: 800, fontSize: 16, color: signColor || C.text, flexShrink: 0 }}>{signPrefix}</span>
      {inputEl}
    </div>
  ) : (
    <div style={{ width: "100%" }}>
      {inputEl}
      {!IS_TOUCH && preview !== null && <div style={{ fontSize: 12, color: C.green, fontWeight: 700, marginTop: 3, textAlign: style ? "right" : "left", paddingLeft: 2 }}>= {fmt(preview)}</div>}
    </div>
  );
  return label ? <Field label={label}>{el}</Field> : el;
}

const Card = ({ children, style, ...rest }) => <div style={{ background: C.surface, borderRadius: 12, padding: 16, marginBottom: 12, border: `1px solid ${C.border}`, ...style }} {...rest}>{children}</div>;

const Modal = ({ title, onClose, children, closeLabel }) => (
  <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 200, padding: 16, boxSizing: "border-box" }}>
    <div style={{ background: C.surface, borderRadius: 16, padding: "24px 20px", width: "100%", maxWidth: 500, boxShadow: "0 8px 40px rgba(0,0,0,0.25)", maxHeight: "85vh", overflowY: "auto", overflowX: "hidden", boxSizing: "border-box" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
        <div style={{ fontSize: 18, fontWeight: 800, color: C.text }}>{title}</div>
        <button onClick={onClose} style={{ background: "none", border: `1.5px solid ${C.border}`, cursor: "pointer", fontSize: 13, fontWeight: 700, color: C.muted, padding: "4px 10px", borderRadius: 6, fontFamily: "inherit" }}>
          {closeLabel || "✕"}
        </button>
      </div>
      {children}
    </div>
  </div>
);

const BtnRow = ({ onCancel, onSave, saveLabel, saveColor = C.navy, disabled, saveBtnRef }) => (
  <div style={{ display: "flex", gap: 10, marginTop: 20 }}>
    <Btn outline color={C.muted} onClick={onCancel} style={{ minWidth: 90 }}>Cancel</Btn>
    <Btn color={saveColor} onClick={onSave} disabled={disabled} style={{ flex: 1 }} btnRef={saveBtnRef}>{saveLabel}</Btn>
  </div>
);

// ── Context Menu ─────────────────────────────────────────────
function ContextMenu({ items, onClose }) {
  const menuW = 220;
  const noSelect = { WebkitTouchCallout: "none", WebkitUserSelect: "none", userSelect: "none" };
  return (
    <div onClick={onClose} onContextMenu={e => { e.preventDefault(); onClose(); }} style={{ position: "fixed", inset: 0, zIndex: 250, background: "rgba(0,0,0,0.25)", display: "flex", alignItems: "center", justifyContent: "center", ...noSelect }}>
      <div onClick={e => e.stopPropagation()} style={{ background: C.surface, borderRadius: 10, boxShadow: "0 6px 24px rgba(0,0,0,0.25)", overflow: "hidden", width: menuW, border: `1px solid ${C.border}`, ...noSelect }}>
        {items.map((item, i) => (
          <button key={i} disabled={item.disabled}
            onClick={(e) => { e.stopPropagation(); if (!item.disabled) { item.onClick(); onClose(); } }}
            style={{ display: "block", width: "100%", textAlign: "left", padding: "14px 18px", background: "none", border: "none", borderBottom: `1px solid ${C.border}`, fontSize: 14, fontFamily: "inherit", color: item.danger ? C.red : (item.disabled ? C.muted : C.text), cursor: item.disabled ? "default" : "pointer", opacity: item.disabled ? 0.5 : 1, ...noSelect }}>
            {item.label}
          </button>
        ))}
        <button onClick={e => { e.stopPropagation(); onClose(); }}
          style={{ display: "block", width: "100%", textAlign: "center", padding: "14px 18px", background: "none", border: "none", fontSize: 14, fontWeight: 700, fontFamily: "inherit", color: C.muted, cursor: "pointer", ...noSelect }}>
          Cancel
        </button>
      </div>
    </div>
  );
}

// Build a flat options array for SearchableSel from budget category groups.
// Adds an empty "Select..." option at the top, then one entry per non-archived category.
const buildCatOptions = (categoryGroups, categories, { includeEmpty = true, emptyLabel = "Select...", includeRTA = false } = {}) => {
  const opts = [];
  if (includeEmpty) opts.push({ value: "", label: emptyLabel });
  if (includeRTA) opts.push({ value: "__rta__", label: "Ready to Assign", group: "" });
  categoryGroups.forEach(g => {
    categories.filter(c => c.groupId === g.id && !c.archived).forEach(c => {
      opts.push({ value: c.id, label: c.name, group: g.name });
    });
  });
  return opts;
};
const buildAccountOptions = (accounts, creditCards, { includeEmpty = true, emptyLabel = "Select..." } = {}) => {
  const opts = [];
  if (includeEmpty) opts.push({ value: "", label: emptyLabel });
  accounts.filter(a => !a.archived).forEach(a => opts.push({ value: a.id, label: a.name, group: "Cash & Bank Accounts" }));
  creditCards.filter(c => !c.archived).forEach(c => opts.push({ value: c.id, label: c.name, group: "Credit Cards" }));
  return opts;
};
const getGoalMetrics = (cat, available, budgetedThisMonth, month) => {
  if (!cat?.goal?.type) return null;
  const { type, target, targetDate } = cat.goal;
  const tgt = target || 0;
  if (type === "savings") { const p = tgt > 0 ? Math.min(100, (available / tgt) * 100) : 0; return { type, target: tgt, current: available, progress: p, complete: available >= tgt }; }
  if (type === "monthly") { const needed = Math.max(0, tgt - budgetedThisMonth); return { type, target: tgt, budgeted: budgetedThisMonth, needed, underfunded: budgetedThisMonth < tgt }; }
  if (type === "date" && targetDate) {
    const [ty, tm] = targetDate.split("-").map(Number); const [cy, cm] = month.split("-").map(Number);
    const monthsLeft = Math.max(1, (ty - cy) * 12 + (tm - cm));
    const stillNeeded = Math.max(0, tgt - available);
    const monthlyNeeded = Math.round((stillNeeded / monthsLeft) * 100) / 100;
    const complete = available >= tgt; const onTrack = complete || budgetedThisMonth >= monthlyNeeded;
    return { type, target: tgt, current: available, monthsLeft, monthlyNeeded, onTrack, complete };
  }
  return null;
};

// ── Rollover Picker ──────────────────────────────────────────
const ROLLOVER_OPTS = [
  { value: "rollover", title: "Roll Over", desc: "Leftover carries into next month" },
  { value: "return", title: "Return to Ready to Assign", desc: "Leftover returns to your unassigned pool" },
  { value: "max", title: "Roll Over up to a Maximum", desc: "Excess above the limit returns to Ready to Assign" },
];

function RolloverPicker({ value, onChange, rolloverMax, onMaxChange }) {
  return (
    <div>
      <Field label="Rollover Behavior">
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {ROLLOVER_OPTS.map(opt => (
            <label key={opt.value} style={{ display: "flex", alignItems: "flex-start", gap: 10, cursor: "pointer", padding: "10px 12px", borderRadius: 8, background: value === opt.value ? "#EAF6F0" : "#F8F6F2", border: `1.5px solid ${value === opt.value ? C.green : "transparent"}` }}>
              <input type="radio" value={opt.value} checked={value === opt.value} onChange={() => onChange(opt.value)} style={{ marginTop: 3 }} />
              <div><div style={{ fontSize: 13, fontWeight: 700 }}>{opt.title}</div><div style={{ fontSize: 12, color: C.textLight, marginTop: 2 }}>{opt.desc}</div></div>
            </label>
          ))}
        </div>
      </Field>
      {value === "max" && <AmountInput label="Maximum rollover ($)" initialValue={rolloverMax || undefined} onCommit={onMaxChange} placeholder="e.g. 200" />}
    </div>
  );
}

// ── Move Money Modal ─────────────────────────────────────────
function MoveMoneyModal({ budget, month, initialFrom, initialTo, rtaAvailable, getAvail, onMove, onClose }) {
  const RTA = "__rta__";
  const [fromId, setFromId] = useState(initialFrom !== undefined ? (initialFrom === null ? RTA : initialFrom) : RTA);
  const [toId, setToId] = useState(initialTo !== undefined && initialTo !== null ? initialTo : "");
  const [amount, setAmount] = useState(0);
  const [error, setError] = useState("");
  useEffect(() => { if (initialTo && initialFrom === null) { const av = getAvail(initialTo, month); if (av < 0) setAmount(Math.abs(av)); } }, []);
  const fromAvail = fromId === RTA ? rtaAvailable : getAvail(fromId, month);
  const handleMove = () => {
    if (!toId || fromId === toId || !amount) return;
    if (amount > Math.max(0, fromAvail) + 0.001) { setError(`Only ${fmt(Math.max(0, fromAvail))} available.`); return; }
    onMove(fromId === RTA ? null : fromId, toId === RTA ? null : toId, amount); onClose();
  };
  return (
    <Modal title="Move Money" onClose={onClose}>
      <Sel label="From" value={fromId} onChange={e => { setFromId(e.target.value); setError(""); }}>
        <option value={RTA}>Ready to Assign ({fmt(Math.max(0, rtaAvailable))})</option>
        {budget.categoryGroups.map(g => (
          <optgroup key={g.id} label={g.name}>
            {budget.categories.filter(c => c.groupId === g.id && !c.archived).map(c => { const av = getAvail(c.id, month); return <option key={c.id} value={c.id} disabled={av <= 0}>{c.name} ({fmt(av)})</option>; })}
          </optgroup>
        ))}
      </Sel>
      <Sel label="To" value={toId} onChange={e => { setToId(e.target.value); setError(""); }}>
        <option value="">Select destination...</option>
        <option value={RTA}>Ready to Assign</option>
        {budget.categoryGroups.map(g => (
          <optgroup key={g.id} label={g.name}>
            {budget.categories.filter(c => c.groupId === g.id && !c.archived && c.id !== fromId).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </optgroup>
        ))}
      </Sel>
      <AmountInput label={`Amount (max ${fmt(Math.max(0, fromAvail))})`} initialValue={amount || undefined} onChange={v => { setAmount(v); setError(""); }} onCommit={v => { setAmount(v); setError(""); }} autoFocus />
      {error && <div style={{ fontSize: 12, color: C.red, marginBottom: 8, marginTop: -8 }}>{error}</div>}
      <BtnRow onCancel={onClose} onSave={handleMove} saveLabel="Move Money" saveColor={C.purple} disabled={!toId || !amount || fromId === toId} />
    </Modal>
  );
}

// ── Reconcile Modal ──────────────────────────────────────────
// Finds a subset of transactions whose SIGNED amounts sum to `target` (the gap to close),
// using a dynamic-programming subset-sum over integer cents. Handles mixed inflow/outflow
// signs correctly. Prefers subsets favoring the most recent transactions, and among those
// the fewest transactions. Returns an array of tx ids, or null if no exact subset exists.
//
// `target` is the signed gap: realBalance - computedBalance. Unchecking a transaction
// changes the adjusted balance by -(its signed amount), so we need a subset of signed
// amounts summing to (computedBalance - realBalance) = -target. We search for that.
function findUnclearedSuggestion(txList, target) {
  const round2 = (v) => Math.round(v * 100) / 100;
  // We want subset of signed amounts summing to need = -(target) in cents.
  const needCents = Math.round(-target * 100);
  if (needCents === 0) return null;

  // Sort most-recent-first so reconstruction prefers recent transactions.
  const sorted = [...txList].sort((a, b) => b.date.localeCompare(a.date));
  const n = sorted.length;
  if (n === 0) return null;
  const cents = sorted.map(tx => Math.round(round2(Number(tx.amount)) * 100));

  // Memory guard: if the gap is enormous (> $1,000,000), skip DP and fall back to a
  // bounded recent-first greedy/combination search to avoid a large DP table.
  const MAX_GAP_CENTS = 100000000; // $1,000,000
  if (Math.abs(needCents) > MAX_GAP_CENTS) {
    return boundedComboFallback(sorted, cents, needCents);
  }

  // Time guard: bail out if solving exceeds the budget.
  const startTime = Date.now();
  const TIME_BUDGET_MS = 150;

  // DP over reachable signed sums. Map<sumCents, {count, lastIdx}> tracking the best way
  // to reach each sum: fewest transactions, and we build newest-first so earlier-added
  // (more recent) transactions are preferred. We store a parent pointer for reconstruction.
  // reach: Map<sum, { idx, prevSum }> — idx is the transaction index added to get here.
  let reach = new Map();
  reach.set(0, null); // base: empty subset sums to 0

  for (let i = 0; i < n; i++) {
    if (Date.now() - startTime > TIME_BUDGET_MS) return null; // time cap
    const amt = cents[i];
    const additions = [];
    for (const [sum, info] of reach) {
      const newSum = sum + amt;
      if (!reach.has(newSum)) additions.push([newSum, { idx: i, prevSum: sum }]);
    }
    for (const [s, info] of additions) reach.set(s, info);
    if (reach.has(needCents)) break; // found it
  }

  if (!reach.has(needCents)) return null;

  // Reconstruct the subset by walking parent pointers back to 0.
  const ids = [];
  let cur = needCents;
  while (cur !== 0) {
    const info = reach.get(cur);
    if (!info) break;
    ids.push(sorted[info.idx].id);
    cur = info.prevSum;
  }
  return ids.length > 0 ? ids : null;
}

// Fallback for extreme gaps: try recent-first combinations up to a modest size so we never
// build a huge DP table. Bounded by both size and a time budget.
function boundedComboFallback(sorted, cents, needCents) {
  const n = sorted.length;
  const startTime = Date.now();
  const TIME_BUDGET_MS = 150;
  for (let size = 1; size <= Math.min(8, n); size++) {
    const combo = [];
    const search = (start, remaining) => {
      if (Date.now() - startTime > TIME_BUDGET_MS) return null;
      if (combo.length === size) return remaining === 0 ? combo.map(i => sorted[i].id) : null;
      const needed = size - combo.length;
      for (let i = start; i <= n - needed; i++) {
        combo.push(i);
        const result = search(i + 1, remaining - cents[i]);
        combo.pop();
        if (result) return result;
      }
      return null;
    };
    const result = search(0, needCents);
    if (result) return result;
  }
  return null;
}

function ReconcileModal({ name, computedBalance, isCard, transactions, isLocked, onConfirm, onClose }) {
  const todayLocal = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`; };
  const today = todayLocal();
  const [date, setDate] = useState(today);
  const [realBalance, setRealBalance] = useState(Math.abs(computedBalance));
  const [userEdited, setUserEdited] = useState(false);

  // Unreconciled = not currently locked
  const unreconciled = transactions.filter(tx => !isLocked(tx));

  // All unreconciled start checked (i.e. "cleared / include in balance")
  const [checked, setChecked] = useState(() => new Set(unreconciled.map(tx => tx.id)));
  const toggleTx = (id) => setChecked(p => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });

  // Adjusted balance = computedBalance minus the sum of unchecked transactions
  const uncheckedSum = unreconciled.filter(tx => !checked.has(tx.id)).reduce((s, tx) => s + Number(tx.amount), 0);
  const adjustedBalance = computedBalance - uncheckedSum;

  const diff = realBalance - adjustedBalance;
  const matches = Math.abs(diff) < 0.005;

  // Block if any transactions are uncategorized or unconfirmed
  // (must be after all useState calls — hooks cannot be called conditionally)
  const uncatTxs = transactions.filter(tx =>
    tx.type === "expense" && !tx.splits && (!tx.categoryId || tx.categoryConfirmed === false)
  );
  if (uncatTxs.length > 0) {
    return (
      <Modal title={`Cannot Reconcile ${name}`} onClose={onClose}>
        <div style={{ fontSize: 14, color: C.textLight, lineHeight: 1.7, marginBottom: 16 }}>
          <strong>{uncatTxs.length} transaction{uncatTxs.length !== 1 ? "s" : ""}</strong> on this account {uncatTxs.length !== 1 ? "are" : "is"} missing a category or {uncatTxs.length !== 1 ? "have" : "has"} an unconfirmed category. All transactions must be categorized and confirmed before reconciling.
        </div>
        <Btn color={C.navy} onClick={onClose} style={{ width: "100%" }}>OK — I'll Fix Them First</Btn>
      </Modal>
    );
  }
  const checkedIds = Array.from(checked);

  // When realBalance is manually changed and there's a gap, try to find a subset of
  // transactions to suggest unchecking. Reset checked to all-checked first, then compute
  // the SIGNED gap as if everything is cleared, and find which to uncheck.
  const [suggestedIds, setSuggestedIds] = useState(null);
  useEffect(() => {
    if (!userEdited) return;
    // Reset to all checked before computing suggestion
    const allChecked = new Set(unreconciled.map(tx => tx.id));
    // Signed gap assuming everything is cleared (all checked): realBalance - computedBalance
    const gap = realBalance - computedBalance;
    if (Math.abs(gap) < 0.005) {
      setSuggestedIds(null);
      setChecked(allChecked);
      return;
    }
    const suggestion = findUnclearedSuggestion(unreconciled, gap);
    setSuggestedIds(suggestion || null);
    if (suggestion) {
      const n = new Set(allChecked);
      suggestion.forEach(id => n.delete(id));
      setChecked(n);
    } else {
      setChecked(allChecked);
    }
  }, [realBalance, userEdited]); // eslint-disable-line react-hooks/exhaustive-deps

  const finish = (withDiff) => onConfirm(date, withDiff ? diff : 0, checkedIds);

  return (
    <Modal title={`Reconcile ${name}`} onClose={onClose}>
      <Field label="Date">
        <input type="date" style={{ ...inputSt, WebkitAppearance: "none", appearance: "none", width: "100%", minWidth: 0, maxWidth: "100%", boxSizing: "border-box", minHeight: 44 }} value={date} max={today} onChange={e => setDate(e.target.value)} />
      </Field>
      <div style={{ fontSize: 13, color: C.textLight, marginBottom: 12 }}>
        ClearBudget shows: <strong>{fmt(computedBalance)}</strong>{isCard ? " owed" : ""}
      </div>
      <AmountInput label={isCard ? "Actual balance owed, from your statement ($)" : "Actual balance, from your bank ($)"}
        initialValue={realBalance || undefined} onChange={v => { setRealBalance(v); setUserEdited(true); }} onCommit={v => { setRealBalance(v); setUserEdited(true); }} placeholder="0.00" />
      <div style={{ display: "flex", justifyContent: "space-between", padding: "10px 0", borderTop: `1px solid ${C.border}`, marginTop: 8, fontSize: 13, fontWeight: 700 }}>
        <span>Difference</span>
        <span style={{ color: matches ? C.green : C.red }}>{matches ? "None — matches!" : fmt(diff)}</span>
      </div>

      {/* Buttons always above the list */}
      <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
        <Btn outline color={C.muted} onClick={onClose} style={{ flex: 1 }}>Cancel</Btn>
        <Btn color={C.purple} onClick={() => finish(true)} disabled={matches} style={{ flex: 1 }}>
          Add Adjustment {!matches ? `(${fmt(diff)})` : ""} & Reconcile
        </Btn>
      </div>
      <Btn color={C.green} onClick={() => finish(false)} disabled={!matches} style={{ width: "100%", marginTop: 8 }}>
        ✅ Finish Reconciliation
      </Btn>

      {/* Unreconciled transaction list — always shown */}
      {unreconciled.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: C.muted, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>
            Unreconciled Transactions — uncheck any that haven't cleared yet
          </div>
          {suggestedIds?.length > 0 && (
            <div style={{ fontSize: 12, color: C.purple, fontWeight: 600, marginBottom: 8, lineHeight: 1.5, padding: "6px 10px", background: "#F3F0FF", borderRadius: 6 }}>
              💡 {suggestedIds.length === 1 ? "1 transaction was" : `${suggestedIds.length} transactions were`} automatically unchecked to match your balance — re-check if incorrect.
            </div>
          )}
          {uncheckedSum !== 0 && (
            <div style={{ fontSize: 12, color: C.textLight, marginBottom: 8, lineHeight: 1.5 }}>
              Adjusted balance: <strong style={{ color: matches ? C.green : C.text }}>{fmt(adjustedBalance)}</strong>
              {" · "}Remaining gap: <strong style={{ color: C.red }}>{fmt(diff)}</strong>
            </div>
          )}
          <div style={{ maxHeight: 220, overflowY: "auto", border: `1px solid ${C.border}`, borderRadius: 8, background: C.bg }}>
            {unreconciled.sort((a, b) => b.date.localeCompare(a.date)).map(tx => (
              <label key={tx.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", borderBottom: `1px solid ${C.border}`, cursor: "pointer", background: checked.has(tx.id) ? C.surface : suggestedIds?.includes(tx.id) ? "#FFF0F0" : "#FFF8F8" }}>
                <input type="checkbox" checked={checked.has(tx.id)} onChange={() => toggleTx(tx.id)} style={{ flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{tx.payee || "—"}</div>
                  <div style={{ fontSize: 11, color: C.muted }}>{tx.date}</div>
                </div>
                <div style={{ fontSize: 12, fontWeight: 700, color: tx.amount < 0 ? C.green : C.text, flexShrink: 0 }}>{fmt(tx.amount)}</div>
              </label>
            ))}
          </div>
        </div>
      )}
    </Modal>
  );
}

// ── Edit Group Modal ─────────────────────────────────────────
function EditGroupModal({ group, categories, nameExists, onSave, onDelete, onClose }) {
  const [name, setName] = useState(group.name);
  const [nameError, setNameError] = useState("");
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const catCount = categories.filter(c => c.groupId === group.id).length;
  const isUncategorized = group.name === "Uncategorized";
  const handleSave = () => {
    if (!name.trim()) return;
    if (nameExists(name, group.id)) { setNameError(`A group named "${name.trim()}" already exists. Choose a different name.`); return; }
    onSave({ ...group, name: toTitleCase(name.trim()) }); onClose();
  };
  return (
    <Modal title="Edit Group" onClose={onClose} closeLabel="Discard">
      <Inp label="Group Name" value={name} onChange={e => { setName(e.target.value); setNameError(""); }} autoFocus />
      {nameError && <div style={{ fontSize: 12, color: C.red, marginTop: -10, marginBottom: 12 }}>{nameError}</div>}
      <BtnRow onCancel={onClose} onSave={handleSave} saveLabel="Save" disabled={!name.trim()} />
      {!isUncategorized && (
        <div style={{ marginTop: 16, paddingTop: 16, borderTop: `1px solid ${C.border}` }}>
          {deleteConfirm ? (
            <div>
              <div style={{ fontSize: 13, color: C.red, marginBottom: 10, fontWeight: 600 }}>
                Delete "{group.name}"?{catCount > 0 ? ` Its ${catCount} categor${catCount !== 1 ? "ies" : "y"} will move to "Uncategorized".` : ""} This cannot be undone.
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <Btn small outline color={C.muted} onClick={() => setDeleteConfirm(false)} style={{ flex: 1 }}>No, Cancel</Btn>
                <Btn small color={C.red} onClick={() => { onDelete(group.id); onClose(); }} style={{ flex: 1 }}>Yes, Delete</Btn>
              </div>
            </div>
          ) : (
            <Btn onClick={() => setDeleteConfirm(true)} outline color={C.red} style={{ width: "100%" }}>Delete Group</Btn>
          )}
        </div>
      )}
    </Modal>
  );
}

// ── Category Settings Modal ──────────────────────────────────
function CategorySettingsModal({ cat, groups, hasTransactions, nameExists, onSave, onArchive, onDelete, onClose, viewMonth, todayMonth }) {
  const [tab, setTab] = useState(cat.creditCardId ? "note" : "goal");
  const [catName, setCatName] = useState(cat.name);
  const [nameError, setNameError] = useState("");
  const [groupId, setGroupId] = useState(cat.groupId);
  const [note, setNote] = useState(cat.note || "");
  const [rollover, setRollover] = useState(() => {
    // Show the effective rollover for the viewed month
    if (!cat.rolloverChanges?.length) return cat.rollover || "rollover";
    const applicable = cat.rolloverChanges.filter(c => c.month <= (viewMonth || todayMonth)).sort((a, b) => b.month.localeCompare(a.month));
    return applicable[0]?.type ?? (cat.rollover || "rollover");
  });
  const [rolloverMax, setRolloverMax] = useState(cat.rolloverMax || 0);
  const [goalType, setGoalType] = useState(cat.goal?.type || "");
  const [goalTarget, setGoalTarget] = useState(cat.goal?.target || 0);
  const [goalDate, setGoalDate] = useState(cat.goal?.targetDate || "");
  const [deleteConfirm, setDeleteConfirm] = useState(false);

  // Rollover is locked for past months — changes only apply from current month forward
  const isPastMonth = viewMonth && todayMonth && viewMonth < todayMonth;

  const describeGoal = (g) => {
    if (!g) return "No goal";
    if (g.type === "monthly") return `Monthly: ${fmt(g.target || 0)}`;
    if (g.type === "savings") return `Savings target: ${fmt(g.target || 0)}`;
    if (g.type === "date") return `By ${g.targetDate || "?"}: ${fmt(g.target || 0)}`;
    return "No goal";
  };

  const handleSave = () => {
    if (!catName.trim()) { setNameError("Category name can't be empty."); return; }
    if (nameExists(catName, cat.id)) { setNameError(`A category named "${catName.trim()}" already exists.`); return; }

    const newGoal = goalType ? { type: goalType, target: goalTarget, ...(goalType === "date" ? { targetDate: goalDate } : {}) } : null;

    // Append goal change history to note if goal changed
    let updatedNote = note;
    const oldGoalDesc = describeGoal(cat.goal);
    const newGoalDesc = describeGoal(newGoal);
    if (oldGoalDesc !== newGoalDesc) {
      const today = new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
      const changeEntry = `${oldGoalDesc} → ${newGoalDesc} on ${today}`;
      const HEADING = "--- Goal Changes ---";
      if (updatedNote.includes(HEADING)) {
        updatedNote = updatedNote + "\n" + changeEntry;
      } else {
        updatedNote = (updatedNote.trim() ? updatedNote.trim() + "\n\n" : "") + HEADING + "\n" + changeEntry;
      }
    }

    // Handle rollover change: record it effective from viewMonth (if current/future) or todayMonth
    let rolloverChanges = cat.rolloverChanges ? [...cat.rolloverChanges] : [];
    const effectiveMonth = (!isPastMonth && viewMonth) ? viewMonth : todayMonth;
    const currentEffective = (() => {
      const applicable = rolloverChanges.filter(c => c.month <= effectiveMonth).sort((a, b) => b.month.localeCompare(a.month));
      return applicable[0]?.type ?? (cat.rollover || "rollover");
    })();
    if (rollover !== currentEffective) {
      // Remove any existing entry for this exact month, then add the new one
      rolloverChanges = rolloverChanges.filter(c => c.month !== effectiveMonth);
      rolloverChanges.push({ month: effectiveMonth, type: rollover });
      rolloverChanges.sort((a, b) => a.month.localeCompare(b.month));
    }

    onSave({ ...cat, name: toTitleCase(catName.trim()), groupId, note: updatedNote, rollover: cat.rollover || "rollover", rolloverChanges, rolloverMax: rollover === "max" ? rolloverMax : 0, goal: newGoal });
    onClose();
  };

  const GOAL_TYPES = [
    { value: "", label: "No goal", desc: "" },
    { value: "savings", label: "💰 Savings Target", desc: "Save toward a total amount" },
    { value: "monthly", label: "📅 Monthly Funding", desc: "Fund by a set amount each month" },
    { value: "date", label: "🏁 Target by Date", desc: "Reach a total amount by a specific date" },
  ];

  return (
    <Modal title="Category Settings" onClose={onClose} closeLabel="Discard">
      <Inp label="Category Name" value={catName} onChange={e => { setCatName(e.target.value); setNameError(""); }} />
      {nameError && <div style={{ fontSize: 12, color: C.red, marginTop: -10, marginBottom: 12 }}>{nameError}</div>}
      <Sel label="Group" value={groupId} onChange={e => setGroupId(e.target.value)} disabled={!!cat.creditCardId}>
        {groups.filter(g => cat.creditCardId || g.name !== "Credit Card Payments").map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
      </Sel>
      {cat.creditCardId && <div style={{ fontSize: 11, color: C.muted, marginTop: -10, marginBottom: 12 }}>Credit card payment categories can't be moved.</div>}
      <div style={{ display: "flex", background: "#F0EEE9", borderRadius: 8, padding: 3, marginBottom: 20 }}>
        {(cat.creditCardId ? [["note", "📝 Note"]] : [["goal", "🎯 Goal"], ["rollover", "🔄 Rollover"], ["note", "📝 Note"]]).map(([id, lbl]) => (
          <button key={id} onClick={() => setTab(id)} style={{ flex: 1, background: tab === id ? C.surface : "none", border: "none", padding: "7px 4px", borderRadius: 6, fontSize: 12, fontWeight: tab === id ? 700 : 400, color: tab === id ? C.navy : C.muted, cursor: "pointer", boxShadow: tab === id ? "0 1px 3px rgba(0,0,0,0.1)" : "none" }}>{lbl}</button>
        ))}
      </div>
      {cat.creditCardId && tab !== "note" && (
        <div style={{ padding: "12px 14px", background: "#F8F6F2", borderRadius: 8, fontSize: 13, color: C.textLight, lineHeight: 1.6 }}>
          Credit card payment categories automatically roll over their full balance each month and don't support goals. The available amount always reflects what you owe on the card.
        </div>
      )}
      {tab === "goal" && (
        <>
          <Field label="Goal Type">
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {GOAL_TYPES.map(gt => (
                <label key={gt.value} style={{ display: "flex", alignItems: "flex-start", gap: 10, cursor: "pointer", padding: "9px 12px", borderRadius: 8, background: goalType === gt.value ? "#EAF6F0" : "#F8F6F2", border: `1.5px solid ${goalType === gt.value ? C.green : "transparent"}` }}>
                  <input type="radio" value={gt.value} checked={goalType === gt.value} onChange={() => setGoalType(gt.value)} style={{ marginTop: 2 }} />
                  <div><div style={{ fontSize: 13, fontWeight: 600 }}>{gt.label}</div>{gt.desc && <div style={{ fontSize: 11, color: C.textLight, marginTop: 1 }}>{gt.desc}</div>}</div>
                </label>
              ))}
            </div>
          </Field>
          {goalType === "savings" && <AmountInput label="Savings Target ($)" initialValue={goalTarget || undefined} onCommit={setGoalTarget} placeholder="e.g. 1000" />}
          {goalType === "monthly" && <AmountInput label="Monthly Amount ($)" initialValue={goalTarget || undefined} onCommit={setGoalTarget} placeholder="e.g. 500" />}
          {goalType === "date" && (<><AmountInput label="Total Target ($)" initialValue={goalTarget || undefined} onCommit={setGoalTarget} placeholder="e.g. 3000" /><Field label="Target Date"><input type="month" style={{ ...inputSt, WebkitAppearance: "none", appearance: "none", width: "100%", minWidth: 0, maxWidth: "100%", boxSizing: "border-box", minHeight: 44, lineHeight: "1.5" }} value={goalDate} onChange={e => setGoalDate(e.target.value)} min={toKey(new Date())} /></Field></>)}
        </>
      )}
      {tab === "rollover" && (() => {
        // By-date goals: rollover behavior is fixed (return over target). No picker.
        if (goalType === "date") return (
          <div style={{ padding: "12px 14px", background: "#F8F6F2", borderRadius: 8, fontSize: 13, color: C.textLight, lineHeight: 1.6 }}>
            🏁 By-date goal categories automatically roll over up to your target amount each month, and return any excess to Ready to Assign. This can't be changed.
          </div>
        );
        // Savings goals: hide "Return to RTA" option, enforce minimum cap = goal target
        const filteredOpts = goalType === "savings"
          ? ROLLOVER_OPTS.filter(o => o.value !== "return")
          : ROLLOVER_OPTS;
        const effectiveMin = goalType === "savings" ? (goalTarget || 0) : 0;
        return (
          <div>
            {isPastMonth && (
              <div style={{ fontSize: 12, color: C.amber, background: "#FFF8E7", border: `1px solid ${C.amber}`, borderRadius: 6, padding: "8px 12px", marginBottom: 12 }}>
                🔒 Rollover changes apply from the current month forward. Viewing a past month — rollover shown is read-only.
              </div>
            )}
            <Field label={`Rollover Behavior${!isPastMonth && viewMonth ? ` (effective from ${new Date(viewMonth + "-15").toLocaleDateString("en-US", { month: "short", year: "numeric" })})` : ""}`}>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {filteredOpts.map(opt => (
                  <label key={opt.value} style={{ display: "flex", alignItems: "flex-start", gap: 10, cursor: isPastMonth ? "not-allowed" : "pointer", padding: "10px 12px", borderRadius: 8, background: rollover === opt.value ? "#EAF6F0" : "#F8F6F2", border: `1.5px solid ${rollover === opt.value ? C.green : "transparent"}`, opacity: isPastMonth ? 0.6 : 1 }}>
                    <input type="radio" value={opt.value} checked={rollover === opt.value} onChange={() => !isPastMonth && setRollover(opt.value)} disabled={isPastMonth} style={{ marginTop: 3 }} />
                    <div><div style={{ fontSize: 13, fontWeight: 700 }}>{opt.title}</div><div style={{ fontSize: 12, color: C.textLight, marginTop: 2 }}>{opt.desc}</div></div>
                  </label>
                ))}
              </div>
            </Field>
            {!isPastMonth && rollover === "max" && (
              <>
                <AmountInput label={`Maximum rollover ($)${effectiveMin > 0 ? ` — minimum ${fmt(effectiveMin)}` : ""}`} initialValue={Math.max(rolloverMax, effectiveMin) || undefined} onCommit={v => setRolloverMax(Math.max(v, effectiveMin))} placeholder="e.g. 200" />
                {goalType === "savings" && rolloverMax < effectiveMin && (
                  <div style={{ fontSize: 12, color: C.gold, marginTop: -8, marginBottom: 12 }}>Cap can't be less than your savings target ({fmt(effectiveMin)}). It will be set to {fmt(effectiveMin)}.</div>
                )}
              </>
            )}
          </div>
        );
      })()}
      {tab === "note" && (() => {
        const HEADING = "--- Goal Changes ---";
        const headingIdx = note.indexOf(HEADING);
        const editablePart = headingIdx >= 0 ? note.slice(0, headingIdx).trimEnd() : note;
        const goalChangePart = headingIdx >= 0 ? note.slice(headingIdx + HEADING.length).trim() : "";
        return (
          <>
            <Field label="Note">
              <textarea value={editablePart} onChange={e => {
                // Preserve the goal changes section when editing the user note
                const newNote = goalChangePart
                  ? e.target.value.trimEnd() + "\n\n" + HEADING + "\n" + goalChangePart
                  : e.target.value;
                setNote(newNote);
              }} placeholder="Add a note about this category..." style={{ ...inputSt, height: 120, resize: "vertical" }} />
            </Field>
            {goalChangePart && (
              <div style={{ marginTop: 4, marginBottom: 14 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: C.muted, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6 }}>Goal Changes (auto-recorded)</div>
                <div style={{ fontSize: 12, color: C.textLight, lineHeight: 1.7, background: C.inputBg, borderRadius: 8, padding: "10px 12px", whiteSpace: "pre-wrap", fontFamily: "inherit" }}>{goalChangePart}</div>
              </div>
            )}
          </>
        );
      })()}
      <BtnRow onCancel={onClose} onSave={handleSave} saveLabel="Save Changes" />
      <div style={{ marginTop: 16, paddingTop: 16, borderTop: `1px solid ${C.border}`, display: "flex", flexDirection: "column", gap: 8 }}>
        <Btn small outline color={C.amber} onClick={() => { onArchive(cat); onClose(); }} style={{ width: "100%" }}>{cat.archived ? "↩ Restore Category" : "🗂 Archive Category"}</Btn>
        {!cat.archived && <div style={{ fontSize: 11, color: C.muted, textAlign: "center" }}>Archiving moves this to "Uncategorized" and tags the name with today's date</div>}
        {deleteConfirm ? (
          <div>
            <div style={{ fontSize: 12, color: C.red, marginBottom: 8, fontWeight: 600 }}>Delete "{cat.name}"? Any money assigned to it (in any month) returns to Ready to Assign. This cannot be undone.</div>
            <div style={{ display: "flex", gap: 8 }}>
              <Btn small outline color={C.muted} onClick={() => setDeleteConfirm(false)} style={{ flex: 1 }}>Cancel</Btn>
              <Btn small color={C.red} onClick={() => { onDelete(cat); onClose(); }} style={{ flex: 1 }}>Confirm Delete</Btn>
            </div>
          </div>
        ) : (
          <Btn small outline color={C.red} onClick={() => setDeleteConfirm(true)} disabled={hasTransactions} style={{ width: "100%" }}>🗑 Delete Category</Btn>
        )}
        {hasTransactions && !deleteConfirm && <div style={{ fontSize: 11, color: C.muted, textAlign: "center" }}>Has transactions (incl. splits) — archive instead, or move its transactions to another category first</div>}
      </div>
    </Modal>
  );
}

// ── Add Category Modal ───────────────────────────────────────
function AddCategoryModal({ groups, nameExists, onAdd, onClose }) {
  const [name, setName] = useState("");
  const [groupId, setGroupId] = useState(groups[0]?.id || "");
  const [rollover, setRollover] = useState("rollover");
  const [rolloverMax, setRolloverMax] = useState(0);
  const [nameError, setNameError] = useState("");
  const handleAdd = () => {
    if (!name.trim() || !groupId) return;
    if (nameExists(name, null)) { setNameError(`A category named "${name.trim()}" already exists. Choose a different name.`); return; }
    onAdd({ id: uid(), name: toTitleCase(name.trim()), groupId, rollover, rolloverMax: rollover === "max" ? rolloverMax : 0 });
    onClose();
  };
  return (
    <Modal title="New Category" onClose={onClose} closeLabel="Discard">
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <Inp label="Name" value={name} onChange={e => { setName(e.target.value); setNameError(""); }} placeholder="e.g. Coffee" autoFocus />
        <Sel label="Group" value={groupId} onChange={e => setGroupId(e.target.value)}>{groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}</Sel>
      </div>
      {nameError && <div style={{ fontSize: 12, color: C.red, marginTop: -10, marginBottom: 12 }}>{nameError}</div>}
      <RolloverPicker value={rollover} onChange={setRollover} rolloverMax={rolloverMax} onMaxChange={setRolloverMax} />
      <BtnRow onCancel={onClose} onSave={handleAdd} saveLabel="Add Category" saveColor={C.purple} disabled={!name || !groupId} />
    </Modal>
  );
}

// ── Add Group Modal ──────────────────────────────────────────
function AddGroupModal({ nameExists, onAdd, onClose }) {
  const [name, setName] = useState("");
  const [nameError, setNameError] = useState("");
  const handleAdd = () => {
    if (!name.trim()) return;
    if (nameExists(name, null)) { setNameError(`A group named "${name.trim()}" already exists. Choose a different name.`); return; }
    onAdd({ id: uid(), name: toTitleCase(name.trim()) }); onClose();
  };
  return (
    <Modal title="New Category Group" onClose={onClose} closeLabel="Discard">
      <Inp label="Group Name" value={name} onChange={e => { setName(e.target.value); setNameError(""); }} placeholder="e.g. Kids, Business, Medical..." autoFocus />
      {nameError && <div style={{ fontSize: 12, color: C.red, marginTop: -10, marginBottom: 12 }}>{nameError}</div>}
      <BtnRow onCancel={onClose} onSave={handleAdd} saveLabel="Add Group" disabled={!name.trim()} />
    </Modal>
  );
}

// ── Setup Wizard ─────────────────────────────────────────────
// ── IdentityGate: first-launch screen — Continue as Guest / Sign Up / Log In ──
// Phase 1: app-shape only. No real backend — userAccount lives in window.storage.
// Password is collected so the sign-up form/flow exists, but it is not verified
// against anything yet (there's nothing to authenticate against in Phase 1).
function IdentityGate({ onComplete }) {
  const [mode, setMode] = useState("choice"); // choice | signup | login
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  const continueAsGuest = () => {
    const userId = genUserId();
    const account = {
      userId,
      displayName: `Guest-${guestSuffixFromId(userId)}`,
      isGuest: true,
      email: "",
      passwordHash: "",
      createdAt: new Date().toISOString(),
    };
    onComplete(account);
  };

  const submitSignup = () => {
    if (!displayName.trim()) { setError("Please enter a display name."); return; }
    if (!email.trim() || !email.includes("@")) { setError("Please enter a valid email."); return; }
    if (!password || password.length < 6) { setError("Password must be at least 6 characters."); return; }
    const userId = genUserId();
    const account = {
      userId,
      displayName: displayName.trim(),
      isGuest: false,
      email: email.trim(),
      passwordHash: password, // Phase 1: stored as-is locally, never verified. Real hashing arrives with the backend.
      createdAt: new Date().toISOString(),
    };
    onComplete(account);
  };

  const submitLogin = () => {
    setError("No account found on this device with that email. (Phase 1 has no shared backend yet — accounts only exist locally on the device that created them.)");
  };

  const fieldSt = { width: "100%", padding: "11px 13px", borderRadius: 9, border: `1.5px solid ${C.border}`, fontSize: 15, fontFamily: "inherit", marginBottom: 12, boxSizing: "border-box" };
  const labelSt = { fontSize: 12, fontWeight: 700, color: C.muted, marginBottom: 5, display: "block" };

  return (
    <div style={{ minHeight: "100vh", background: C.bg, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 24, fontFamily: "inherit" }}>
      <div style={{ width: "100%", maxWidth: 380 }}>
        <div style={{ textAlign: "center", marginBottom: 28 }}>
          <div style={{ fontSize: 44, marginBottom: 8 }}>💰</div>
          <div style={{ fontSize: 22, fontWeight: 800, color: C.navy }}>ClearBudget</div>
        </div>

        {mode === "choice" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <Btn color={C.navy} onClick={continueAsGuest}>Continue as Guest</Btn>
            <Btn outline color={C.navy} onClick={() => { setMode("signup"); setError(""); }}>Sign Up</Btn>
            <Btn outline color={C.muted} onClick={() => { setMode("login"); setError(""); }}>Log In</Btn>
            <div style={{ fontSize: 12, color: C.muted, textAlign: "center", marginTop: 8, lineHeight: 1.5 }}>
              Guests can use ClearBudget fully on this device. Sign up anytime to set a name and secure your account.
            </div>
          </div>
        )}

        {mode === "signup" && (
          <div>
            <label style={labelSt}>Display Name</label>
            <input style={fieldSt} value={displayName} onChange={e => { setDisplayName(e.target.value); setError(""); }} placeholder="e.g. Mick" autoFocus />
            <label style={labelSt}>Email</label>
            <input style={fieldSt} type="email" value={email} onChange={e => { setEmail(e.target.value); setError(""); }} placeholder="you@example.com" />
            <label style={labelSt}>Password</label>
            <input style={fieldSt} type="password" value={password} onChange={e => { setPassword(e.target.value); setError(""); }} placeholder="At least 6 characters" />
            {error && <div style={{ fontSize: 12, color: C.red, marginBottom: 10 }}>{error}</div>}
            <Btn color={C.navy} onClick={submitSignup} style={{ width: "100%", marginBottom: 8 }}>Sign Up</Btn>
            <Btn outline color={C.muted} onClick={() => { setMode("choice"); setError(""); }} style={{ width: "100%" }}>Back</Btn>
          </div>
        )}

        {mode === "login" && (
          <div>
            <label style={labelSt}>Email</label>
            <input style={fieldSt} type="email" value={email} onChange={e => { setEmail(e.target.value); setError(""); }} placeholder="you@example.com" autoFocus />
            <label style={labelSt}>Password</label>
            <input style={fieldSt} type="password" value={password} onChange={e => { setPassword(e.target.value); setError(""); }} placeholder="Password" />
            {error && <div style={{ fontSize: 12, color: C.red, marginBottom: 10, lineHeight: 1.5 }}>{error}</div>}
            <Btn color={C.navy} onClick={submitLogin} style={{ width: "100%", marginBottom: 8 }}>Log In</Btn>
            <Btn outline color={C.muted} onClick={() => { setMode("choice"); setError(""); }} style={{ width: "100%" }}>Back</Btn>
          </div>
        )}
      </div>
    </div>
  );
}

function SetupWizard({ onComplete, userAccount }) {
  const [step, setStep] = useState(0);
  const [budgetName, setBudgetName] = useState("My Budget");
  const [accounts, setAccounts] = useState([]);
  const [creditCards, setCreditCards] = useState([]);
  const [groups, setGroups] = useState(DEFAULT_GROUPS.map(g => ({ ...g })));
  const [categories, setCategories] = useState(DEFAULT_CATS.map(c => ({ ...c, rolloverMax: c.rolloverMax || 0, goal: c.goal || null })));
  const [newAccName, setNewAccName] = useState(""); const [newAccType, setNewAccType] = useState("checking"); const [newAccBal, setNewAccBal] = useState(null);
  const [accStepError, setAccStepError] = useState("");
  const [newCCName, setNewCCName] = useState(""); const [newCCBal, setNewCCBal] = useState(null);
  const [ccStepError, setCcStepError] = useState("");
  const [catSeedChoice, setCatSeedChoice] = useState(null);
  const wizardAccNameRef = useRef(null);
  const wizardCCNameRef = useRef(null);
  const wizardAddAccBtnRef = useRef(null);
  const wizardAddCCBtnRef = useRef(null);
  const [wizardImportError, setWizardImportError] = useState("");
  const wizardFileRef = useRef(null);
  const STEPS = ["Welcome", "Accounts", "Credit Cards", "Categories", "Done!"];
  // Auto-focus the name field when stepping into accounts or cards screen
  useEffect(() => {
    if (step === 1) requestAnimationFrame(() => requestAnimationFrame(() => wizardAccNameRef.current?.focus()));
    if (step === 2) requestAnimationFrame(() => requestAnimationFrame(() => wizardCCNameRef.current?.focus()));
  }, [step]);
  const addAcc = () => {
    if (!newAccName || newAccBal === null) return false;
    const name = toTitleCase(newAccName.trim());
    if (accounts.some(a => a.name.toLowerCase() === name.toLowerCase())) { setAccStepError(`An account named "${name}" already exists. Choose a different name.`); return false; }
    setAccounts(p => [...p, { id: uid(), name, type: newAccType, balance: newAccBal }]); setNewAccName(""); setNewAccBal(null); setNewAccType("checking"); setAccStepError("");
    requestAnimationFrame(() => requestAnimationFrame(() => wizardAccNameRef.current?.focus()));
    return true;
  };
  const addCC = () => {
    if (!newCCName || newCCBal === null) return false;
    const name = toTitleCase(newCCName.trim());
    if (creditCards.some(c => c.name.toLowerCase() === name.toLowerCase())) { setCcStepError(`A credit card named "${name}" already exists. Choose a different name.`); return false; }
    setCreditCards(p => [...p, { id: uid(), name, balance: newCCBal }]); setNewCCName(""); setNewCCBal(null); setCcStepError("");
    requestAnimationFrame(() => requestAnimationFrame(() => wizardCCNameRef.current?.focus()));
    return true;
  };
  const updateCatWiz = (id, patch) => setCategories(p => p.map(c => c.id === id ? { ...c, ...patch } : c));
  // Returns `base`, or `base (2)`, `base (3)`, etc. — first variant not already used by `existingNames` (case-insensitive)
  const getUniqueWizName = (base, existingNames) => {
    const taken = new Set(existingNames.map(n => n.trim().toLowerCase()));
    if (!taken.has(base.toLowerCase())) return base;
    let i = 2;
    while (taken.has(`${base} (${i})`.toLowerCase())) i++;
    return `${base} (${i})`;
  };
  const addCatToGroup = (groupId) => setCategories(p => [...p, { id: uid(), groupId, name: getUniqueWizName("New Category", p.map(c => c.name)), rollover: "rollover", rolloverMax: 0, goal: null }]);
  const deleteCatWiz = (id) => setCategories(p => p.filter(c => c.id !== id));
  const updateGroupWiz = (id, patch) => setGroups(p => p.map(g => g.id === id ? { ...g, ...patch } : g));
  const addGroupWiz = () => setGroups(p => [...p, { id: uid(), name: getUniqueWizName("New Group", p.map(g => g.name)) }]);
  const deleteGroupWiz = (id) => { setGroups(p => p.filter(g => g.id !== id)); setCategories(p => p.filter(c => c.groupId !== id)); };
  // Duplicate category-name detection (case-insensitive, ignores blank names)
  const catNameCounts = {};
  categories.forEach(c => { const key = c.name.trim().toLowerCase(); if (key) catNameCounts[key] = (catNameCounts[key] || 0) + 1; });
  const isDupCatName = (cat) => { const key = cat.name.trim().toLowerCase(); return key && catNameCounts[key] > 1; };
  const hasDuplicateCatNames = categories.some(isDupCatName);
  // Duplicate group-name detection (case-insensitive, ignores blank names)
  const groupNameCounts = {};
  groups.forEach(g => { const key = g.name.trim().toLowerCase(); if (key) groupNameCounts[key] = (groupNameCounts[key] || 0) + 1; });
  const isDupGroupName = (grp) => { const key = grp.name.trim().toLowerCase(); return key && groupNameCounts[key] > 1; };
  const hasDuplicateGroupNames = groups.some(isDupGroupName);
  const finish = () => {
    const currentMonth = toKey(new Date());
    const today = new Date().toISOString().slice(0, 10);
    const totalAccBal = accounts.reduce((s, a) => s + a.balance, 0);
    const ccGrpId = uid(); const hasCCs = creditCards.length > 0;
    const ccGroup = { id: ccGrpId, name: "Credit Card Payments" };
    const ccCats = creditCards.map(cc => ({ id: uid(), groupId: ccGrpId, name: `${cc.name} Payment`, creditCardId: cc.id, rollover: "rollover" }));
    const ccPreload = {}; creditCards.forEach((cc, i) => { if (cc.balance > 0) ccPreload[ccCats[i].id] = cc.balance; });
    // Create a locked Starting Balance transaction for each account.
    // Accounts store balance: 0 because getAccountBalance adds income txs to acc.balance —
    // storing the real balance would double-count it alongside the Starting Balance transaction.
    const accountsWithZeroBalance = accounts.map(a => ({ ...a, balance: 0 }));
    const startingTxs = accounts.map(a => ({
      id: uid(), date: today, payee: "Starting Balance", originalPayee: "Starting Balance",
      note: "", type: "income", subtype: "starting_balance", accountId: a.id,
      categoryId: null, amount: a.balance, reconciled: true,
    }));
    // Credit cards also get Starting Balance transactions (as expenses against their payment category).
    // CCs store balance: 0 for same reason — getCardBalance starts from cc.balance + transactions.
    const creditCardsWithZeroBalance = creditCards.map(cc => ({ ...cc, balance: 0 }));
    const ccStartingTxs = creditCards.map((cc, i) => ({
      id: uid(), date: today, payee: "Starting Balance", originalPayee: "Starting Balance",
      note: "", type: "expense", subtype: "starting_balance", accountId: cc.id,
      categoryId: ccCats[i].id, amount: cc.balance, reconciled: true,
    }));
    const budget = {
      id: uid(), name: budgetName, createdAt: new Date().toISOString(), archived: false, ownerId: userAccount?.userId || null,
      accounts: accountsWithZeroBalance, creditCards: creditCardsWithZeroBalance,
      categoryGroups: [...groups, ...(hasCCs ? [ccGroup] : [])],
      categories: [...categories, ...ccCats],
      monthlyBudgets: Object.keys(ccPreload).length > 0 ? { [currentMonth]: ccPreload } : {},
      transactions: [...startingTxs, ...ccStartingTxs],
      inflows: totalAccBal > 0 ? { [currentMonth]: totalAccBal } : {},
      payees: [],
      pendingDuplicates: [],
    };
    onComplete({ setupComplete: true, activeBudgetId: budget.id, budgets: [budget] });
  };
  const stepContent = [
    <div style={{ textAlign: "center", paddingTop: 12 }}>
      <div style={{ fontSize: 60, marginBottom: 16 }}>💰</div>
      <div style={{ fontSize: 26, fontWeight: 800, color: C.navy, marginBottom: 10 }}>Welcome to ClearBudget</div>
      <div style={{ fontSize: 15, color: C.textLight, lineHeight: 1.65, marginBottom: 28 }}>A zero-based budgeting app that gives every dollar a job.</div>
      <Inp label="Budget name" value={budgetName} onChange={e => setBudgetName(e.target.value)} placeholder="e.g. Personal Budget..." />
      <Btn color={C.navy} onClick={() => setStep(1)} disabled={!budgetName.trim()} style={{ width: "100%", marginBottom: 20 }}>Get Started →</Btn>

      <div style={{ borderTop: `1px solid ${C.border}`, paddingTop: 20, marginTop: 4 }}>
        <div style={{ fontSize: 12, color: C.muted, marginBottom: 12 }}>Already have a backup? Restore it instead.</div>
        <input ref={wizardFileRef} type="file" accept="application/json,.json" style={{ display: "none" }} onChange={e => {
          const file = e.target.files[0]; if (!file) return;
          setWizardImportError("");
          const reader = new FileReader();
          reader.onload = (ev) => {
            try {
              const parsed = JSON.parse(ev.target.result);
              if (!parsed || !Array.isArray(parsed.budgets)) { setWizardImportError("This doesn't look like a ClearBudget backup file."); return; }
              onComplete(parsed);
            } catch { setWizardImportError("Couldn't read that file — make sure it's a ClearBudget backup (.json)."); }
          };
          reader.readAsText(file);
          e.target.value = "";
        }} />
        <Btn outline color={C.navy} onClick={() => wizardFileRef.current?.click()} style={{ width: "100%", marginBottom: 8 }}>📥 Restore from Backup File</Btn>
        {wizardImportError && <div style={{ fontSize: 12, color: C.red, marginBottom: 10 }}>{wizardImportError}</div>}

        {/* Mobile clipboard fallback — remove later */}
        <div style={{ marginTop: 8, border: `2px solid ${C.amber}`, borderRadius: 10, padding: 14, background: "#FFF8E7", textAlign: "left" }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: C.amber, textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 6 }}>📱 Mobile: Paste from Clipboard</div>
          <div style={{ fontSize: 12, color: "#7A5800", marginBottom: 10, lineHeight: 1.5 }}>If file import doesn't work on your device, copy your backup JSON to the clipboard first, then tap below.</div>
          <Btn color={C.amber} onClick={async () => {
            try {
              const text = await navigator.clipboard.readText();
              const parsed = JSON.parse(text);
              if (!parsed || !Array.isArray(parsed.budgets)) { setWizardImportError("Clipboard doesn't contain a valid ClearBudget backup."); return; }
              onComplete(parsed);
            } catch { setWizardImportError("Couldn't read clipboard. Make sure you've copied a ClearBudget backup first."); }
          }} style={{ width: "100%" }}>📋 Paste Backup from Clipboard</Btn>
        </div>
      </div>

      {/* Testing tool — remove before go-live */}
      <div style={{ marginTop: 20, border: `2px solid ${C.amber}`, borderRadius: 10, padding: 14, background: "#FFF8E7", textAlign: "left" }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: C.amber, textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 6 }}>🧪 Testing Only</div>
        <div style={{ fontSize: 12, color: "#7A5800", marginBottom: 10, lineHeight: 1.5 }}>Skips the wizard and loads a pre-built budget with 3 months of realistic test data. Remove this before go-live.</div>
        <Btn color={C.amber} onClick={() => {
          const testBudget = { ...buildTestBudget(), ownerId: userAccount?.userId || null };
          onComplete({ setupComplete: true, activeBudgetId: testBudget.id, budgets: [testBudget] });
        }} style={{ width: "100%" }}>📥 Load Test Data & Skip Wizard</Btn>
      </div>
    </div>,
    <div>
      <div style={{ background: "#EAF6F0", border: `1px solid #A8DFBF`, borderRadius: 10, padding: 12, fontSize: 13, color: "#1A5C36", marginBottom: 16 }}>💡 Account balances will seed your <strong>Ready to Assign</strong> balance.</div>
      {accounts.map(a => (<Card key={a.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 16px" }}><div><div style={{ fontWeight: 700 }}>{a.name}</div><div style={{ fontSize: 12, color: C.muted, textTransform: "capitalize" }}>{a.type} · {fmt(a.balance)}</div></div><button onClick={() => setAccounts(p => p.filter(x => x.id !== a.id))} style={{ background: "none", border: "none", color: C.red, cursor: "pointer", fontSize: 22 }}>×</button></Card>))}
      {accounts.length > 0 && <div style={{ textAlign: "right", fontSize: 13, fontWeight: 700, color: C.navy, marginBottom: 12 }}>Total: {fmt(accounts.reduce((s, a) => s + a.balance, 0))} → Ready to Assign</div>}
      <Card style={{ background: "#F8F6F2" }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}><Inp label="Account Name" value={newAccName} onChange={e => { setNewAccName(e.target.value); setAccStepError(""); }} onKeyDown={e => { if (e.key === "Enter" && newAccName && newAccBal !== null) addAcc(); }} placeholder="Chase Checking" inputRef={wizardAccNameRef} /><Sel label="Type" value={newAccType} onChange={e => setNewAccType(e.target.value)}><option value="checking">Checking</option><option value="savings">Savings</option><option value="cash">Cash</option></Sel></div>
        <AmountInput label="Current Balance ($)" initialValue={newAccBal !== null ? newAccBal : undefined} onChange={v => { setNewAccBal(v); setAccStepError(""); }} onCommit={v => { setNewAccBal(v); setAccStepError(""); requestAnimationFrame(() => requestAnimationFrame(() => wizardAddAccBtnRef.current?.focus())); }} onKeyDown={() => { if (newAccName && newAccBal !== null) addAcc(); }} placeholder="e.g. 1000" />
        <Btn color={C.green} onClick={addAcc} disabled={!newAccName || newAccBal === null} btnRef={wizardAddAccBtnRef}>+ Add Account</Btn>
      </Card>
      {accStepError && <div style={{ background: "#FDEDEC", border: `1px solid ${C.red}`, borderRadius: 8, padding: 10, fontSize: 12, color: C.red }}>⚠️ {accStepError}</div>}
    </div>,
    <div>
      <div style={{ fontSize: 14, color: C.textLight, marginBottom: 16, lineHeight: 1.6 }}>Existing balances will be reserved in your budget automatically.</div>
      {creditCards.map(cc => (<Card key={cc.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 16px" }}><div><div style={{ fontWeight: 700 }}>{cc.name}</div><div style={{ fontSize: 12, color: C.muted }}>{cc.balance > 0 ? `${fmt(cc.balance)} owed` : "No existing balance"}</div></div><button onClick={() => setCreditCards(p => p.filter(x => x.id !== cc.id))} style={{ background: "none", border: "none", color: C.red, cursor: "pointer", fontSize: 22 }}>×</button></Card>))}
      <Card style={{ background: "#F8F6F2" }}>
        <Inp label="Card Name" value={newCCName} onChange={e => { setNewCCName(e.target.value); setCcStepError(""); }} onKeyDown={e => { if (e.key === "Enter" && newCCName && newCCBal !== null) addCC(); }} placeholder="Chase Visa, Amex Blue..." inputRef={wizardCCNameRef} />
        <AmountInput label="Balance Owed ($)" initialValue={newCCBal !== null ? newCCBal : undefined} onChange={v => { setNewCCBal(v); setCcStepError(""); }} onCommit={v => { setNewCCBal(v); setCcStepError(""); requestAnimationFrame(() => requestAnimationFrame(() => wizardAddCCBtnRef.current?.focus())); }} onKeyDown={() => { if (newCCName && newCCBal !== null) addCC(); }} placeholder="0.00" />
        <Btn color={C.green} onClick={addCC} disabled={!newCCName || newCCBal === null} btnRef={wizardAddCCBtnRef}>+ Add Card</Btn>
      </Card>
      {ccStepError && <div style={{ background: "#FDEDEC", border: `1px solid ${C.red}`, borderRadius: 8, padding: 10, fontSize: 12, color: C.red }}>⚠️ {ccStepError}</div>}
      <div style={{ fontSize: 12, color: C.muted, textAlign: "center" }}>No credit cards? Skip this step.</div>
    </div>,
    catSeedChoice === null ? (
      <div>
        <div style={{ fontSize: 14, color: C.textLight, marginBottom: 20, lineHeight: 1.6 }}>
          You can start with a set of common budget categories and edit them, or build your own from a blank slate.
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <Btn color={C.navy} onClick={() => setCatSeedChoice("defaults")} style={{ width: "100%" }}>Use Suggested Categories</Btn>
          <Btn outline color={C.navy} onClick={() => { setGroups([]); setCategories([]); setCatSeedChoice("scratch"); }} style={{ width: "100%" }}>Start From Scratch</Btn>
          <Btn outline color={C.muted} onClick={() => setStep(p => p - 1)} style={{ width: "100%" }}>Back</Btn>
        </div>
      </div>
    ) : (
    <div>
      <div style={{ fontSize: 14, color: C.textLight, marginBottom: 16, lineHeight: 1.6 }}>
        Edit names, set how leftover money rolls over, and set goals — all right here. Rename or delete groups, remove categories you don't need, or add your own.
      </div>
      {hasDuplicateCatNames && (
        <div style={{ background: "#FDEDEC", border: `1px solid ${C.red}`, borderRadius: 8, padding: 10, fontSize: 12, color: C.red, marginBottom: 16 }}>
          ⚠️ Some categories have the same name — fix the highlighted ones below before continuing. Category names must be unique.
        </div>
      )}
      {hasDuplicateGroupNames && (
        <div style={{ background: "#FDEDEC", border: `1px solid ${C.red}`, borderRadius: 8, padding: 10, fontSize: 12, color: C.red, marginBottom: 16 }}>
          ⚠️ Some groups have the same name — fix the highlighted ones below before continuing. Group names must be unique.
        </div>
      )}
      {groups.map(grp => {
        const grpCats = categories.filter(c => c.groupId === grp.id);
        return (
          <div key={grp.id} style={{ marginBottom: 14, borderRadius: 10, border: `1px solid ${C.border}`, overflow: "hidden", background: C.surface }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", background: "#EAE7E1" }}>
              <input value={grp.name} onChange={e => updateGroupWiz(grp.id, { name: e.target.value })} onBlur={e => updateGroupWiz(grp.id, { name: toTitleCase(e.target.value.trim()) })}
                style={{ flex: 1, padding: "6px 8px", border: isDupGroupName(grp) ? `1px solid ${C.red}` : "none", borderRadius: 6, fontSize: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", fontFamily: "inherit", background: "transparent", color: "#6A6575", outline: "none" }} />
              <button onClick={() => deleteGroupWiz(grp.id)} title="Delete group" style={{ background: "none", border: "none", color: C.red, cursor: "pointer", fontSize: 20, padding: "0 2px" }}>×</button>
            </div>
            {isDupGroupName(grp) && <div style={{ padding: "0 10px 8px", fontSize: 11, color: C.red }}>A group named "{grp.name.trim()}" already exists — names must be unique.</div>}
            {grpCats.length === 0 && <div style={{ padding: "10px 12px", fontSize: 12, color: C.muted, fontStyle: "italic" }}>No categories — tap + Add Category below</div>}
            {grpCats.map(cat => (
              <div key={cat.id} style={{ padding: "10px 12px", borderTop: `1px solid #F4F1EB` }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: isDupCatName(cat) ? 2 : 8 }}>
                  <input value={cat.name} onChange={e => updateCatWiz(cat.id, { name: e.target.value })} onBlur={e => updateCatWiz(cat.id, { name: toTitleCase(e.target.value.trim()) })} placeholder="Category name"
                    style={{ flex: 1, padding: "7px 10px", border: `1px solid ${isDupCatName(cat) ? C.red : C.border}`, borderRadius: 6, fontSize: 14, fontFamily: "inherit", outline: "none" }} />
                  <button onClick={() => deleteCatWiz(cat.id)} style={{ background: "none", border: "none", color: "#C0BBCC", cursor: "pointer", fontSize: 18, padding: "0 2px" }}>×</button>
                </div>
                {isDupCatName(cat) && <div style={{ fontSize: 11, color: C.red, marginBottom: 8 }}>A category named "{cat.name.trim()}" already exists — names must be unique.</div>}
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                  <select value={cat.rollover} onChange={e => updateCatWiz(cat.id, { rollover: e.target.value })} style={{ ...inputSt, fontSize: 12, padding: "7px 8px" }}>
                    <option value="rollover">↻ Roll Over</option>
                    <option value="return">↩ Return to RTA</option>
                    <option value="max">≤ Cap at Amount</option>
                  </select>
                  <select value={cat.goal?.type || ""} onChange={e => {
                    const type = e.target.value;
                    if (!type) updateCatWiz(cat.id, { goal: null });
                    else updateCatWiz(cat.id, { goal: { type, target: cat.goal?.target || 0, ...(type === "date" ? { targetDate: cat.goal?.targetDate || "" } : {}) } });
                  }} style={{ ...inputSt, fontSize: 12, padding: "7px 8px" }}>
                    <option value="">No Goal</option>
                    <option value="savings">🎯 Savings Target</option>
                    <option value="monthly">📅 Monthly Funding</option>
                    <option value="date">🏁 Target by Date</option>
                  </select>
                </div>
                {cat.rollover === "max" && (
                  <div style={{ marginTop: 8 }}>
                    <AmountInput label="Cap ($)" initialValue={cat.rolloverMax || undefined} onCommit={v => updateCatWiz(cat.id, { rolloverMax: v })} placeholder="0.00" />
                  </div>
                )}
                {cat.goal?.type === "savings" && (
                  <div style={{ marginTop: 8 }}>
                    <AmountInput label="Savings Target ($)" initialValue={cat.goal.target || undefined} onCommit={v => updateCatWiz(cat.id, { goal: { ...cat.goal, target: v } })} placeholder="e.g. 1000" />
                  </div>
                )}
                {cat.goal?.type === "monthly" && (
                  <div style={{ marginTop: 8 }}>
                    <AmountInput label="Monthly Amount ($)" initialValue={cat.goal.target || undefined} onCommit={v => updateCatWiz(cat.id, { goal: { ...cat.goal, target: v } })} placeholder="e.g. 500" />
                  </div>
                )}
                {cat.goal?.type === "date" && (
                  <div style={{ marginTop: 8, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                    <AmountInput label="Total Target ($)" initialValue={cat.goal.target || undefined} onCommit={v => updateCatWiz(cat.id, { goal: { ...cat.goal, target: v } })} placeholder="e.g. 3000" />
                    <Field label="Target Date"><input type="month" style={{ ...inputSt, WebkitAppearance: "none", appearance: "none", width: "100%", minWidth: 0, maxWidth: "100%", boxSizing: "border-box", minHeight: 44, lineHeight: "1.5" }} value={cat.goal.targetDate || ""} onChange={e => updateCatWiz(cat.id, { goal: { ...cat.goal, targetDate: e.target.value } })} min={toKey(new Date())} /></Field>
                  </div>
                )}
              </div>
            ))}
            <button onClick={() => addCatToGroup(grp.id)} style={{ display: "block", width: "100%", textAlign: "left", padding: "10px 12px", background: "none", border: "none", borderTop: `1px solid #F4F1EB`, fontSize: 13, fontWeight: 600, color: C.green, cursor: "pointer", fontFamily: "inherit" }}>+ Add Category</button>
          </div>
        );
      })}
      <Btn color={C.navy} outline onClick={addGroupWiz} style={{ width: "100%" }}>+ Add Group</Btn>
    </div>
    ),
    <div style={{ textAlign: "center", paddingTop: 12 }}>
      <div style={{ fontSize: 60, marginBottom: 16 }}>🎉</div>
      <div style={{ fontSize: 26, fontWeight: 800, color: C.navy, marginBottom: 10 }}>You're all set!</div>
      <div style={{ fontSize: 15, color: C.textLight, lineHeight: 1.65, marginBottom: 20 }}><strong>{budgetName}</strong> is ready. {accounts.length} account{accounts.length !== 1 ? "s" : ""} · {creditCards.length} credit card{creditCards.length !== 1 ? "s" : ""}</div>
      {accounts.length > 0 && <div style={{ background: "#EAF6F0", border: `1px solid #A8DFBF`, borderRadius: 10, padding: 14, fontSize: 13, color: "#1A5C36", textAlign: "left", marginBottom: 14 }}>✓ <strong>{fmt(accounts.reduce((s, a) => s + a.balance, 0))}</strong> added to Ready to Assign.</div>}
      <div style={{ background: "#F0FAF5", border: `1px solid ${C.green}`, borderRadius: 10, padding: 14, fontSize: 13, color: "#1A5C36", textAlign: "left" }}><strong>First steps:</strong><br />1. Assign every dollar to a category<br />2. Long-press (or right-click) any category to set goals<br />3. Log spending as you go</div>
    </div>,
  ];
  return (
    <div style={{ fontFamily: "-apple-system, BlinkMacSystemFont, sans-serif", background: C.bg, minHeight: "100vh", display: "flex", flexDirection: "column", color: C.text }}>
      <div style={{ background: C.navy, padding: "14px 20px 12px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>{STEPS.map((s, i) => <div key={s} style={{ fontSize: 10, fontWeight: i === step ? 700 : 400, color: i <= step ? "#fff" : "rgba(255,255,255,0.3)", textAlign: "center", flex: 1 }}>{s}</div>)}</div>
        <div style={{ background: "rgba(255,255,255,0.18)", borderRadius: 4, height: 4 }}><div style={{ background: C.greenLight, borderRadius: 4, height: 4, width: `${(step / (STEPS.length - 1)) * 100}%`, transition: "width 0.35s" }} /></div>
      </div>
      <div style={{ flex: 1, padding: "20px 20px 0", maxWidth: 480, margin: "0 auto", width: "100%", boxSizing: "border-box", overflowY: "auto" }}>
        {step !== 0 && <div style={{ fontSize: 22, fontWeight: 800, color: C.navy, marginBottom: 4 }}>{STEPS[step]}</div>}
        <div style={{ marginTop: 12 }}>{stepContent[step]}</div>
      </div>
      {step > 0 && !(step === 3 && catSeedChoice === null) && (
        <div style={{ padding: "14px 20px", background: C.surface, borderTop: `1px solid ${C.border}`, display: "flex", gap: 10, maxWidth: 480, margin: "0 auto", width: "100%", boxSizing: "border-box" }}>
          {step > 0 && <Btn outline color={C.navy} onClick={() => setStep(p => p - 1)} style={{ flex: 1 }}>Back</Btn>}
          {step < STEPS.length - 1 && <Btn color={C.navy} onClick={() => {
            if (step === 1) {
              const hasName = !!newAccName.trim(), hasBal = newAccBal !== null && newAccBal > 0;
              const hasBalNull = newAccBal === null;
              if (hasName && (newAccBal !== null)) { if (addAcc()) setStep(p => p + 1); return; }
              if (hasName && hasBalNull) { setAccStepError("Enter a starting balance for this account, or clear the name field to skip adding it."); return; }
              if (!hasName && hasBal) { setAccStepError("Enter a name for this account, or clear the balance field to skip adding it."); return; }
            }
            if (step === 2) {
              const hasName = !!newCCName.trim(), hasBal = newCCBal !== null && newCCBal > 0;
              const hasBalNull = newCCBal === null;
              if (hasName && (newCCBal !== null)) { if (addCC()) setStep(p => p + 1); return; }
              if (hasName && hasBalNull) { setCcStepError("Enter a balance for this card (0 if none), or clear the name field to skip adding it."); return; }
              if (!hasName && hasBal) { setCcStepError("Enter a name for this card, or clear the balance field to skip adding it."); return; }
            }
            setStep(p => p + 1);
          }} disabled={step === 3 && (hasDuplicateCatNames || hasDuplicateGroupNames)} style={{ flex: 1 }}>Continue →</Btn>}
          {step === STEPS.length - 1 && <Btn color={C.green} onClick={finish} style={{ flex: 1 }}>Open My Budget →</Btn>}
        </div>
      )}
    </div>
  );
}

function SettingsRenameModal({ renameModal, onClose, budgetNameExists, renameBudget, accountNameExists, ccNameExists, renameAccount, setRenameBudgetError }) {
  const [val, setVal] = useState(renameModal.currentName);
  const [err, setErr] = useState("");
  const save = () => {
    const v = toTitleCase(val.trim());
    if (!v) { setErr("Name can't be empty."); return; }
    if (renameModal.type === "budget") {
      if (budgetNameExists(v, renameModal.id)) { setErr(`A budget named "${v}" already exists.`); return; }
      renameBudget(renameModal.id, v);
    } else {
      const exists = renameModal.isCard ? ccNameExists(v, renameModal.id) : accountNameExists(v, renameModal.id);
      if (exists) { setErr(`A ${renameModal.isCard ? "credit card" : "account"} named "${v}" already exists.`); return; }
      renameAccount(renameModal.id, renameModal.isCard, v);
    }
    setRenameBudgetError(null); onClose();
  };
  return (
    <Modal title="Rename" onClose={onClose} closeLabel="Discard">
      <Inp label="New Name" value={val} onChange={e => { setVal(e.target.value); setErr(""); }} autoFocus />
      {err && <div style={{ fontSize: 12, color: C.red, marginTop: -10, marginBottom: 12 }}>{err}</div>}
      <BtnRow onCancel={onClose} onSave={save} saveLabel="Save" disabled={!val.trim()} />
    </Modal>
  );
}

// ── Settings View ─────────────────────────────────────────────
// ── Account section (Settings) ──
function AccountSection({ userAccount, onSaveUserAccount, onLogOut }) {
  const [editingName, setEditingName] = useState(false);
  const [nameInput, setNameInput] = useState(userAccount.displayName);
  const [showUpgrade, setShowUpgrade] = useState(false);
  const [upgradeEmail, setUpgradeEmail] = useState("");
  const [upgradePassword, setUpgradePassword] = useState("");
  const [upgradeName, setUpgradeName] = useState(userAccount.displayName.startsWith("Guest-") ? "" : userAccount.displayName);
  const [upgradeError, setUpgradeError] = useState("");
  const [confirmLogout, setConfirmLogout] = useState(false);

  const saveName = () => {
    if (!nameInput.trim()) { setNameInput(userAccount.displayName); setEditingName(false); return; }
    onSaveUserAccount({ ...userAccount, displayName: nameInput.trim() });
    setEditingName(false);
  };

  const submitUpgrade = () => {
    if (!upgradeName.trim()) { setUpgradeError("Please enter a display name."); return; }
    if (!upgradeEmail.trim() || !upgradeEmail.includes("@")) { setUpgradeError("Please enter a valid email."); return; }
    if (!upgradePassword || upgradePassword.length < 6) { setUpgradeError("Password must be at least 6 characters."); return; }
    onSaveUserAccount({ ...userAccount, displayName: upgradeName.trim(), email: upgradeEmail.trim(), passwordHash: upgradePassword, isGuest: false });
    setShowUpgrade(false);
  };

  const fieldSt = { width: "100%", padding: "10px 12px", borderRadius: 8, border: `1.5px solid ${C.border}`, fontSize: 14, fontFamily: "inherit", marginBottom: 10, boxSizing: "border-box" };
  const labelSt = { fontSize: 11, fontWeight: 700, color: C.muted, marginBottom: 4, display: "block" };

  return (
    <div>
      <Card style={{ marginBottom: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 4 }}>
          <div style={{ width: 44, height: 44, borderRadius: "50%", background: C.navy, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 17, fontWeight: 800, flexShrink: 0 }}>
            {userAccount.displayName.slice(0, 1).toUpperCase()}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            {editingName ? (
              <div style={{ display: "flex", gap: 6 }}>
                <input style={{ ...fieldSt, marginBottom: 0, flex: 1 }} value={nameInput} onChange={e => setNameInput(e.target.value)} onKeyDown={e => e.key === "Enter" && saveName()} autoFocus />
                <Btn small color={C.green} onClick={saveName}>Save</Btn>
              </div>
            ) : (
              <div onClick={() => { setNameInput(userAccount.displayName); setEditingName(true); }} style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
                <span style={{ fontWeight: 700, fontSize: 15 }}>{userAccount.displayName}</span>
                <span style={{ fontSize: 12, color: C.muted }}>✏️</span>
              </div>
            )}
            <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>{userAccount.isGuest ? "Guest account" : userAccount.email}</div>
          </div>
        </div>
      </Card>

      {userAccount.isGuest && !showUpgrade && (
        <Card style={{ background: "#FFF8E7", border: `1px solid ${C.amber}`, marginBottom: 14 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#7A5800", marginBottom: 4 }}>You're using a Guest account</div>
          <div style={{ fontSize: 12, color: "#7A5800", lineHeight: 1.5, marginBottom: 10 }}>Sign up to set a display name and secure your account.</div>
          <Btn small color={C.amber} onClick={() => setShowUpgrade(true)}>Sign Up</Btn>
        </Card>
      )}

      {userAccount.isGuest && showUpgrade && (
        <Card style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 12 }}>Sign Up</div>
          <label style={labelSt}>Display Name</label>
          <input style={fieldSt} value={upgradeName} onChange={e => { setUpgradeName(e.target.value); setUpgradeError(""); }} placeholder="e.g. Mick" />
          <label style={labelSt}>Email</label>
          <input style={fieldSt} type="email" value={upgradeEmail} onChange={e => { setUpgradeEmail(e.target.value); setUpgradeError(""); }} placeholder="you@example.com" />
          <label style={labelSt}>Password</label>
          <input style={fieldSt} type="password" value={upgradePassword} onChange={e => { setUpgradePassword(e.target.value); setUpgradeError(""); }} placeholder="At least 6 characters" />
          {upgradeError && <div style={{ fontSize: 12, color: C.red, marginBottom: 10 }}>{upgradeError}</div>}
          <div style={{ display: "flex", gap: 8 }}>
            <Btn outline color={C.muted} onClick={() => { setShowUpgrade(false); setUpgradeError(""); }} style={{ flex: 1 }}>Cancel</Btn>
            <Btn color={C.navy} onClick={submitUpgrade} style={{ flex: 1 }}>Sign Up</Btn>
          </div>
        </Card>
      )}

      {/* Phase 2 seam: budget sharing, gated behind a real account */}
      <Card style={{ marginBottom: 14, opacity: 0.55 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 700 }}>🔒 Share Budget</div>
            <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>{userAccount.isGuest ? "Sign up to share budgets" : "Coming soon"}</div>
          </div>
          <Btn small outline color={C.muted} disabled>Share</Btn>
        </div>
      </Card>

      <div style={{ fontSize: 11, color: C.muted, padding: "0 4px", marginBottom: 14, wordBreak: "break-all" }}>User ID: {userAccount.userId}</div>

      {!confirmLogout ? (
        <Btn outline color={C.red} onClick={() => setConfirmLogout(true)} style={{ width: "100%" }}>Log Out</Btn>
      ) : (
        <Card style={{ border: `1px solid ${C.red}` }}>
          <div style={{ fontSize: 13, color: C.textLight, marginBottom: 10, lineHeight: 1.5 }}>Log out? This clears your local account on this device. There's no separate backend yet, so this cannot be undone.</div>
          <div style={{ display: "flex", gap: 8 }}>
            <Btn outline color={C.muted} onClick={() => setConfirmLogout(false)} style={{ flex: 1 }}>Cancel</Btn>
            <Btn color={C.red} onClick={onLogOut} style={{ flex: 1 }}>Log Out</Btn>
          </div>
        </Card>
      )}
    </div>
  );
}

function SettingsView({ appData, onSave, budget, updateBudget, getAccountBalance, renameAccount, accountNameExists, ccNameExists, userAccount, onSaveUserAccount, onLogOut }) {
  const [section, setSection] = useState("account");
  const [modal, setModal] = useState(null);
  const [newBudgetName, setNewBudgetName] = useState(""); const [copyFrom, setCopyFrom] = useState("");
  const [newAccName, setNewAccName] = useState(""); const [newAccType, setNewAccType] = useState("checking"); const [newAccBal, setNewAccBal] = useState(null);
  const [newCCName, setNewCCName] = useState(""); const [newCCBal, setNewCCBal] = useState(null);
  const [importPreview, setImportPreview] = useState(null);
  const [importError, setImportError] = useState("");
  const [addAccError, setAddAccError] = useState("");
  const [addCCError, setAddCCError] = useState("");
  const [contextMenu, setContextMenu] = useState(null);
  const [renameModal, setRenameModal] = useState(null); // { id, currentName, type: "account"|"card"|"budget", isCard }
  const longPressTimer = useRef(null);
  const bindCtx = (items) => ({
    onTouchStart: (e) => { longPressTimer.current = setTimeout(() => setContextMenu({ items }), 500); },
    onTouchEnd: () => { clearTimeout(longPressTimer.current); longPressTimer.current = null; },
    onTouchMove: () => { clearTimeout(longPressTimer.current); longPressTimer.current = null; },
    onContextMenu: (e) => { e.preventDefault(); setContextMenu({ items }); },
  });
  const fileInputRef = useRef(null);
  const [deleteBudgetConfirm, setDeleteBudgetConfirm] = useState(null);
  const [confirmAction, setConfirmAction] = useState(null);
  const activeBudgets = appData.budgets.filter(b => !b.archived); const archivedBudgets = appData.budgets.filter(b => b.archived);
  const switchBudget = (id) => onSave({ ...appData, activeBudgetId: id });
  const renameBudget = (id, name) => onSave({ ...appData, budgets: appData.budgets.map(b => b.id === id ? { ...b, name } : b) });
  const archiveBudget = (id) => { if (id === appData.activeBudgetId) return; onSave({ ...appData, budgets: appData.budgets.map(b => b.id === id ? { ...b, archived: true } : b) }); };
  const restoreBudget = (id) => onSave({ ...appData, budgets: appData.budgets.map(b => b.id === id ? { ...b, archived: false } : b) });
  const deleteBudget = (id) => {
    if (id === appData.activeBudgetId) return;
    onSave({ ...appData, budgets: appData.budgets.filter(b => b.id !== id) });
  };
  const [newBudgetNameError, setNewBudgetNameError] = useState("");
  const [renameBudgetError, setRenameBudgetError] = useState(null); // { id, message }
  const budgetNameExists = (name, excludeId) => appData.budgets.some(b => b.id !== excludeId && b.name.trim().toLowerCase() === name.trim().toLowerCase());
  const createBudget = (blank) => {
    if (!newBudgetName.trim()) return;
    if (budgetNameExists(newBudgetName, null)) { setNewBudgetNameError(`A budget named "${newBudgetName.trim()}" already exists. Choose a different name.`); return; }
    const source = appData.budgets.find(b => b.id === copyFrom);
    const newB = { id: uid(), name: newBudgetName, createdAt: new Date().toISOString(), archived: false, accounts: [], creditCards: [], categoryGroups: blank || !source ? DEFAULT_GROUPS.map(g => ({ ...g })) : source.categoryGroups.filter(g => !source.categories.find(c => c.groupId === g.id && c.creditCardId)), categories: blank || !source ? DEFAULT_CATS.map(c => ({ ...c })) : source.categories.filter(c => !c.creditCardId), monthlyBudgets: {}, transactions: [], inflows: {}, payees: [], pendingDuplicates: [] };
    onSave({ ...appData, budgets: [...appData.budgets, newB], activeBudgetId: newB.id }); setNewBudgetName(""); setCopyFrom(""); setNewBudgetNameError(""); setModal(null);
  };
  const addAccount = () => {
    if (!newAccName || newAccBal === null) return;
    if (accountNameExists(newAccName, null)) { setAddAccError(`An account named "${newAccName.trim()}" already exists. Choose a different name.`); return; }
    const cm = toKey(new Date());
    const today = new Date().toISOString().slice(0, 10);
    const accId = uid();
    const startingTx = { id: uid(), date: today, payee: "Starting Balance", originalPayee: "Starting Balance", note: "", type: "income", subtype: "starting_balance", accountId: accId, categoryId: null, amount: newAccBal, reconciled: true };
    updateBudget({
      // balance: 0 because getAccountBalance starts from acc.balance and adds income txs.
      // The Starting Balance transaction provides the balance — storing newAccBal here would double it.
      accounts: [...budget.accounts, { id: accId, name: toTitleCase(newAccName.trim()), type: newAccType, balance: 0 }],
      transactions: [...budget.transactions, startingTx],
      inflows: { ...budget.inflows, [cm]: (budget.inflows[cm] || 0) + newAccBal },
    });
    setNewAccName(""); setNewAccBal(null); setNewAccType("checking"); setAddAccError(""); setModal(null);
  };
  const addCC = () => {
    if (!newCCName || newCCBal === null) return;
    if (ccNameExists(newCCName, null)) { setAddCCError(`A credit card named "${newCCName.trim()}" already exists. Choose a different name.`); return; }
    const eg = budget.categoryGroups.find(g => g.name === "Credit Card Payments"); const ccGroup = eg || { id: uid(), name: "Credit Card Payments" };
    const ccName = toTitleCase(newCCName.trim());
    const nid = uid();
    const ccCat = { id: uid(), groupId: ccGroup.id, name: `${ccName} Payment`, creditCardId: nid, rollover: "rollover" };
    const newCC = { id: nid, name: ccName, balance: 0 };
    const cm = toKey(new Date());
    const today = new Date().toISOString().slice(0, 10);
    // Pre-load CC payment category budget for existing balance
    const nMB = newCCBal > 0 ? { ...budget.monthlyBudgets, [cm]: { ...(budget.monthlyBudgets[cm] || {}), [ccCat.id]: newCCBal } } : budget.monthlyBudgets;
    // Create a locked Starting Balance transaction for the card
    const startingTx = newCCBal > 0 ? { id: uid(), date: today, payee: "Starting Balance", originalPayee: "Starting Balance", note: "", type: "expense", subtype: "starting_balance", accountId: nid, categoryId: ccCat.id, amount: newCCBal, reconciled: true } : null;
    updateBudget({
      creditCards: [...budget.creditCards, newCC],
      categoryGroups: eg ? budget.categoryGroups : [...budget.categoryGroups, ccGroup],
      categories: [...budget.categories, ccCat],
      monthlyBudgets: nMB,
      transactions: startingTx ? [...budget.transactions, startingTx] : budget.transactions,
    });
    setNewCCName(""); setNewCCBal(null); setAddCCError(""); setModal(null);
  };
  const SECS = [["account", "👤", "Account"], ["budgets", "💰", "Budgets"], ["data", "💾", "Data"]];
  return (
    <div style={{ paddingBottom: 20 }}>
      <div style={{ display: "flex", background: C.surface, borderBottom: `1px solid ${C.border}` }}>
        {SECS.map(([id, icon, label]) => (<button key={id} onClick={() => setSection(id)} style={{ flex: 1, padding: "13px 8px", background: "none", border: "none", borderBottom: section === id ? `3px solid ${C.navy}` : "3px solid transparent", fontSize: 13, fontWeight: section === id ? 700 : 400, color: section === id ? C.navy : C.muted, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 5 }}><span>{icon}</span><span>{label}</span></button>))}
      </div>
      <div style={{ padding: 16 }}>
        {section === "account" && (<AccountSection userAccount={userAccount} onSaveUserAccount={onSaveUserAccount} onLogOut={onLogOut} />)}
        {section === "budgets" && (<>
          <div style={{ fontSize: 11, fontWeight: 700, color: C.textLight, marginBottom: 10, textTransform: "uppercase", letterSpacing: "0.07em" }}>Active Budgets</div>
          {activeBudgets.map(b => (<Card key={b.id} {...bindCtx([{ label: "✏️ Rename", onClick: () => setRenameModal({ id: b.id, currentName: b.name, type: "budget" }) }])} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", borderLeft: `4px solid ${b.id === appData.activeBudgetId ? C.green : C.border}`, touchAction: "none", WebkitUserSelect: "none", userSelect: "none" }}><div style={{ flex: 1, marginRight: 10 }}><div style={{ fontWeight: 700, fontSize: 15, marginBottom: 2 }}>{b.name}</div>{renameBudgetError?.id === b.id && <div style={{ fontSize: 11, color: C.red, marginTop: 2 }}>{renameBudgetError.message}</div>}<div style={{ fontSize: 12, color: b.id === appData.activeBudgetId ? C.green : C.muted, marginTop: 4 }}>{b.id === appData.activeBudgetId ? "✓ Currently active" : `Created ${new Date(b.createdAt).toLocaleDateString()}`}</div></div><div style={{ display: "flex", gap: 8 }}>{b.id !== appData.activeBudgetId && <><Btn small color={C.navy} onClick={() => switchBudget(b.id)}>Switch</Btn><Btn small outline color={C.muted} onClick={() => archiveBudget(b.id)}>Archive</Btn></>}</div></Card>))}
          {archivedBudgets.length > 0 && (<><div style={{ fontSize: 11, fontWeight: 700, color: C.textLight, marginBottom: 10, marginTop: 20, textTransform: "uppercase" }}>Archived</div>{archivedBudgets.map(b => (<Card key={b.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", opacity: 0.65 }}><div style={{ fontWeight: 700, fontSize: 15 }}>{b.name}</div><div style={{ display: "flex", gap: 8 }}><Btn small color={C.green} onClick={() => restoreBudget(b.id)}>Restore</Btn><Btn small outline color={C.red} onClick={() => setDeleteBudgetConfirm(b)}>Delete</Btn></div></Card>))}</>)}
          <Btn color={C.navy} onClick={() => setModal("newBudget")} style={{ marginTop: 16, width: "100%" }}>+ Create New Budget</Btn>
        </>)}
        {section === "data" && (<>
          <div style={{ fontSize: 11, fontWeight: 700, color: C.textLight, marginBottom: 10, textTransform: "uppercase", letterSpacing: "0.07em" }}>Backup & Restore</div>
          <div style={{ fontSize: 13, color: C.textLight, marginBottom: 16, lineHeight: 1.6 }}>
            Export a backup file of everything in ClearBudget — all budgets, accounts, transactions, and settings. Keep it somewhere safe so you can restore it later if needed.
          </div>
          <Btn color={C.navy} onClick={() => {
            const blob = new Blob([JSON.stringify(appData, null, 2)], { type: "application/json" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url; a.download = `clearbudget-backup-${new Date().toISOString().slice(0, 10)}.json`;
            document.body.appendChild(a); a.click(); document.body.removeChild(a);
            URL.revokeObjectURL(url);
          }} style={{ width: "100%", marginBottom: 24 }}>📤 Export Backup</Btn>

          <div style={{ fontSize: 11, fontWeight: 700, color: C.textLight, marginBottom: 10, textTransform: "uppercase", letterSpacing: "0.07em" }}>Restore from Backup</div>
          <div style={{ fontSize: 13, color: C.textLight, marginBottom: 16, lineHeight: 1.6 }}>
            Choose a backup file you exported earlier. This <strong>replaces everything</strong> currently in ClearBudget. This can be undone with the Undo button afterward if needed.
          </div>
          <input ref={fileInputRef} type="file" accept="application/json,.json" style={{ display: "none" }} onChange={e => {
            const file = e.target.files[0]; if (!file) return;
            setImportError("");
            const reader = new FileReader();
            reader.onload = (ev) => {
              try {
                const parsed = JSON.parse(ev.target.result);
                if (!parsed || !Array.isArray(parsed.budgets)) { setImportError("This doesn't look like a ClearBudget backup file."); return; }
                setImportPreview(parsed);
              } catch { setImportError("Couldn't read that file — make sure it's a ClearBudget backup (.json)."); }
            };
            reader.readAsText(file);
            e.target.value = "";
          }} />
          <Btn outline color={C.navy} onClick={() => fileInputRef.current?.click()} style={{ width: "100%" }}>📥 Import Backup</Btn>
          {importError && <div style={{ fontSize: 12, color: C.red, marginTop: 10 }}>{importError}</div>}

          {/* Mobile clipboard fallback — remove this box once file export/import works on device */}
          <div style={{ marginTop: 20, border: `2px solid ${C.amber}`, borderRadius: 10, padding: 14, background: "#FFF8E7" }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: C.amber, textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 8 }}>📱 Mobile Clipboard Backup</div>
            <div style={{ fontSize: 12, color: "#7A5800", marginBottom: 12, lineHeight: 1.5 }}>
              Use these if the export/import buttons above don't work on your device. Copy copies the full backup JSON to your clipboard. Paste reads JSON from your clipboard to restore.
            </div>
            <Btn color={C.amber} onClick={async () => {
              try {
                await navigator.clipboard.writeText(JSON.stringify(appData, null, 2));
                alert("✅ Backup copied to clipboard!");
              } catch { alert("❌ Clipboard access denied. Try the export button above."); }
            }} style={{ width: "100%", marginBottom: 8 }}>📋 Copy Backup to Clipboard</Btn>
            <Btn outline color={C.amber} onClick={async () => {
              try {
                const text = await navigator.clipboard.readText();
                const parsed = JSON.parse(text);
                if (!parsed || !Array.isArray(parsed.budgets)) { alert("❌ Clipboard doesn't contain a valid ClearBudget backup."); return; }
                setImportPreview(parsed);
              } catch { alert("❌ Couldn't read clipboard. Make sure you've copied a ClearBudget backup first."); }
            }} style={{ width: "100%" }}>📋 Paste Backup from Clipboard</Btn>
          </div>

          <div style={{ fontSize: 11, fontWeight: 700, color: C.textLight, marginBottom: 10, marginTop: 32, textTransform: "uppercase", letterSpacing: "0.07em" }}>Factory Reset</div>
          <div style={{ fontSize: 13, color: C.textLight, marginBottom: 16, lineHeight: 1.6 }}>
            Wipes everything stored in this copy of ClearBudget and takes you back to the setup wizard, as if you'd just opened it for the first time. Useful if a freshly published copy carried over old data and you want a clean start. Export a backup first if you want to keep anything.
          </div>
          <Btn outline color={C.red} onClick={() => setModal("factoryResetConfirm")} style={{ width: "100%" }}>🗑 Factory Reset</Btn>

          {/* ── Testing tools — remove when done ── */}
          <div style={{ marginTop: 20, border: `2px solid ${C.amber}`, borderRadius: 10, padding: 14, background: "#FFF8E7" }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: C.amber, textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 8 }}>🧪 Testing Tools</div>
            <div style={{ fontSize: 12, color: "#7A5800", marginBottom: 12, lineHeight: 1.5 }}>These buttons are for testing only and should be removed before go-live.</div>
            <Btn color={C.amber} onClick={() => setConfirmAction({ message: "This will erase all data temporarily and open the setup wizard. Your real data is NOT saved. Use this only to test the wizard flow.", onConfirm: () => onSave({ setupComplete: false, activeBudgetId: null, budgets: [] }) })} style={{ width: "100%" }}>🧪 Test Wizard (Erases Data)</Btn>
            <div style={{ fontSize: 11, color: "#7A5800", marginTop: 6 }}>Temporarily clears everything and opens the setup wizard. Restore from backup after testing.</div>
          </div>

          <div style={{ textAlign: "center", fontSize: 11, color: C.muted, marginTop: 32 }}>ClearBudget · v{APP_VERSION}</div>
        </>)}
      </div>

      {modal === "factoryResetConfirm" && (
        <Modal title="Factory Reset?" onClose={() => setModal(null)}>
          <div style={{ fontSize: 13, color: C.red, marginBottom: 10, fontWeight: 600 }}>
            This permanently erases everything in this copy of ClearBudget — all budgets, accounts, transactions, and settings — and reopens the setup wizard.
          </div>
          <div style={{ fontSize: 12, color: C.textLight, marginBottom: 16 }}>This cannot be undone. Export a backup first (above) if you want to keep a copy.</div>
          <div style={{ display: "flex", gap: 10 }}>
            <Btn outline color={C.muted} onClick={() => setModal(null)} style={{ flex: 1 }}>Cancel</Btn>
            <Btn color={C.red} onClick={() => { onSave({ setupComplete: false, activeBudgetId: null, budgets: [] }); setModal(null); }} style={{ flex: 1 }}>Erase Everything</Btn>
          </div>
        </Modal>
      )}
      {modal === "newBudget" && (<Modal title="Create New Budget" onClose={() => setModal(null)} closeLabel="Discard"><Inp label="Budget Name" placeholder="e.g. Business Budget..." value={newBudgetName} onChange={e => { setNewBudgetName(e.target.value); setNewBudgetNameError(""); }} autoFocus />{newBudgetNameError && <div style={{ fontSize: 12, color: C.red, marginTop: -10, marginBottom: 12 }}>{newBudgetNameError}</div>}<div style={{ display: "flex", flexDirection: "column", gap: 10 }}><Btn color={C.navy} onClick={() => createBudget(true)} disabled={!newBudgetName.trim()}>Start Completely Blank</Btn><div style={{ textAlign: "center", fontSize: 12, color: C.muted }}>— or —</div><Sel label="Copy categories from" value={copyFrom} onChange={e => setCopyFrom(e.target.value)}><option value="">Select a budget...</option>{appData.budgets.filter(b => !b.archived).map(b => <option key={b.id} value={b.id}>{b.name}</option>)}</Sel><Btn color={C.green} onClick={() => createBudget(false)} disabled={!newBudgetName.trim() || !copyFrom}>Copy & Create</Btn></div></Modal>)}
      {deleteBudgetConfirm && (
        <Modal title="Delete Budget?" onClose={() => setDeleteBudgetConfirm(null)}>
          <div style={{ fontSize: 13, color: C.red, marginBottom: 10, fontWeight: 600 }}>
            Permanently delete "{deleteBudgetConfirm.name}"? All of its accounts, categories, and transaction history will be gone for good.
          </div>
          <div style={{ fontSize: 12, color: C.textLight, marginBottom: 16 }}>Consider exporting a backup first (Data tab) if you might want this later. You can Undo right after if needed.</div>
          <div style={{ display: "flex", gap: 10 }}>
            <Btn outline color={C.muted} onClick={() => setDeleteBudgetConfirm(null)} style={{ flex: 1 }}>Cancel</Btn>
            <Btn color={C.red} onClick={() => { deleteBudget(deleteBudgetConfirm.id); setDeleteBudgetConfirm(null); }} style={{ flex: 1 }}>Delete Permanently</Btn>
          </div>
        </Modal>
      )}
      {importPreview && (
        <Modal title="Restore from Backup?" onClose={() => setImportPreview(null)}>
          <div style={{ fontSize: 13, color: C.red, marginBottom: 10, fontWeight: 600 }}>
            This will replace everything currently in ClearBudget with this backup ({importPreview.budgets.length} budget{importPreview.budgets.length !== 1 ? "s" : ""}).
          </div>
          <div style={{ fontSize: 12, color: C.textLight, marginBottom: 16 }}>You can Undo right after if this wasn't what you meant to do.</div>
          <div style={{ display: "flex", gap: 10 }}>
            <Btn outline color={C.muted} onClick={() => setImportPreview(null)} style={{ flex: 1 }}>Cancel</Btn>
            <Btn color={C.red} onClick={() => { onSave(importPreview); setImportPreview(null); }} style={{ flex: 1 }}>Restore Backup</Btn>
          </div>
        </Modal>
      )}

      {modal === "addAccount" && (<Modal title="Add Account" onClose={() => setModal(null)} closeLabel="Discard"><div style={{ background: "#EAF6F0", border: `1px solid #A8DFBF`, borderRadius: 8, padding: 10, fontSize: 12, color: "#1A5C36", marginBottom: 14 }}>💡 Balance added to Ready to Assign.</div><Inp label="Account Name" placeholder="Chase Checking" value={newAccName} onChange={e => { setNewAccName(e.target.value); setAddAccError(""); }} onKeyDown={e => { if (e.key === "Enter" && newAccName && newAccBal !== null) addAccount(); }} autoFocus /><div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}><Sel label="Type" value={newAccType} onChange={e => setNewAccType(e.target.value)}><option value="checking">Checking</option><option value="savings">Savings</option><option value="cash">Cash</option></Sel><AmountInput label="Balance ($)" initialValue={newAccBal !== null ? newAccBal : undefined} onChange={v => setNewAccBal(v)} onCommit={v => setNewAccBal(v)} onKeyDown={e => { if (e.key === "Enter" && newAccName && newAccBal !== null) addAccount(); }} placeholder="e.g. 1000" /></div>{addAccError && <div style={{ fontSize: 12, color: C.red, marginTop: -6, marginBottom: 12 }}>{addAccError}</div>}<BtnRow onCancel={() => setModal(null)} onSave={addAccount} saveLabel="Add Account" saveColor={C.green} disabled={!newAccName || newAccBal === null} /></Modal>)}
      {modal === "addCC" && (<Modal title="Add Credit Card" onClose={() => setModal(null)} closeLabel="Discard"><div style={{ background: "#EAF6F0", border: `1px solid #A8DFBF`, borderRadius: 8, padding: 10, fontSize: 12, color: "#1A5C36", marginBottom: 14 }}>💡 Existing balance will be reserved in your budget.</div><Inp label="Card Name" placeholder="Chase Visa, Amex Blue..." value={newCCName} onChange={e => { setNewCCName(e.target.value); setAddCCError(""); }} onKeyDown={e => { if (e.key === "Enter" && newCCName && newCCBal !== null) addCC(); }} autoFocus /><AmountInput label="Balance Owed ($)" initialValue={newCCBal !== null ? newCCBal : undefined} onChange={v => setNewCCBal(v)} onCommit={v => setNewCCBal(v)} onKeyDown={e => { if (e.key === "Enter" && newCCName && newCCBal !== null) addCC(); }} placeholder="e.g. 450.00" />{addCCError && <div style={{ fontSize: 12, color: C.red, marginTop: -6, marginBottom: 12 }}>{addCCError}</div>}<BtnRow onCancel={() => setModal(null)} onSave={addCC} saveLabel="Add Card" saveColor={C.green} disabled={!newCCName || newCCBal === null} /></Modal>)}

      {renameModal && <SettingsRenameModal renameModal={renameModal} onClose={() => setRenameModal(null)} budgetNameExists={budgetNameExists} renameBudget={renameBudget} accountNameExists={accountNameExists} ccNameExists={ccNameExists} renameAccount={renameAccount} setRenameBudgetError={setRenameBudgetError} />}
      {contextMenu && <ContextMenu items={contextMenu.items} onClose={() => setContextMenu(null)} />}

      {confirmAction && (
        <Modal title="Are you sure?" onClose={() => setConfirmAction(null)}>
          <div style={{ fontSize: 13, color: C.textLight, marginBottom: 16, lineHeight: 1.6 }}>{confirmAction.message}</div>
          <div style={{ display: "flex", gap: 10 }}>
            <Btn outline color={C.muted} onClick={() => setConfirmAction(null)} style={{ flex: 1 }}>No, Cancel</Btn>
            <Btn color={C.red} onClick={() => { confirmAction.onConfirm(); setConfirmAction(null); }} style={{ flex: 1 }}>Yes, Continue</Btn>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ── Recap Modal ──────────────────────────────────────────────
function RecapModal({ months, onClose }) {
  const grandTotal = months.reduce((s, m) => s + m.total, 0);
  return (
    <Modal title="✨ Auto-Assign Recap" onClose={onClose}>
      <div style={{ fontSize: 13, color: C.textLight, marginBottom: 16 }}>Here's everything that was assigned:</div>
      {months.map(m => (
        <div key={m.month} style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 12, fontWeight: 800, color: C.navy, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6, paddingBottom: 4, borderBottom: `2px solid ${C.border}` }}>{keyLabelShort(m.month)}</div>
          {m.items.map((item, i) => (
            <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "5px 0", fontSize: 13 }}>
              <span>{item.name}</span>
              <span style={{ fontWeight: 700, color: C.green }}>+{fmt(item.amount)}</span>
            </div>
          ))}
          <div style={{ display: "flex", justifyContent: "space-between", padding: "6px 0 0", fontSize: 12, fontWeight: 700, color: C.textLight, borderTop: `1px solid #F4F1EB`, marginTop: 4 }}>
            <span>Subtotal</span><span>{fmt(m.total)}</span>
          </div>
        </div>
      ))}
      <div style={{ display: "flex", justifyContent: "space-between", padding: "12px 0 0", fontSize: 15, fontWeight: 800, color: C.navy, borderTop: `2px solid ${C.navy}`, marginTop: 8 }}>
        <span>Total Assigned</span><span>{fmt(grandTotal)}</span>
      </div>
      <Btn color={C.navy} onClick={onClose} style={{ width: "100%", marginTop: 20 }}>Done</Btn>
    </Modal>
  );
}

// ── Payees View ──────────────────────────────────────────────
function PayeesView({ budget, updateBudget, canonicalNames, getOriginalsForCanonical, getDisplayName, getPayeeDefaultCategory, setPayeeDefaultCategory, getPayeeSuggestedCategory, setPayeeSuggestedCategory, setCanonicalForNames, unmergeOriginal, unmergeAllForCanonical, unmergeAllPayees, clearAllPayeeDefaults, goToTransactions, suggestMergeNav, onMergeNavConsumed, rejectedMerges = [], onRejectMerge }) {
  const [selected, setSelected] = useState([]);
  const [mergeModal, setMergeModal] = useState(false);
  const [canonical, setCanonical] = useState("");
  const [customName, setCustomName] = useState("");
  const [confirmAction, setConfirmAction] = useState(null);
  const [contextMenu, setContextMenu] = useState(null);
  const [displayNameTarget, setDisplayNameTarget] = useState(null); // canonical name being edited
  const [displayNameCustom, setDisplayNameCustom] = useState("");
  const [displayNameError, setDisplayNameError] = useState("");
  const [payeeSearch, setPayeeSearch] = useState("");
  const [suggestMergeModal, setSuggestMergeModal] = useState(null);
  const [mergeNameFocused, setMergeNameFocused] = useState(false);
  const [excludeWordModal, setExcludeWordModal] = useState(false);
  const [excludeWordInput, setExcludeWordInput] = useState("");

  const addExcludeWords = () => {
    const existing = budget.mergeExcludeWords || ["TST*"];
    const newWords = excludeWordInput.split(",").map(w => w.trim()).filter(w => w && !existing.includes(w));
    if (newWords.length === 0) { setExcludeWordModal(false); setExcludeWordInput(""); return; }
    updateBudget({ mergeExcludeWords: [...existing, ...newWords] });
    setExcludeWordModal(false);
    setExcludeWordInput("");
  };
  const longPressTimer = useRef(null);
  const nameInputRef = useRef(null);
  const suggestMergeCurrentIdx = suggestMergeModal?.currentIdx ?? -1;
  useEffect(() => {
    if (nameInputRef.current) {
      nameInputRef.current.focus();
      requestAnimationFrame(() => { try { nameInputRef.current?.select(); } catch {} });
    }
  }, [suggestMergeCurrentIdx]);
  const bindContextMenu = (items) => ({
    onTouchStart: () => { longPressTimer.current = setTimeout(() => setContextMenu({ items }), 500); },
    onTouchEnd: () => { if (longPressTimer.current) { clearTimeout(longPressTimer.current); longPressTimer.current = null; } },
    onTouchMove: () => { if (longPressTimer.current) { clearTimeout(longPressTimer.current); longPressTimer.current = null; } },
    onContextMenu: (e) => { e.preventDefault(); setContextMenu({ items }); },
  });

  const toggle = (name) => setSelected(p => p.includes(name) ? p.filter(n => n !== name) : [...p, name]);
  const txCount = (canonicalName) => budget.transactions.filter(tx => tx.subtype !== "starting_balance" && getDisplayName(tx.originalPayee) === canonicalName).length;
  const sorted = [...canonicalNames].filter(n => txCount(n) > 0).sort((a, b) => a.localeCompare(b));
  const qLow = normalizeSearch(payeeSearch);
  const visiblePayees = qLow ? sorted.filter(n => normalizeSearch(n).includes(qLow)) : sorted;

  // ── Suggested merge detection ──
  const suggestedMergeGroups = buildMergeGroups(sorted, rejectedMerges, budget.mergeExcludeWords || []);

  // Convert raw name groups into modal group objects with shared-word default name pre-filled

  // Open merge modal when navigated here from budget/transactions notification
  useEffect(() => {
    if (suggestMergeNav && suggestedMergeGroups.length > 0) {
      setSuggestMergeModal({ groups: toModalGroups(suggestedMergeGroups), currentIdx: 0 });
      onMergeNavConsumed?.();
    }
  }, [suggestMergeNav]);

  // Close the suggest-merge modal when currentIdx runs past the end of groups (all reviewed)
  useEffect(() => {
    if (suggestMergeModal && suggestMergeModal.currentIdx >= suggestMergeModal.groups.length) {
      setSuggestMergeModal(null);
    }
  }, [suggestMergeModal]);

  // Auto-chain: when one merge review session ends, if new suggestions have appeared
  // (from the merges just applied), automatically start the next session without
  // requiring the user to tap the notification again.
  const mergeSessionWasActiveRef = useRef(false);
  const userClosedMergeRef = useRef(false); // true when user presses X (suppresses auto-chain)
  useEffect(() => {
    if (suggestMergeModal !== null) {
      mergeSessionWasActiveRef.current = true;
      return;
    }
    if (!mergeSessionWasActiveRef.current) return;
    mergeSessionWasActiveRef.current = false;
    if (userClosedMergeRef.current) {
      // User explicitly closed — don't auto-chain, just clear the flag
      userClosedMergeRef.current = false;
      return;
    }
    if (suggestedMergeGroups.length > 0) {
      setSuggestMergeModal({ groups: toModalGroups(suggestedMergeGroups), currentIdx: 0 });
    }
  }, [suggestMergeModal, suggestedMergeGroups.length]);

  const finalCanonical = customName.trim() ? customName.trim() : canonical;
  const collision = customName.trim() && canonicalNames.find(n => n.toLowerCase() === customName.trim().toLowerCase() && !selected.includes(n));
  const confirmMerge = () => {
    const allOriginals = selected.flatMap(cn => getOriginalsForCanonical(cn));
    setCanonicalForNames(allOriginals, finalCanonical);
    setSelected([]); setMergeModal(false); setCustomName("");
  };

  return (
    <div style={{ padding: 16, paddingBottom: 80 }}>
      <div style={{ fontSize: 13, color: C.textLight, marginBottom: 12, lineHeight: 1.6 }}>
        Set a default or suggested category for a payee. Default auto-fills and confirms. Suggested auto-fills but shows as unconfirmed. Select two or more to merge duplicates.
      </div>

      {/* Search box */}
      <input value={payeeSearch} onChange={e => setPayeeSearch(e.target.value)} placeholder="🔍 Search payees..." style={{ ...inputSt, marginBottom: 10 }} />

      {/* Suggested merges banner */}
      {suggestedMergeGroups.length > 0 && (
        <button onClick={() => setSuggestMergeModal({ groups: toModalGroups(suggestedMergeGroups), currentIdx: 0 })}
          style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", textAlign: "left", background: "#EEF0FF", border: `1px solid ${C.purple}`, borderRadius: 8, padding: "10px 12px", fontSize: 13, color: C.purple, cursor: "pointer", fontFamily: "inherit", marginBottom: 12, fontWeight: 600 }}>
          🔀 {suggestedMergeGroups.length} suggested merge{suggestedMergeGroups.length !== 1 ? "s" : ""} — tap to review
        </button>
      )}

      {sorted.length === 0 ? (
        <div style={{ textAlign: "center", padding: "40px 20px", color: C.muted }}><div style={{ fontSize: 36, marginBottom: 8 }}>👥</div><div>No payees yet</div></div>
      ) : (
        <div style={{ border: `1px solid ${C.border}`, borderRadius: 10, overflow: "hidden", background: C.surface }}>
          <div style={{ display: "grid", gridTemplateColumns: "24px 1fr 1fr 32px", gap: 8, padding: "8px 10px", background: "#F8F6F2", borderBottom: `1px solid ${C.border}`, fontSize: 10, fontWeight: 700, color: C.muted, textTransform: "uppercase", letterSpacing: "0.05em" }}>
            <span></span><span>Payee</span><span>Category</span><span style={{ textAlign: "right" }}>#</span>
          </div>
          {visiblePayees.length === 0 && <div style={{ padding: "20px", textAlign: "center", fontSize: 13, color: C.muted }}>No payees match "{payeeSearch}"</div>}
          {visiblePayees.map(name => {
            const originals = getOriginalsForCanonical(name);
            const isMerged = originals.some(o => o !== name);
            const defCat = getPayeeDefaultCategory(name);
            const sugCat = getPayeeSuggestedCategory(name);
            const mode = defCat ? "default" : sugCat ? "suggested" : "none";
            const activeCatId = defCat || sugCat || "";
            return (
              <div key={name} {...bindContextMenu([
                { label: "✏️ Set Display Name", onClick: () => { setDisplayNameTarget(name); setDisplayNameCustom(""); setDisplayNameError(""); } },
                { label: isMerged ? `↩ Unmerge All (${originals.length})` : "↩ Unmerge", disabled: !isMerged, onClick: () => setConfirmAction({ message: `Unmerge all original payee names from "${name}"? Each original name will revert to displaying itself.`, onConfirm: () => unmergeAllForCanonical(originals) }) },
              ])} style={{ borderBottom: "1px solid #F4F1EB", WebkitTouchCallout: "none", WebkitUserSelect: "none", userSelect: "none" }}>
                <div style={{ display: "grid", gridTemplateColumns: "24px 1fr 1fr 32px", gap: 8, padding: "8px 10px", alignItems: "center" }}>
                  <input type="checkbox" checked={selected.includes(name)} onChange={() => toggle(name)} style={{ width: 15, height: 15 }} />
                  <div onClick={() => { setDisplayNameTarget(name); setDisplayNameCustom(""); setDisplayNameError(""); }} style={{ fontSize: 13, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", cursor: "pointer", textDecoration: "underline", textDecorationStyle: "dotted" }}>
                    {name}
                    {isMerged && <span style={{ fontSize: 10, color: C.muted, fontWeight: 400, marginLeft: 4 }}>({originals.length})</span>}
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <div style={{ display: "flex", gap: 4 }}>
                      {["none", "default", "suggested"].map(m => (
                        <button key={m} onClick={() => {
                          if (m === "none") { setPayeeDefaultCategory(name, ""); setPayeeSuggestedCategory(name, ""); }
                          else if (m === "default") { setPayeeDefaultCategory(name, activeCatId || (budget.categories.find(c => !c.archived && !c.creditCardId)?.id || "")); }
                          else { setPayeeSuggestedCategory(name, activeCatId || (budget.categories.find(c => !c.archived && !c.creditCardId)?.id || "")); }
                        }} style={{ fontSize: 9, fontWeight: 700, padding: "2px 5px", borderRadius: 4, border: `1.5px solid ${mode === m ? (m === "default" ? C.green : m === "suggested" ? C.amber : C.muted) : C.border}`, background: mode === m ? (m === "default" ? "#EAF6F0" : m === "suggested" ? "#FFF8E7" : "#F0EEE9") : "transparent", color: mode === m ? (m === "default" ? C.green : m === "suggested" ? C.amber : C.muted) : C.muted, cursor: "pointer", fontFamily: "inherit", textTransform: "capitalize" }}>
                          {m === "none" ? "—" : m}
                        </button>
                      ))}
                    </div>
                    {mode !== "none" && (
                      <select value={activeCatId} onChange={e => {
                        if (mode === "default") setPayeeDefaultCategory(name, e.target.value);
                        else setPayeeSuggestedCategory(name, e.target.value);
                      }} style={{ ...inputSt, padding: "3px 5px", fontSize: 11 }}>
                        <option value="">—</option>
                        {budget.categoryGroups.map(g => (<optgroup key={g.id} label={g.name}>{budget.categories.filter(c => c.groupId === g.id && !c.archived).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</optgroup>))}
                      </select>
                    )}
                  </div>
                  <div onClick={() => goToTransactions({ payee: name })} style={{ fontSize: 12, color: C.muted, textAlign: "right", cursor: "pointer", textDecoration: "underline", textDecorationStyle: "dotted" }}>{txCount(name)}</div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Global payee management actions */}
      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 16 }}>
        <Btn small outline color={C.muted} disabled={!(budget.payees || []).some(p => p.defaultCategoryId || p.suggestedCategoryId)}
          onClick={() => setConfirmAction({ message: "Remove all default and suggested categories? Every payee's category setting will be cleared.", onConfirm: clearAllPayeeDefaults })}>
          🗑 Remove All Category Settings
        </Btn>
      </div>

      {/* Unmerge All Payees — bordered section */}
      <div style={{ marginTop: 16, border: `1.5px solid ${C.border}`, borderRadius: 10, padding: "14px 14px 12px" }}>
        <Btn outline color={C.red} style={{ width: "100%" }}
          disabled={!(budget.payees || []).some(p => p.canonicalName && p.canonicalName !== p.name)}
          onClick={() => setConfirmAction({ message: "Unmerge all payees? Every merged display name will be removed and each payee will revert to showing its original name from your transactions.", onConfirm: unmergeAllPayees })}>
          ↩ Unmerge All Payees
        </Btn>
        <div style={{ fontSize: 11, color: C.muted, marginTop: 8, lineHeight: 1.5 }}>
          Removes all merged display names. Each payee will go back to showing its original name exactly as it appeared in your transactions. Your transactions are not affected.
        </div>
      </div>

      {/* Reset Merge Suggestions — bordered section */}
      <div style={{ marginTop: 10, border: `1.5px solid ${C.border}`, borderRadius: 10, padding: "14px 14px 12px" }}>
        <Btn outline color={C.muted} style={{ width: "100%" }}
          disabled={!(budget.rejectedMerges || []).length}
          onClick={() => setConfirmAction({ message: "Reset all rejected merge suggestions? Payees you previously chose not to merge will be suggested again.", onConfirm: () => updateBudget({ rejectedMerges: [] }) })}>
          🔄 Reset Merge Suggestions
        </Btn>
        <div style={{ fontSize: 11, color: C.muted, marginTop: 8, lineHeight: 1.5 }}>
          Clears your "do not merge" decisions. Any payees you previously rejected as merge suggestions will be offered again the next time you review.
        </div>
      </div>

      {/* Merge exclusion words */}
      {(() => {
        const excludeWords = budget.mergeExcludeWords || ["TST*"];
        return (
          <div style={{ marginTop: 20, borderTop: `1px solid ${C.border}`, paddingTop: 16 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 700, color: C.text }}>Merge Exclusion Words</div>
                <div style={{ fontSize: 11, color: C.muted, marginTop: 2, lineHeight: 1.4 }}>Words that won't trigger merge suggestions. Other words in the same payee still count.</div>
              </div>
              <Btn small color={C.purple} onClick={() => setExcludeWordModal(true)} style={{ flexShrink: 0, marginLeft: 8 }}>+ Add</Btn>
            </div>
            {excludeWords.length > 0 ? (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
                {excludeWords.map((word, i) => (
                  <div key={i} style={{ display: "inline-flex", alignItems: "center", gap: 4, background: "#F0EBFF", border: `1px solid ${C.purple}`, borderRadius: 20, padding: "3px 10px 3px 12px", fontSize: 12, fontWeight: 600, color: C.purple }}>
                    {word}
                    <button onClick={() => updateBudget({ mergeExcludeWords: excludeWords.filter((_, j) => j !== i) })}
                      style={{ background: "none", border: "none", cursor: "pointer", color: C.purple, fontSize: 14, lineHeight: 1, padding: "0 0 0 2px", fontFamily: "inherit" }}>×</button>
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ fontSize: 12, color: C.muted, marginBottom: 10, fontStyle: "italic" }}>No exclusion words set.</div>
            )}
            {excludeWords.length > 0 && (
              <Btn small outline color={C.red}
                onClick={() => setConfirmAction({ message: "Clear all merge exclusion words? All words including the default \"TST*\" will be removed.", onConfirm: () => updateBudget({ mergeExcludeWords: [] }) })}>
                🗑 Clear All Exclusion Words
              </Btn>
            )}
          </div>
        );
      })()}

      {selected.length >= 2 && (
        <Btn color={C.purple} onClick={() => { setCanonical(selected[0]); setCustomName(""); setMergeModal(true); }} style={{ width: "100%", marginTop: 12 }}>Merge {selected.length} Payees</Btn>
      )}

      {suggestMergeModal && (() => {
        const { groups, currentIdx } = suggestMergeModal;
        if (currentIdx >= groups.length) return null; // useEffect will close it
        const grp = groups[currentIdx];
        const checkedNames = grp.checked;

        const goNext = (updatedGroups) => {
          setMergeNameFocused(false); // reset name field focus for next group
          const g = updatedGroups || groups;
          let next = currentIdx + 1;
          setSuggestMergeModal(p => ({ ...p, groups: g, currentIdx: next }));
        };

        const skipAll = () => {
          userClosedMergeRef.current = true;
          setMergeNameFocused(false);
          setSuggestMergeModal(null);
        };

        // A3: "Do not merge any of these payees" — reject all pairs in this group
        const rejectGroup = () => {
          setMergeNameFocused(false);
          nameInputRef.current?.blur();
          const names = grp.names;
          const newPairs = [];
          for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) {
            newPairs.push([names[i], names[j]].sort().join("|||"));
          }
          if (newPairs.length > 0) {
            updateBudget({ rejectedMerges: [...(budget.rejectedMerges || []), ...newPairs] });
          }
          goNext();
        };

        // A2: partial merge — unchecked payees should not be re-suggested with any merged payee
        // After merge, re-compute suggestions and insert new ones that aren't already in the queue
        const applyMerge = () => {
          if (checkedNames.length < 2) { goNext(); return; }
          const target = grp.customName.trim() ? grp.customName.trim() : checkedNames[0];
          const allOriginals = checkedNames.flatMap(cn => getOriginalsForCanonical(cn));

          // Unchecked names = names in this group that were NOT merged
          const uncheckedNames = grp.names.filter(n => !checkedNames.includes(n));

          // A2: reject pairs between unchecked and the merged canonical
          const newRejectedPairs = uncheckedNames.map(un => [un, target].sort().join("|||"));
          const allRejected = [...(budget.rejectedMerges || []), ...newRejectedPairs];

          // #11: batch merge + rejected pairs into one updateBudget call
          // Build updated payees list
          const canonicalName = target.trim();
          if (!canonicalName) { goNext(); return; }
          let newPayees = [...(budget.payees || [])];
          allOriginals.forEach(name => { newPayees = ensurePayeeRecord(newPayees, name, ""); });
          newPayees = newPayees.map(p => allOriginals.includes(p.name) ? { ...p, canonicalName } : p);
          newPayees = prunePayees(newPayees, budget.transactions);
          updateBudget({
            payees: newPayees,
            ...(newRejectedPairs.length > 0 ? { rejectedMerges: allRejected } : {}),
          });

          // A6 fix: build the post-merge canonical list explicitly rather than
          // reading from state (which hasn't updated yet).
          const mergedSet = new Set(checkedNames);
          const postMergeCanonicals = [
            ...canonicalNames.filter(n => !mergedSet.has(n) || n === target),
            ...(mergedSet.has(target) || canonicalNames.includes(target) ? [] : [target]),
          ];

          // Re-compute fresh suggestions against the explicit post-merge list
          const freshGroups = buildMergeGroups(postMergeCanonicals, allRejected, budget.mergeExcludeWords || []);

          // Only skip groups that are still UPCOMING in the queue (not yet shown).
          const upcomingKeys = new Set(groups.slice(currentIdx + 1).map(g => [...g.names].sort().join("|||")));
          const newSuggestions = toModalGroups(
            freshGroups.filter(fg => !upcomingKeys.has([...fg].sort().join("|||")))
          );

          // Insert new suggestions right after current position
          const updatedGroups = [
            ...groups.slice(0, currentIdx + 1),
            ...newSuggestions,
            ...groups.slice(currentIdx + 1),
          ];

          goNext(updatedGroups);
        };

        // A8: Enter key on custom name input triggers merge
        const handleNameKeyDown = (e) => {
          if (e.key === "Enter" && checkedNames.length >= 2) applyMerge();
        };

        return (
          <Modal title={`🔀 Suggested Merge (${currentIdx + 1} of ${groups.length})`} onClose={skipAll}>
            <div style={{ fontSize: 13, color: C.textLight, marginBottom: 14, lineHeight: 1.6 }}>
              These payees look like they might be the same. Check the ones to merge and pick a display name.
            </div>
            <div style={{ marginBottom: 14 }}>
              {grp.names.map(name => {
                const count = txCount(name);
                return (
                  <label key={name} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 12px", borderRadius: 8, background: checkedNames.includes(name) ? "#EAF6F0" : "#F8F6F2", border: `1.5px solid ${checkedNames.includes(name) ? C.green : "transparent"}`, marginBottom: 6, cursor: "pointer" }}>
                    <input type="checkbox" checked={checkedNames.includes(name)} onChange={() => {
                      const next = checkedNames.includes(name) ? checkedNames.filter(n => n !== name) : [...checkedNames, name];
                      setSuggestMergeModal(p => ({ ...p, groups: p.groups.map((g, i) => i === currentIdx ? { ...g, checked: next } : g) }));
                    }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 600 }}>{name}</div>
                      <div style={{ fontSize: 12, color: C.purple, fontWeight: 700, marginTop: 2 }}>
                        {count} transaction{count !== 1 ? "s" : ""}
                      </div>
                    </div>
                  </label>
                );
              })}
            </div>
            <Field label="Merge display name (leave blank to use first checked)">
              <input ref={nameInputRef} style={{ ...inputSt, cursor: IS_TOUCH && !mergeNameFocused ? "pointer" : "text" }}
                value={grp.customName}
                placeholder={checkedNames[0] || "Display name..."}
                readOnly={IS_TOUCH && !mergeNameFocused}
                onChange={e => setSuggestMergeModal(p => ({ ...p, groups: p.groups.map((g, i) => i === currentIdx ? { ...g, customName: e.target.value } : g) }))}
                onKeyDown={handleNameKeyDown}
                onFocus={() => setMergeNameFocused(true)}
                onBlur={() => setMergeNameFocused(false)}
                onClick={() => { if (IS_TOUCH && !mergeNameFocused) { setMergeNameFocused(true); setTimeout(() => nameInputRef.current?.focus(), 0); } }}
              />
            </Field>
            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8 }}>
              {/* onMouseDown preventDefault prevents buttons from stealing focus from the name input
                  on mobile, which would cause the keyboard to pop up unexpectedly */}
              <Btn color={C.purple}
                onMouseDown={e => e.preventDefault()}
                onClick={applyMerge}
                disabled={checkedNames.length < 2}>
                ✓ Merge {checkedNames.length} payees{currentIdx + 1 < groups.length ? ` → Next (${groups.length - currentIdx - 1} left)` : ""}
              </Btn>
              <Btn outline color={C.muted}
                onMouseDown={e => e.preventDefault()}
                onClick={rejectGroup}>
                Do not merge any of these payees
              </Btn>
            </div>
          </Modal>
        );
      })()}

      {excludeWordModal && (
        <Modal title="Add Exclusion Words" onClose={() => { setExcludeWordModal(false); setExcludeWordInput(""); }} closeLabel="Discard">
          <div style={{ fontSize: 13, color: C.muted, marginBottom: 14, lineHeight: 1.5 }}>
            Enter a word or phrase that should be ignored when generating merge suggestions. Use commas to add multiple at once.
          </div>
          <Inp label="Word(s) to exclude" placeholder='e.g. TST*, SQ*, #'
            value={excludeWordInput} onChange={e => setExcludeWordInput(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter" && excludeWordInput.trim()) addExcludeWords(); }} />
          <div style={{ marginTop: 20 }}>
            <Btn color={C.purple} onClick={addExcludeWords} disabled={!excludeWordInput.trim()} style={{ width: "100%" }}>Add</Btn>
          </div>
        </Modal>
      )}
      {mergeModal && selected.length >= 2 && (
        <Modal title="Merge Payees" onClose={() => setMergeModal(false)} closeLabel="Discard">
          <div style={{ fontSize: 13, color: C.textLight, marginBottom: 14 }}>Choose which display name to keep, or enter your own. All original payee names in these groups will map to this display name.</div>
          {selected.map(name => (
            <label key={name} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 12px", borderRadius: 8, background: !customName.trim() && canonical === name ? "#EAF6F0" : "#F8F6F2", border: `1.5px solid ${!customName.trim() && canonical === name ? C.green : "transparent"}`, marginBottom: 8, cursor: "pointer" }}>
              <input type="radio" checked={!customName.trim() && canonical === name} onChange={() => { setCanonical(name); setCustomName(""); }} />
              <span style={{ fontSize: 14 }}>{name}</span>
            </label>
          ))}
          <Field label="Or enter a custom display name">
            <input style={inputSt} value={customName} onChange={e => setCustomName(e.target.value)} placeholder="Type a new payee name..." />
          </Field>
          {collision && (
            <div style={{ fontSize: 12, color: C.gold, marginTop: -8, marginBottom: 12, lineHeight: 1.5 }}>
              "{collision}" is already a payee — it'll be merged into "{finalCanonical}" too.
            </div>
          )}
          <BtnRow onCancel={() => setMergeModal(false)} onSave={confirmMerge} saveLabel="Merge" saveColor={C.purple} disabled={!finalCanonical.trim()} />
        </Modal>
      )}

      {displayNameTarget && (() => {
        const originals = getOriginalsForCanonical(displayNameTarget);
        const customTrimmed = displayNameCustom.trim();
        return (
          <Modal title="Payee Display Name" onClose={() => setDisplayNameTarget(null)} closeLabel="Discard">
            <div style={{ fontSize: 13, color: C.textLight, marginBottom: 14, lineHeight: 1.6 }}>
              All transactions whose original payee name maps to "{displayNameTarget}" will show the selected name.
            </div>
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: C.muted, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>Original names in this group</div>
              {originals.map(name => (
                <div key={name} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", background: "#F8F6F2", borderRadius: 8, marginBottom: 6 }}>
                  <span style={{ flex: 1, fontSize: 13 }}>{name}</span>
                  {name !== displayNameTarget && (
                    <Btn small outline color={C.muted} onClick={() => {
                      setDisplayNameTarget(null);
                      setConfirmAction({ message: `Unmerge "${name}"? Transactions with this original payee will revert to displaying "${name}" instead of "${displayNameTarget}".`, onConfirm: () => unmergeOriginal(name) });
                    }}>↩ Unmerge</Btn>
                  )}
                </div>
              ))}
            </div>
            {originals.length > 1 && (
              <Btn small outline color={C.red} onClick={() => {
                setDisplayNameTarget(null);
                setConfirmAction({ message: `Unmerge all ${originals.length} original payee names from "${displayNameTarget}"? Each will revert to displaying its own original name.`, onConfirm: () => unmergeAllForCanonical(originals) });
              }} style={{ width: "100%", marginBottom: 12 }}>↩ Unmerge All ({originals.length})</Btn>
            )}
            <Field label="Set custom display name for all above">
              <input style={inputSt} value={displayNameCustom} onChange={e => { setDisplayNameCustom(e.target.value); setDisplayNameError(""); }} placeholder={`Current: ${displayNameTarget}`} />
            </Field>
            {displayNameError && <div style={{ fontSize: 12, color: C.red, marginTop: -10, marginBottom: 12 }}>{displayNameError}</div>}
            <BtnRow onCancel={() => setDisplayNameTarget(null)} onSave={() => {
              if (!customTrimmed) { setDisplayNameTarget(null); return; }
              const newCanonical = customTrimmed;
              if (newCanonical === displayNameTarget) { setDisplayNameTarget(null); return; }
              setCanonicalForNames(originals, newCanonical);
              setDisplayNameTarget(null);
            }} saveLabel={customTrimmed ? "Apply" : "Close"} saveColor={C.purple} />
          </Modal>
        );
      })()}

      {confirmAction && (
        <Modal title="Are you sure?" onClose={() => setConfirmAction(null)}>
          <div style={{ fontSize: 13, color: C.textLight, marginBottom: 16, lineHeight: 1.6 }}>{confirmAction.message}</div>
          <div style={{ display: "flex", gap: 10 }}>
            <Btn outline color={C.muted} onClick={() => setConfirmAction(null)} style={{ flex: 1 }}>No, Cancel</Btn>
            <Btn color={C.red} onClick={() => { confirmAction.onConfirm(); setConfirmAction(null); }} style={{ flex: 1 }}>Yes, Continue</Btn>
          </div>
        </Modal>
      )}

      {contextMenu && <ContextMenu items={contextMenu.items} onClose={() => setContextMenu(null)} />}
    </div>
  );
}

// ── Accounts View ────────────────────────────────────────────
function AccountsView({ budget, updateBudget, getAccountBalance, getCardBalance, reconcileAccount, transactions, isLocked, goToTransactions, archiveAccount, deleteAccount, requestAccountAction, accountHasTransactions, accountNameExists, ccNameExists, renameAccount, pendingReconcile, onClearPendingReconcile, triggerTransferRef }) {
  const [reconcileTarget, setReconcileTarget] = useState(null);
  const [transferFrom, setTransferFrom] = useState(null);
  // Register setTransferFrom so MainApp modals can trigger a transfer
  useEffect(() => { if (triggerTransferRef) triggerTransferRef.current = setTransferFrom; }, [triggerTransferRef]);
  const [archivedExpanded, setArchivedExpanded] = useState(false);
  const [accountMenu, setAccountMenu] = useState(null); // { id, isCard }
  const [renameTarget, setRenameTarget] = useState(null); // { id, isCard, currentName }
  const [renameVal, setRenameVal] = useState("");

  // Auto-open reconcile modal when triggered from notification center or requestAccountAction
  useEffect(() => {
    if (pendingReconcile && !reconcileTarget) {
      setReconcileTarget(pendingReconcile);
      onClearPendingReconcile();
    }
  }, [pendingReconcile]);
  const [renameErr, setRenameErr] = useState("");
  const [confirmAction, setConfirmAction] = useState(null);

  // Add Account modal state
  const [addAccModal, setAddAccModal] = useState(false);
  const [newAccName, setNewAccName] = useState(""); const [newAccType, setNewAccType] = useState("checking"); const [newAccBal, setNewAccBal] = useState(null); const [addAccError, setAddAccError] = useState("");
  const addAccount = () => {
    if (!newAccName || newAccBal === null) return;
    if (accountNameExists(newAccName, null)) { setAddAccError(`"${newAccName.trim()}" already exists.`); return; }
    const cm = toKey(new Date()); const today = new Date().toISOString().slice(0, 10); const accId = uid();
    updateBudget({ accounts: [...budget.accounts, { id: accId, name: toTitleCase(newAccName.trim()), type: newAccType, balance: 0 }], transactions: [...budget.transactions, { id: uid(), date: today, payee: "Starting Balance", originalPayee: "Starting Balance", note: "", type: "income", subtype: "starting_balance", accountId: accId, amount: newAccBal, reconciled: true }], inflows: { ...budget.inflows, [cm]: (budget.inflows[cm] || 0) + newAccBal } });
    setNewAccName(""); setNewAccBal(null); setNewAccType("checking"); setAddAccError(""); setAddAccModal(false);
  };

  // Add Card modal state
  const [addCCModal, setAddCCModal] = useState(false);
  const [newCCName, setNewCCName] = useState(""); const [newCCBal, setNewCCBal] = useState(null); const [addCCError, setAddCCError] = useState("");
  const addCC = () => {
    if (!newCCName || newCCBal === null) return;
    if (ccNameExists(newCCName, null)) { setAddCCError(`"${newCCName.trim()}" already exists.`); return; }
    const eg = budget.categoryGroups.find(g => g.name === "Credit Card Payments"); const ccGroup = eg || { id: uid(), name: "Credit Card Payments" };
    const ccName = toTitleCase(newCCName.trim()); const nid = uid();
    const ccCat = { id: uid(), groupId: ccGroup.id, name: `${ccName} Payment`, creditCardId: nid, rollover: "rollover" };
    const cm = toKey(new Date()); const today = new Date().toISOString().slice(0, 10);
    const nMB = newCCBal > 0 ? { ...budget.monthlyBudgets, [cm]: { ...(budget.monthlyBudgets[cm] || {}), [ccCat.id]: newCCBal } } : budget.monthlyBudgets;
    const startingTx = newCCBal > 0 ? { id: uid(), date: today, payee: "Starting Balance", originalPayee: "Starting Balance", note: "", type: "expense", subtype: "starting_balance", accountId: nid, categoryId: ccCat.id, amount: newCCBal, reconciled: true } : null;
    updateBudget({ creditCards: [...budget.creditCards, { id: nid, name: ccName, balance: 0 }], categoryGroups: eg ? budget.categoryGroups : [...budget.categoryGroups, ccGroup], categories: [...budget.categories, ccCat], monthlyBudgets: nMB, transactions: startingTx ? [...budget.transactions, startingTx] : budget.transactions });
    setNewCCName(""); setNewCCBal(null); setAddCCError(""); setAddCCModal(false);
  };

  const activeAccounts = budget.accounts.filter(a => !a.archived);
  const activeCards = budget.creditCards.filter(c => !c.archived);
  const archivedAccounts = budget.accounts.filter(a => a.archived);
  const archivedCards = budget.creditCards.filter(c => c.archived);
  const totalArchived = archivedAccounts.length + archivedCards.length;
  const totalBal = activeAccounts.reduce((s, a) => s + getAccountBalance(a.id), 0);

  // Efficiency: compute the latest reconciled tx date per account in ONE pass,
  // instead of scanning all transactions once per account during render.
  const lastReconciledTxDateMap = useMemo(() => {
    const m = {};
    transactions.forEach(tx => {
      if (!tx.reconciled || !tx.accountId) return;
      if (!m[tx.accountId] || tx.date > m[tx.accountId]) m[tx.accountId] = tx.date;
    });
    return m;
  }, [transactions]);

  const lastReconciledDate = (accId) => {
    const acc = budget.accounts.find(a => a.id === accId) || budget.creditCards.find(c => c.id === accId);
    const candidates = [acc?.reconciledDate, acc?.lastReconciledDisplay, lastReconciledTxDateMap[accId]].filter(Boolean);
    return candidates.length ? candidates.sort().pop() : null;
  };

  const SectionHeader = ({ label, onAdd, addLabel }) => (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8, marginTop: 20 }}>
      <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.07em", color: C.muted }}>{label}</div>
      {onAdd && <Btn small color={C.navy} onClick={onAdd}>{addLabel}</Btn>}
    </div>
  );

  const longPressTimer = useRef(null);
  const bindRowMenu = (items) => ({
    onTouchStart: () => { longPressTimer.current = setTimeout(() => setAccountMenu({ items }), 500); },
    onTouchEnd: () => { clearTimeout(longPressTimer.current); longPressTimer.current = null; },
    onTouchMove: () => { clearTimeout(longPressTimer.current); longPressTimer.current = null; },
    onContextMenu: (e) => { e.preventDefault(); setAccountMenu({ items }); },
  });

  return (
    <div style={{ padding: "12px 16px", paddingBottom: 80 }}>
      {activeAccounts.length > 0 && (
        <div style={{ background: C.navy, color: "#fff", borderRadius: 10, padding: "10px 14px", marginBottom: 12, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ fontSize: 12, opacity: 0.7 }}>Total Cash Balance</div>
          <div style={{ fontSize: 18, fontWeight: 800 }}>{fmt(totalBal)}</div>
        </div>
      )}

      {/* Checking / Savings / Cash */}
      <SectionHeader label="🏦 Checking · Savings · Cash" onAdd={() => setAddAccModal(true)} addLabel="+ Add Account" />
      {activeAccounts.length === 0 && <div style={{ textAlign: "center", padding: "16px", color: C.muted, fontSize: 13 }}>No accounts yet</div>}
      <div style={{ background: C.surface, borderRadius: 10, border: `1px solid ${C.border}`, overflow: "hidden", marginBottom: 4 }}>
        {activeAccounts.map((a, i) => {
          const recDate = lastReconciledDate(a.id);
          const hasTx = accountHasTransactions(a.id);
          const menuItems = [
            { label: "📊 View Transactions", onClick: () => { goToTransactions({ accountId: a.id }); setAccountMenu(null); } },
            { label: "⚖️ Reconcile", onClick: () => { setReconcileTarget({ id: a.id, name: a.name, isCard: false }); setAccountMenu(null); } },
            ...(activeAccounts.length > 1 ? [{ label: "💸 Transfer Money", onClick: () => { setTransferFrom(a.id); setAccountMenu(null); } }] : []),
            { label: "✏️ Rename", onClick: () => { setRenameTarget({ id: a.id, isCard: false, currentName: a.name }); setRenameVal(a.name); setRenameErr(""); setAccountMenu(null); } },
            hasTx
              ? { label: "🗂 Archive", onClick: () => { requestAccountAction(a.id, false, "archive"); setAccountMenu(null); } }
              : { label: "🗑 Delete", danger: true, onClick: () => { requestAccountAction(a.id, false, "delete"); setAccountMenu(null); } },
          ];
          return (
            <div key={a.id} {...bindRowMenu(menuItems)}
              style={{ borderBottom: i < activeAccounts.length - 1 ? `1px solid ${C.border}` : "none", WebkitUserSelect: "none", userSelect: "none" }}>
              <div style={{ display: "flex", alignItems: "center", padding: "11px 14px", gap: 10 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.name}</div>
                  <div style={{ fontSize: 11, marginTop: 1 }}>
                    <span style={{ textTransform: "capitalize", color: C.muted }}>{a.type}</span>
                    {" · "}
                    <span style={{ color: recDate ? C.green : C.muted }}>{recDate ? `✅ ${daysSince(recDate)}d ago` : "Never reconciled"}</span>
                  </div>
                </div>
                <div onClick={e => { e.stopPropagation(); goToTransactions({ accountId: a.id }); }}
                  style={{ fontSize: 15, fontWeight: 800, cursor: "pointer", color: C.navy, textDecoration: "underline", textDecorationStyle: "dotted", flexShrink: 0 }}>
                  {fmt(getAccountBalance(a.id))}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Credit Cards */}
      <SectionHeader label="💳 Credit Cards" onAdd={() => setAddCCModal(true)} addLabel="+ Add Card" />
      {activeCards.length === 0 && <div style={{ textAlign: "center", padding: "16px", color: C.muted, fontSize: 13 }}>No cards yet</div>}
      <div style={{ background: C.surface, borderRadius: 10, border: `1px solid ${C.border}`, overflow: "hidden", marginBottom: 4 }}>
        {activeCards.map((cc, i) => {
          const recDate = lastReconciledDate(cc.id);
          const bal = getCardBalance(cc.id);
          const hasTx = accountHasTransactions(cc.id);
          const menuItems = [
            { label: "📊 View Transactions", onClick: () => { goToTransactions({ accountId: cc.id }); setAccountMenu(null); } },
            { label: "⚖️ Reconcile", onClick: () => { setReconcileTarget({ id: cc.id, name: cc.name, isCard: true }); setAccountMenu(null); } },
            { label: "✏️ Rename", onClick: () => { setRenameTarget({ id: cc.id, isCard: true, currentName: cc.name }); setRenameVal(cc.name); setRenameErr(""); setAccountMenu(null); } },
            hasTx
              ? { label: "🗂 Archive", onClick: () => { requestAccountAction(cc.id, true, "archive"); setAccountMenu(null); } }
              : { label: "🗑 Delete", danger: true, onClick: () => { requestAccountAction(cc.id, true, "delete"); setAccountMenu(null); } },
          ];
          return (
            <div key={cc.id} {...bindRowMenu(menuItems)}
              style={{ borderBottom: i < activeCards.length - 1 ? `1px solid ${C.border}` : "none", WebkitUserSelect: "none", userSelect: "none" }}>
              <div style={{ display: "flex", alignItems: "center", padding: "11px 14px", gap: 10 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{cc.name}</div>
                  <div style={{ fontSize: 11, marginTop: 1 }}>
                    <span style={{ color: recDate ? C.green : C.muted }}>{recDate ? `✅ ${daysSince(recDate)}d ago` : "Never reconciled"}</span>
                    {" · "}
                    <span style={{ color: bal > 0 ? C.red : C.muted }}>{bal > 0 ? `${fmt(bal)} owed` : "Paid off"}</span>
                  </div>
                </div>
                <div onClick={e => { e.stopPropagation(); goToTransactions({ accountId: cc.id }); }}
                  style={{ fontSize: 15, fontWeight: 800, cursor: "pointer", color: bal > 0 ? C.red : C.muted, textDecoration: "underline", textDecorationStyle: "dotted", flexShrink: 0 }}>
                  {bal > 0 ? `-${fmt(bal)}` : "$0.00"}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Archived — collapsed by default */}
      {totalArchived > 0 && (
        <div style={{ marginTop: 16 }}>
          <button onClick={() => setArchivedExpanded(p => !p)}
            style={{ display: "flex", alignItems: "center", gap: 6, width: "100%", background: "none", border: "none", cursor: "pointer", padding: "6px 0", fontFamily: "inherit" }}>
            <span style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.07em", color: C.muted }}>🗂 Archived ({totalArchived})</span>
            <span style={{ fontSize: 12, color: C.muted, marginLeft: "auto" }}>{archivedExpanded ? "▲" : "▼"}</span>
          </button>
          {archivedExpanded && (
            <div style={{ background: C.surface, borderRadius: 10, border: `1px solid ${C.border}`, overflow: "hidden", marginTop: 4 }}>
              {[...archivedAccounts.map(a => ({ ...a, isCard: false })), ...archivedCards.map(c => ({ ...c, isCard: true }))].map((item, i, arr) => {
                const archivedMenuItems = [
                  { label: "↩ Restore", onClick: () => { archiveAccount(item.id, item.isCard); setAccountMenu(null); } },
                  ...(!accountHasTransactions(item.id) ? [{ label: "🗑 Delete", danger: true, onClick: () => { setConfirmAction({ message: `Delete "${item.name}" permanently? This cannot be undone.`, onConfirm: () => deleteAccount(item.id, item.isCard) }); setAccountMenu(null); } }] : []),
                ];
                return (
                  <div key={item.id} {...bindRowMenu(archivedMenuItems)}
                    style={{ display: "flex", alignItems: "center", padding: "9px 14px", borderBottom: i < arr.length - 1 ? `1px solid ${C.border}` : "none", opacity: 0.6, WebkitUserSelect: "none", userSelect: "none" }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.name}</div>
                      <div style={{ fontSize: 11, color: C.muted }}>{item.isCard ? "Credit Card" : item.type}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Modals */}
      {accountMenu && <ContextMenu items={accountMenu.items} onClose={() => setAccountMenu(null)} />}

      {renameTarget && (
        <Modal title={`Rename ${renameTarget.isCard ? "Card" : "Account"}`} onClose={() => setRenameTarget(null)} closeLabel="Discard">
          <Inp label="Name" value={renameVal} onChange={e => { setRenameVal(e.target.value); setRenameErr(""); }} autoFocus />
          {renameErr && <div style={{ fontSize: 12, color: C.red, marginTop: -8, marginBottom: 12 }}>{renameErr}</div>}
          <BtnRow onCancel={() => setRenameTarget(null)} onSave={() => {
            const v = renameVal.trim();
            if (!v) { setRenameErr("Name is required."); return; }
            const exists = renameTarget.isCard ? ccNameExists(v, renameTarget.id) : accountNameExists(v, renameTarget.id);
            if (exists) { setRenameErr(`"${v}" already exists.`); return; }
            renameAccount(renameTarget.id, renameTarget.isCard, v);
            setRenameTarget(null);
          }} saveLabel="Save" disabled={!renameVal.trim()} />
        </Modal>
      )}

      {addAccModal && (() => {
        const addBtnRef = { current: null };
        return (
        <Modal title="Add Account" onClose={() => { setAddAccModal(false); setNewAccName(""); setNewAccBal(null); setAddAccError(""); }} closeLabel="Discard">
          <div style={{ background: "#EAF6F0", border: `1px solid #A8DFBF`, borderRadius: 8, padding: 10, fontSize: 12, color: "#1A5C36", marginBottom: 14 }}>💡 Opening balance added to Ready to Assign.</div>
          <Inp label="Account Name" placeholder="Chase Checking" value={newAccName} onChange={e => { setNewAccName(e.target.value); setAddAccError(""); }} autoFocus />
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <Sel label="Type" value={newAccType} onChange={e => setNewAccType(e.target.value)}>
              <option value="checking">Checking</option><option value="savings">Savings</option><option value="cash">Cash</option>
            </Sel>
            <AmountInput label="Balance ($)" initialValue={newAccBal !== null ? newAccBal : undefined}
              onChange={v => setNewAccBal(v)}
              onCommit={v => { setNewAccBal(v); requestAnimationFrame(() => requestAnimationFrame(() => addBtnRef.current?.focus())); }}
              placeholder="e.g. 1000" />
          </div>
          {addAccError && <div style={{ fontSize: 12, color: C.red, marginTop: -6, marginBottom: 12 }}>{addAccError}</div>}
          <BtnRow onCancel={() => { setAddAccModal(false); setNewAccName(""); setNewAccBal(null); setAddAccError(""); }} onSave={addAccount} saveLabel="Add Account" saveColor={C.green} disabled={!newAccName || newAccBal === null} saveBtnRef={addBtnRef} />
        </Modal>
        );
      })()}

      {addCCModal && (() => {
        const addCCBtnRef = { current: null };
        return (
        <Modal title="Add Credit Card" onClose={() => { setAddCCModal(false); setNewCCName(""); setNewCCBal(null); setAddCCError(""); }} closeLabel="Discard">
          <div style={{ background: "#EAF6F0", border: `1px solid #A8DFBF`, borderRadius: 8, padding: 10, fontSize: 12, color: "#1A5C36", marginBottom: 14 }}>💡 Existing balance reserved in your budget.</div>
          <Inp label="Card Name" placeholder="Chase Visa, Amex Blue..." value={newCCName} onChange={e => { setNewCCName(e.target.value); setAddCCError(""); }} autoFocus />
          <AmountInput label="Balance Owed ($)" initialValue={newCCBal !== null ? newCCBal : undefined}
            onChange={v => setNewCCBal(v)}
            onCommit={v => { setNewCCBal(v); requestAnimationFrame(() => requestAnimationFrame(() => addCCBtnRef.current?.focus())); }}
            placeholder="e.g. 450.00" />
          {addCCError && <div style={{ fontSize: 12, color: C.red, marginTop: -6, marginBottom: 12 }}>{addCCError}</div>}
          <BtnRow onCancel={() => { setAddCCModal(false); setNewCCName(""); setNewCCBal(null); setAddCCError(""); }} onSave={addCC} saveLabel="Add Card" saveColor={C.green} disabled={!newCCName || newCCBal === null} saveBtnRef={addCCBtnRef} />
        </Modal>
        );
      })()}

      {reconcileTarget && (
        <ReconcileModal name={reconcileTarget.name} isCard={reconcileTarget.isCard}
          computedBalance={reconcileTarget.isCard ? Math.abs(getCardBalance(reconcileTarget.id)) : getAccountBalance(reconcileTarget.id)}
          transactions={transactions.filter(tx => tx.accountId === reconcileTarget.id)}
          isLocked={isLocked}
          onConfirm={(date, diff, txIdsToLock) => {
            const onComplete = reconcileTarget.onComplete;
            const accId = reconcileTarget.id;
            const isCard2 = reconcileTarget.isCard;
            if (onComplete) {
              // Archive flow: build the complete reconcile + archive update atomically
              let txList = budget.transactions.map(tx =>
                tx.accountId === accId ? { ...tx, reconciled: true } : tx
              );
              const updates = { transactions: txList };
              if (Math.abs(diff) > 0.001) {
                const adjTx = { id: uid(), date, payee: "Balance Adjustment", originalPayee: "Balance Adjustment", note: "", type: "adjustment", accountId: accId, categoryId: null, amount: diff, reconciled: true };
                updates.transactions = [...txList, adjTx];
                if (!isCard2) {
                  const txMonth = date.slice(0, 7);
                  updates.inflows = { ...budget.inflows, [txMonth]: (budget.inflows[txMonth] || 0) + diff };
                }
              }
              if (isCard2) updates.creditCards = budget.creditCards.map(c => c.id === accId ? { ...c, reconciledDate: date } : c);
              else updates.accounts = budget.accounts.map(a => a.id === accId ? { ...a, reconciledDate: date } : a);
              // Pass the already-built updates to onComplete so it can proceed
              // without re-reading stale budget state
              onComplete(updates);
            } else {
              reconcileAccount(accId, date, diff, txIdsToLock);
            }
            setReconcileTarget(null);
          }}
          onClose={() => setReconcileTarget(null)} />
      )}

      {transferFrom && (
        <TransferModal accounts={activeAccounts} fromId={transferFrom} getAccountBalance={getAccountBalance} onClose={() => setTransferFrom(null)}
          onSave={(fromId, toId, amount, date, note) => {
            const linkId = uid();
            const fromAcc = activeAccounts.find(a => a.id === fromId);
            const toAcc = activeAccounts.find(a => a.id === toId);
            updateBudget({ transactions: [...budget.transactions,
              { id: uid(), date, payee: `Transfer to ${toAcc?.name || "account"}`, originalPayee: `Transfer to ${toAcc?.name || "account"}`, note, type: "transfer", accountId: fromId, amount: -amount, transferLinkId: linkId },
              { id: uid(), date, payee: `Transfer from ${fromAcc?.name || "account"}`, originalPayee: `Transfer from ${fromAcc?.name || "account"}`, note, type: "transfer", accountId: toId, amount: +amount, transferLinkId: linkId },
            ] });
            setTransferFrom(null);
          }} />
      )}
      {confirmAction && (
        <Modal title="Are you sure?" onClose={() => setConfirmAction(null)}>
          <div style={{ fontSize: 14, color: C.text, marginBottom: 20, lineHeight: 1.6 }}>{confirmAction.message}</div>
          <div style={{ display: "flex", gap: 10 }}>
            <Btn outline color={C.muted} onClick={() => setConfirmAction(null)} style={{ flex: 1 }}>No, Cancel</Btn>
            <Btn color={C.red} onClick={() => { confirmAction.onConfirm(); setConfirmAction(null); }} style={{ flex: 1 }}>Yes, Continue</Btn>
          </div>
        </Modal>
      )}
    </div>
  );
}

function TransferModal({ accounts, fromId, getAccountBalance, onClose, onSave }) {
  const localDate = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`; };
  const fromBalance = getAccountBalance ? Math.max(0, getAccountBalance(fromId)) : 0;
  const [form, setForm] = useState({
    fromId,
    toId: accounts.find(a => a.id !== fromId)?.id || "",
    amount: fromBalance,
    date: localDate(),
    note: "",
  });
  const fromAcc = accounts.find(a => a.id === form.fromId);
  const toOptions = accounts.filter(a => a.id !== form.fromId);
  const overBalance = form.amount > fromBalance + 0.005;

  return (
    <Modal title="💸 Transfer Money" onClose={onClose} closeLabel="Discard">
      <div style={{ fontSize: 13, color: C.muted, marginBottom: 16, lineHeight: 1.5 }}>
        Moves money between your checking, savings, or cash accounts. No effect on your budget.
      </div>
      <Field label="From">
        <div style={{ ...inputSt, color: C.text, fontWeight: 600, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span>{fromAcc?.name || "—"}</span>
          <span style={{ fontSize: 12, color: C.muted, fontWeight: 400 }}>Balance: {fmt(fromBalance)}</span>
        </div>
      </Field>
      <SearchableSel label="To" value={form.toId}
        onChange={v => setForm(p => ({ ...p, toId: v }))}
        options={[{ value: "", label: "Select account..." }, ...toOptions.map(a => ({ value: a.id, label: a.name }))]}
        placeholder="Search accounts..." />
      <AmountInput label="Amount" initialValue={form.amount || undefined}
        onChange={v => setForm(p => ({ ...p, amount: Math.abs(v) }))}
        onCommit={v => setForm(p => ({ ...p, amount: Math.abs(v) }))}
        placeholder="0.00" />
      {overBalance && (
        <div style={{ fontSize: 12, color: C.red, marginTop: -8, marginBottom: 8 }}>
          Amount exceeds the available balance of {fmt(fromBalance)}.
        </div>
      )}
      <Field label="Date">
        <input type="date" value={form.date} onChange={e => setForm(p => ({ ...p, date: e.target.value }))}
          style={{ ...inputSt, width: "100%", boxSizing: "border-box" }} />
      </Field>
      <Inp label="Note (optional)" value={form.note} onChange={e => setForm(p => ({ ...p, note: e.target.value }))} placeholder="e.g. Emergency fund deposit" />
      <BtnRow onCancel={onClose} onSave={() => onSave(form.fromId, form.toId, form.amount, form.date, form.note.trim())}
        saveLabel="Transfer" saveColor={C.purple}
        disabled={!form.toId || !form.amount || form.fromId === form.toId || overBalance} />
    </Modal>
  );
}

// ── Main App ─────────────────────────────────────────────────
function AccountBalanceResolutionModal({ budget, id, isCard, action, name, absBalance, globalFree, spentByMonthCat, appendMoveLog, archiveAccount, updateBudget, triggerTransferRef, getAccountBalance, onClose }) {
  const actionLabel = action === "archive" ? "Archive" : "Delete";
  const todayMk = toKey(new Date());
  const [hidden, setHidden] = useState(false); // hides overlay while transfer modal is open

  // Watch for account balance hitting zero after a transfer — auto-commit when it does
  const [committed, setCommitted] = useState(false);
  useEffect(() => {
    if (committed) return;
    const currentBal = getAccountBalance ? getAccountBalance(id) : absBalance;
    if (Math.abs(currentBal) < 0.005 && absBalance > 0.005) {
      // Balance is now zero (transfer completed) — proceed with archive/delete
      setCommitted(true);
      const newMB = budget.monthlyBudgets;
      const newInflows = budget.inflows;
      if (action === "archive") {
        const today2 = new Date();
        const stamp2 = `${today2.getFullYear()}${String(today2.getMonth()+1).padStart(2,"0")}${String(today2.getDate()).padStart(2,"0")}`;
        const acc2 = budget.accounts.find(a => a.id === id);
        const baseName2 = `(${stamp2}) ${acc2 ? acc2.name : name}`;
        let archName = baseName2; let ai = 2;
        while (budget.accounts.some(a => a.id !== id && a.name.toLowerCase() === archName.toLowerCase())) { archName = `${baseName2} (${ai})`; ai++; }
        updateBudget({ accounts: budget.accounts.map(a => a.id === id ? { ...a, archived: true, name: archName } : a) });
      } else {
        updateBudget({ accounts: budget.accounts.filter(a => a.id !== id) });
      }
      onClose();
    }
  }, [budget.transactions, budget.accounts]);

  const futureMks = Array.from(new Set([
    todayMk,
    ...Object.keys(budget.monthlyBudgets).filter(mk => mk >= todayMk),
  ])).sort().reverse();

  // Sources: RTA first, then budgeted-activity (unspent) per category per month
  const allSources = [];
  if (globalFree > 0.005) {
    allSources.push({ key: "rta", label: "Ready to Assign", month: null, catId: null, max: globalFree });
  }
  futureMks.forEach(mk => {
    budget.categories.filter(c => !c.archived && !c.creditCardId).forEach(cat => {
      const budgeted = Number((budget.monthlyBudgets[mk] || {})[cat.id] || 0);
      const activity = (spentByMonthCat[mk] || {})[cat.id] || 0;
      const free = budgeted - activity;
      if (free > 0.005) {
        allSources.push({ key: `${mk}:${cat.id}`, label: cat.name, month: mk, catId: cat.id, max: free });
      }
    });
  });

  const totalSourceable = allSources.reduce((s, src) => s + src.max, 0);
  const [selections, setSelections] = useState({});
  const [postCommitAlert, setPostCommitAlert] = useState(null);

  const totalSelected = Object.values(selections).reduce((s, v) => s + (Number(v) || 0), 0);
  const stillNeeded = Math.max(0, absBalance - totalSelected);
  const covered = stillNeeded < 0.005;

  const toggleSource = (key) => {
    if (Object.prototype.hasOwnProperty.call(selections, key)) {
      setSelections(p => { const n = { ...p }; delete n[key]; return n; });
    } else {
      const src = allSources.find(s => s.key === key);
      const currentNeeded = Math.max(0, absBalance - Object.values(selections).reduce((s, v) => s + (Number(v) || 0), 0));
      setSelections(p => ({ ...p, [key]: Math.min(src.max, currentNeeded) }));
    }
  };

  const setAmt = (key, val) => {
    const src = allSources.find(s => s.key === key);
    setSelections(p => ({ ...p, [key]: Math.min(Math.max(0, Number(val) || 0), src ? src.max : 0) }));
  };

  const autoPull = () => {
    const init = {};
    let left = absBalance;
    allSources.forEach(src => {
      if (left <= 0.005) { return; }
      const take = Math.min(src.max, left);
      init[src.key] = take;
      left -= take;
    });
    setSelections(init);
  };

  const handleCommitFinal = () => {
    const newMB = JSON.parse(JSON.stringify(budget.monthlyBudgets));
    let newInflows = { ...budget.inflows };
    const logEntries = [];

    // Step 1: move selected category budgets → RTA
    Object.entries(selections).forEach(([key, amt]) => {
      if (!amt || amt < 0.005 || key === "rta") return;
      const [mk2, catId2] = key.split(":");
      newMB[mk2] = newMB[mk2] || {};
      newMB[mk2][catId2] = Math.max(0, (newMB[mk2][catId2] || 0) - amt);
      logEntries.push({ from: catId2, to: "rta", amount: amt });
    });

    // Step 2: Add adjustment transaction to zero the account balance
    // This correctly reduces the account balance display
    const amountToRemove = covered ? absBalance : totalSelected;
    const adjTx = {
      id: uid(), date: todayMk + "-01", payee: `${actionLabel} Adjustment`, originalPayee: `${actionLabel} Adjustment`,
      note: `Account ${actionLabel.toLowerCase()}d`, type: "adjustment", accountId: id, amount: -amountToRemove, reconciled: true,
    };
    const newTransactions = [...budget.transactions, adjTx];

    // Step 3: Adjust inflows to match (keeps RTA balanced after adjustment tx)
    newInflows = { ...newInflows, [todayMk]: (newInflows[todayMk] || 0) - amountToRemove };

    const newMoneyMoveLog = logEntries.length > 0
      ? [...(budget.moneyMoveLog || []), { type: "move", month: todayMk, ts: new Date().toISOString(), entries: logEntries }].slice(-200)
      : (budget.moneyMoveLog || []);

    if (covered) {
      if (action === "archive") {
        const today2 = new Date();
        const stamp2 = `${today2.getFullYear()}${String(today2.getMonth()+1).padStart(2,"0")}${String(today2.getDate()).padStart(2,"0")}`;
        const acc2 = budget.accounts.find(a => a.id === id);
        const baseName2 = `(${stamp2}) ${acc2 ? acc2.name : name}`;
        let archName = baseName2; let ai = 2;
        while (budget.accounts.some(a => a.id !== id && a.name.toLowerCase() === archName.toLowerCase())) { archName = `${baseName2} (${ai})`; ai++; }
        updateBudget({ accounts: budget.accounts.map(a => a.id === id ? { ...a, archived: true, name: archName } : a), transactions: newTransactions, monthlyBudgets: newMB, inflows: newInflows, moneyMoveLog: newMoneyMoveLog });
      } else {
        updateBudget({ accounts: budget.accounts.filter(a => a.id !== id), transactions: newTransactions, monthlyBudgets: newMB, inflows: newInflows, moneyMoveLog: newMoneyMoveLog });
      }
      onClose();
    } else {
      updateBudget({ transactions: newTransactions, monthlyBudgets: newMB, inflows: newInflows, moneyMoveLog: newMoneyMoveLog });
      setPostCommitAlert("transfer");
    }
  };

  const hasTransferOption = budget.accounts.filter(a => a.id !== id && !a.archived).length > 0;

  if (postCommitAlert === "blocked") {
    return (
      <Modal title={`Cannot ${actionLabel} Account`} onClose={onClose}>
        <div style={{ fontSize: 14, color: C.textLight, lineHeight: 1.7, marginBottom: 20 }}>
          <strong>{name}</strong> still has an unresolved balance. Resolve it before trying again.
        </div>
        <Btn color={C.navy} onClick={onClose} style={{ width: "100%" }}>OK</Btn>
      </Modal>
    );
  }

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 300, background: "rgba(0,0,0,0.45)", display: hidden ? "none" : "flex", flexDirection: "column" }}>
      <div style={{ background: "#fff", flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", borderRadius: "16px 16px 0 0", marginTop: 16 }}>

        {postCommitAlert === "transfer" ? (
          /* Balance not fully covered — offer transfer */
          <>
            <div style={{ padding: "14px 16px 10px", borderBottom: `1px solid ${C.border}`, display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
              <div style={{ flex: 1, fontSize: 16, fontWeight: 800, color: C.text }}>Balance Not Fully Covered</div>
              <button onClick={() => setPostCommitAlert("blocked")} style={{ background: "none", border: "none", fontSize: 22, cursor: "pointer", color: C.muted, padding: "2px 6px", fontFamily: "inherit", lineHeight: 1 }}>×</button>
            </div>
            <div style={{ flex: 1, padding: "20px 16px", fontSize: 14, color: C.textLight, lineHeight: 1.7 }}>
              <strong>{fmt(absBalance - totalSelected)}</strong> still remains on <strong>{name}</strong>. Transfer this balance to another account to proceed with {actionLabel.toLowerCase()}.
            </div>
            <div style={{ flexShrink: 0, padding: "8px 16px 24px", borderTop: `2px solid ${C.border}`, display: "flex", gap: 8, flexDirection: "column" }}>
              {hasTransferOption && (
                <Btn color={C.navy} onClick={() => { setHidden(true); if (triggerTransferRef.current) triggerTransferRef.current(id); }} style={{ width: "100%" }}>
                  💸 Transfer Remaining Balance
                </Btn>
              )}
              <Btn outline color={C.red} onClick={() => setPostCommitAlert("blocked")} style={{ width: "100%" }}>Cancel {actionLabel}</Btn>
            </div>
          </>
        ) : (<>
        {/* Header */}
        <div style={{ padding: "14px 16px 10px", borderBottom: `1px solid ${C.border}`, display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 16, fontWeight: 800, color: C.text }}>Free Up Funds to {actionLabel}</div>
            <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>
              <strong style={{ color: C.text }}>{name}</strong> · balance {fmt(absBalance)}
            </div>
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", fontSize: 22, cursor: "pointer", color: C.muted, padding: "2px 6px", fontFamily: "inherit", lineHeight: 1 }}>×</button>
        </div>

        {/* Info + Auto-pull */}
        <div style={{ padding: "8px 16px 6px", borderBottom: `1px solid ${C.border}`, display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
          <div style={{ fontSize: 12, color: C.muted, flex: 1, lineHeight: 1.5 }}>
            Tap categories to select funds to move back to RTA.
            {totalSourceable < absBalance - 0.005 && <span style={{ color: C.amber }}> Insufficient funds — transfer the remainder.</span>}
          </div>
          {allSources.length > 0 && (
            <button onClick={autoPull}
              style={{ flexShrink: 0, background: C.navy, color: "#fff", border: "none", borderRadius: 8, fontSize: 12, fontWeight: 700, padding: "6px 10px", cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap" }}>
              ✨ Auto-fill
            </button>
          )}
        </div>

        {/* Column headers */}
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, fontWeight: 700, color: C.muted, textTransform: "uppercase", letterSpacing: "0.06em", padding: "5px 16px", flexShrink: 0, borderBottom: `1px solid ${C.border}` }}>
          <span>Category / Source</span><span>Move</span>
        </div>

        {/* Scrollable list */}
        <div style={{ flex: 1, overflowY: "auto" }}>
          {allSources.length === 0 ? (
            <div style={{ padding: "24px 16px", fontSize: 13, color: C.muted, textAlign: "center" }}>
              No unspent budgeted funds available.
            </div>
          ) : (
            allSources.map((src, i) => {
              const isSelected = Object.prototype.hasOwnProperty.call(selections, src.key);
              const val = isSelected ? (selections[src.key] || 0) : 0;
              return (
                <div key={src.key}
                  style={{ display: "flex", alignItems: "center", padding: "9px 16px", borderBottom: `1px solid ${C.border}`, gap: 8, background: isSelected ? "rgba(0,80,160,0.05)" : "transparent" }}>
                  <div onClick={() => toggleSource(src.key)}
                    style={{ width: 20, height: 20, borderRadius: 4, border: `2px solid ${isSelected ? C.navy : C.border}`, background: isSelected ? C.navy : "transparent", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, cursor: "pointer" }}>
                    {isSelected && <span style={{ color: "#fff", fontSize: 11, lineHeight: 1 }}>✓</span>}
                  </div>
                  <div style={{ flex: 1, minWidth: 0, cursor: "pointer" }} onClick={() => toggleSource(src.key)}>
                    <div style={{ fontSize: 13, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{src.label}</div>
                    <div style={{ fontSize: 11, color: C.muted }}>{src.month ? keyLabel(src.month) : "Current"} · {fmt(src.max)} unspent</div>
                  </div>
                  {isSelected && (
                    <div onClick={e => e.stopPropagation()} style={{ flexShrink: 0, width: 82 }}>
                      <AmountInput
                        initialValue={val || undefined}
                        onCommit={v => setAmt(src.key, v)}
                        style={{ width: "100%", border: "none", outline: "none", fontSize: 13, fontWeight: 700, fontFamily: "inherit", background: "transparent", textAlign: "right", color: C.navy, cursor: "pointer", padding: "2px 0", WebkitUserSelect: "none", userSelect: "none" }}
                      />
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>

        {/* Sticky footer */}
        <div style={{ flexShrink: 0, padding: "8px 16px 16px", borderTop: `2px solid ${C.border}`, background: "#fff" }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, fontWeight: 700, marginBottom: 10 }}>
            <span style={{ color: C.muted }}>Still needed</span>
            <span style={{ color: covered ? C.green : C.red }}>{covered ? "✅ Fully covered" : fmt(stillNeeded)}</span>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            {hasTransferOption && (
              <Btn outline color={C.purple} onClick={() => { setHidden(true); if (triggerTransferRef.current) triggerTransferRef.current(id); }} style={{ flex: 1 }}>💸 Transfer</Btn>
            )}
            <Btn outline color={C.muted} onClick={onClose} style={{ flex: 1 }}>Cancel</Btn>
            <Btn color={action === "delete" ? C.red : C.navy} onClick={handleCommitFinal}
              disabled={totalSelected < 0.005}
              style={{ flex: 1.5 }}>
              {covered ? actionLabel : "Commit"}
            </Btn>
          </div>
        </div>
        </>)} {/* end postCommitAlert ternary */}
      </div>
    </div>
  );
}



function EditAllGoalsModal({ budget, updateBudget, onClose }) {
  const GOAL_TYPES = [
    { value: "", label: "None" },
    { value: "savings", label: "💰 Savings" },
    { value: "monthly", label: "📅 Monthly" },
    { value: "date", label: "🏁 By Date" },
  ];
  const editableCats = budget.categories.filter(c => !c.archived && !c.creditCardId);
  const [localGoals, setLocalGoals] = useState(() => {
    const init = {};
    editableCats.forEach(c => {
      init[c.id] = { type: c.goal?.type || "", target: c.goal?.target || 0, targetDate: c.goal?.targetDate || "" };
    });
    return init;
  });
  const setGoal = (catId, patch) => setLocalGoals(p => ({ ...p, [catId]: { ...p[catId], ...patch } }));
  const saveAll = () => {
    const updated = budget.categories.map(c => {
      if (c.archived || c.creditCardId) return c;
      const g = localGoals[c.id];
      if (!g) return c;
      const goal = g.type ? { type: g.type, target: g.target, ...(g.type === "date" ? { targetDate: g.targetDate } : {}) } : null;
      return { ...c, goal };
    });
    updateBudget({ categories: updated });
    onClose();
  };
  return (
    <Modal title="🎯 Edit All Goals" onClose={onClose}>
      <div style={{ fontSize: 13, color: C.textLight, marginBottom: 16, lineHeight: 1.6 }}>
        Set or update goals for any category. Changes apply when you tap Save All.
      </div>
      {budget.categoryGroups.filter(g => g.name !== "Credit Card Payments").map(grp => {
        const cats = editableCats.filter(c => c.groupId === grp.id);
        if (!cats.length) return null;
        return (
          <div key={grp.id} style={{ marginBottom: 20 }}>
            <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: C.muted, marginBottom: 10, paddingBottom: 4, borderBottom: `1px solid ${C.border}` }}>{grp.name}</div>
            {cats.map(cat => {
              const g = localGoals[cat.id] || { type: "", target: 0, targetDate: "" };
              return (
                <div key={cat.id} style={{ marginBottom: 16, paddingBottom: 16, borderBottom: `1px solid #F4F1EB` }}>
                  <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8, color: C.text }}>{cat.name}</div>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: g.type ? 10 : 0 }}>
                    {GOAL_TYPES.map(gt => (
                      <button key={gt.value} onClick={() => setGoal(cat.id, { type: gt.value })}
                        style={{ padding: "5px 10px", borderRadius: 20, border: `1.5px solid ${g.type === gt.value ? C.green : C.border}`, background: g.type === gt.value ? "#EAF6F0" : C.surface, fontSize: 12, fontWeight: g.type === gt.value ? 700 : 400, color: g.type === gt.value ? C.green : C.textLight, cursor: "pointer" }}>
                        {gt.label}
                      </button>
                    ))}
                  </div>
                  {(g.type === "savings" || g.type === "monthly") && (
                    <AmountInput label={g.type === "savings" ? "Target ($)" : "Monthly ($)"} initialValue={g.target || undefined} onCommit={v => setGoal(cat.id, { target: v })} placeholder="0.00" />
                  )}
                  {g.type === "date" && (
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                      <AmountInput label="Target ($)" initialValue={g.target || undefined} onCommit={v => setGoal(cat.id, { target: v })} placeholder="0.00" />
                      <Field label="By Date"><input type="month" style={{ ...inputSt, WebkitAppearance: "none", appearance: "none", width: "100%", minWidth: 0, maxWidth: "100%", boxSizing: "border-box", minHeight: 44, lineHeight: "1.5" }} value={g.targetDate} onChange={e => setGoal(cat.id, { targetDate: e.target.value })} min={toKey(new Date())} /></Field>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        );
      })}
      <BtnRow onCancel={onClose} onSave={saveAll} saveLabel="Save All" saveColor={C.green} />
    </Modal>
  );
}

function CoverOverspendingModal({ budget, targetMonth, getAvailable, rtaAvailable, onCover, onClose, cascadeNote }) {
  const overspentCats = budget.categories.filter(c =>
    !c.archived && !c.creditCardId && getAvailable(c.id, targetMonth) < -0.005
  );
  const totalOverspent = overspentCats.reduce((s, c) => s + Math.abs(getAvailable(c.id, targetMonth)), 0);
  const sourceCats = budget.categories.filter(c =>
    !c.archived && !c.creditCardId && getAvailable(c.id, targetMonth) > 0.005
  );

  const [sources, setSources] = useState([]);

  const coveredSoFar = sources.reduce((s, src) => s + src.amount, 0);
  const remainingGap = Math.max(0, totalOverspent - coveredSoFar);

  const getSourceAvailable = (id) => id === "rta" ? rtaAvailable : getAvailable(id, targetMonth);
  const getSourceLabel = (id) => id === "rta" ? "Ready to Assign" : budget.categories.find(c => c.id === id)?.name || id;

  const usedIds = new Set(sources.map(s => s.id));
  const availableSources = [
    ...(rtaAvailable > 0.005 && !usedIds.has("rta") ? [{ id: "rta", name: "Ready to Assign", available: rtaAvailable }] : []),
    ...sourceCats.filter(c => !usedIds.has(c.id)).map(c => ({ id: c.id, name: c.name, available: getAvailable(c.id, targetMonth) })),
  ];
  const totalSourceAvailable = availableSources.reduce((s, src) => s + src.available, 0) + sources.reduce((s, src) => s + getSourceAvailable(src.id), 0);
  const noMoneyAtAll = totalSourceAvailable < 0.005 && sources.length === 0;

  // Auto-add when user selects from dropdown — no Add button needed
  const handleSelectSource = (id) => {
    if (!id) return;
    const avail = getSourceAvailable(id);
    if (avail <= 0.005) return;
    const prefill = Math.round(Math.min(avail, remainingGap) * 100) / 100;
    setSources(p => [...p, { id, amount: prefill }]);
  };

  const updateAmount = (id, val) => {
    const avail = getSourceAvailable(id);
    const gap = remainingGap + (sources.find(s => s.id === id)?.amount || 0);
    const clamped = Math.min(Math.max(0, val), Math.min(avail, gap));
    setSources(p => p.map(s => s.id === id ? { ...s, amount: clamped } : s));
  };

  const removeSource = (id) => setSources(p => p.filter(s => s.id !== id));

  const handleApply = () => {
    const validSources = sources.filter(s => s.amount > 0.005);
    if (validSources.length === 0) return;
    onCover(targetMonth, overspentCats, validSources);
  };

  return (
    <Modal title={`Cover Overspending — ${keyLabel(targetMonth)}`} onClose={onClose}>
      {cascadeNote && (
        <div style={{ background: "#FFF0F0", border: `1px solid ${C.red}`, borderRadius: 8, padding: "10px 12px", fontSize: 12, color: C.red, marginBottom: 14, lineHeight: 1.5 }}>
          ⚠️ {cascadeNote}
        </div>
      )}
      {/* Overspent categories */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: C.muted, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>Overspent Categories</div>
        {overspentCats.map(cat => (
          <div key={cat.id} style={{ display: "flex", justifyContent: "space-between", padding: "6px 10px", background: "#FFF8F8", borderRadius: 6, marginBottom: 4, fontSize: 13 }}>
            <span>{cat.name}</span>
            <span style={{ color: C.red, fontWeight: 700 }}>{fmt(getAvailable(cat.id, targetMonth))}</span>
          </div>
        ))}
        <div style={{ display: "flex", justifyContent: "space-between", padding: "8px 10px", fontSize: 13, fontWeight: 700, borderTop: `1px solid ${C.border}`, marginTop: 4 }}>
          <span>Total to Cover</span>
          <span style={{ color: remainingGap < 0.005 ? C.green : C.red }}>{fmt(-totalOverspent)}</span>
        </div>
      </div>

      {noMoneyAtAll ? (
        <div style={{ padding: "12px 14px", background: "#FFF8F8", borderRadius: 8, fontSize: 13, color: C.muted, marginBottom: 16, lineHeight: 1.6 }}>
          There are no available funds in any category or Ready to Assign to cover this overspending. Add income or reduce spending in another category first.
        </div>
      ) : (
        <>
          {/* Sources list */}
          {sources.length > 0 && (
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: C.muted, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>Pulling From</div>
              {sources.map(src => (
                <div key={src.id} style={{ marginBottom: 10 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                    <span style={{ fontSize: 13, fontWeight: 600 }}>{getSourceLabel(src.id)}</span>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ fontSize: 11, color: C.muted }}>Available: {fmt(getSourceAvailable(src.id))}</span>
                      <button onClick={() => removeSource(src.id)} style={{ background: "none", border: "none", color: C.muted, cursor: "pointer", fontSize: 16, lineHeight: 1, padding: 0 }}>×</button>
                    </div>
                  </div>
                  <AmountInput
                    initialValue={src.amount || undefined}
                    onCommit={v => updateAmount(src.id, v)}
                    onChange={v => updateAmount(src.id, v)}
                    placeholder="0.00"
                  />
                </div>
              ))}
              <div style={{ display: "flex", justifyContent: "space-between", padding: "8px 10px", fontSize: 13, fontWeight: 700, borderTop: `1px solid ${C.border}` }}>
                <span>Remaining Gap</span>
                <span style={{ color: remainingGap < 0.005 ? C.green : C.amber }}>{remainingGap < 0.005 ? "✅ Covered!" : fmt(-remainingGap)}</span>
              </div>
            </div>
          )}

          {/* Source selector — auto-adds on change, no Add button */}
          {availableSources.length > 0 && remainingGap > 0.005 && (
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: C.muted, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>Pull From</div>
              <select value="" onChange={e => handleSelectSource(e.target.value)} style={{ ...inputSt }}
                onMouseDown={e => e.stopPropagation()} onTouchStart={e => e.stopPropagation()}>
                <option value="">Select a category to add...</option>
                {availableSources.map(s => (
                  <option key={s.id} value={s.id}>{s.name} ({fmt(s.available)} available)</option>
                ))}
              </select>
            </div>
          )}

          {availableSources.length === 0 && remainingGap > 0.005 && (
            <div style={{ fontSize: 12, color: C.muted, marginBottom: 16, fontStyle: "italic" }}>No more sources available. You can partially cover and return later.</div>
          )}
        </>
      )}

      <BtnRow onCancel={onClose} onSave={handleApply} saveLabel="Apply" saveColor={C.green} disabled={noMoneyAtAll || sources.filter(s => s.amount > 0.005).length === 0} />
    </Modal>
  );
}

function ExpiredGoalsModal({ expiredCats, budget, updateBudget, onAllResolved }) {
  // Track resolution state per category: null = unresolved, "remove", or { date, amount } for new goal
  const [resolutions, setResolutions] = useState(() => Object.fromEntries(expiredCats.map(c => [c.id, null])));
  const [subModal, setSubModal] = useState(null); // catId currently in sub-modal
  const [newDate, setNewDate] = useState("");
  const [newAmount, setNewAmount] = useState(0);
  const [subError, setSubError] = useState("");

  const allResolved = expiredCats.every(c => resolutions[c.id] !== null);
  const todayMonth = toKey(new Date());

  const openSubModal = (catId) => {
    setSubModal(catId);
    setNewDate("");
    setNewAmount(0);
    setSubError("");
  };

  const confirmNewGoal = () => {
    if (!newDate) { setSubError("Please select a target date."); return; }
    if (!newAmount || newAmount <= 0) { setSubError("Please enter a target amount."); return; }
    if (newDate <= todayMonth) { setSubError("Target date must be in the future."); return; }
    setResolutions(p => ({ ...p, [subModal]: { date: newDate, amount: newAmount } }));
    setSubModal(null);
  };

  const applyAll = () => {
    if (!allResolved) return;
    const updatedCats = budget.categories.map(cat => {
      const res = resolutions[cat.id];
      if (!res) return cat;
      if (res === "remove") return { ...cat, goal: null, rollover: "rollover" };
      return { ...cat, goal: { type: "date", target: res.amount, targetDate: res.date } };
    });
    updateBudget({ categories: updatedCats });
    onAllResolved();
  };

  // Sub-modal: set new goal
  if (subModal) {
    const cat = expiredCats.find(c => c.id === subModal);
    return (
      <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1100, padding: 16 }}>
        <div style={{ background: C.surface, borderRadius: 16, padding: "24px 20px", width: "100%", maxWidth: 460, boxShadow: "0 8px 40px rgba(0,0,0,0.3)" }}>
          <div style={{ fontSize: 18, fontWeight: 800, marginBottom: 6 }}>Set New Goal — {cat.name}</div>
          <div style={{ fontSize: 13, color: C.textLight, marginBottom: 16, lineHeight: 1.6 }}>Enter a new target amount and date. Both are required.</div>
          <AmountInput label="New Target Amount ($)" initialValue={newAmount || undefined} onCommit={v => setNewAmount(v)} placeholder="e.g. 2000" />
          <Field label="New Target Date">
            <input type="month" style={{ ...inputSt, WebkitAppearance: "none", appearance: "none", width: "100%", minWidth: 0, maxWidth: "100%", boxSizing: "border-box", minHeight: 44, lineHeight: "1.5" }}
              value={newDate} onChange={e => { setNewDate(e.target.value); setSubError(""); }} min={nextKey(todayMonth)} />
          </Field>
          {subError && <div style={{ fontSize: 12, color: C.red, marginTop: -10, marginBottom: 12 }}>{subError}</div>}
          <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
            <Btn outline color={C.muted} onClick={() => setSubModal(null)} style={{ flex: 1 }}>← Back</Btn>
            <Btn color={C.green} onClick={confirmNewGoal} style={{ flex: 1 }} disabled={!newDate || !newAmount}>Confirm</Btn>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1100, padding: 16 }}>
      <div style={{ background: C.surface, borderRadius: 16, padding: "24px 20px", width: "100%", maxWidth: 460, boxShadow: "0 8px 40px rgba(0,0,0,0.3)", maxHeight: "85vh", overflowY: "auto" }}>
        <div style={{ fontSize: 18, fontWeight: 800, marginBottom: 6 }}>🏁 Goals Past Their Date</div>
        <div style={{ fontSize: 13, color: C.textLight, marginBottom: 20, lineHeight: 1.6 }}>
          The following categories had target-by-date goals that have passed. Please set a new goal or remove the goal for each one before continuing.
        </div>
        {expiredCats.map(cat => {
          const res = resolutions[cat.id];
          return (
            <div key={cat.id} style={{ marginBottom: 16, padding: "14px 16px", borderRadius: 10, background: res ? "#F0FAF3" : "#FFF8F8", border: `1.5px solid ${res ? C.green : C.red}` }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 }}>
                <div>
                  <div style={{ fontWeight: 700, fontSize: 14 }}>{cat.name}</div>
                  <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>Goal: {fmt(cat.goal.target)} by {cat.goal.targetDate}</div>
                </div>
                {res && <div style={{ fontSize: 18 }}>✅</div>}
              </div>
              {res ? (
                <div style={{ fontSize: 12, color: C.green, marginBottom: 8 }}>
                  {res === "remove" ? "Goal will be removed. Rollover set to Roll Over." : `New goal: ${fmt(res.amount)} by ${res.date}`}
                </div>
              ) : null}
              <div style={{ display: "flex", gap: 8 }}>
                <Btn small color={C.navy} onClick={() => openSubModal(cat.id)} style={{ flex: 1 }}>
                  {res && res !== "remove" ? "✏️ Change Goal" : "Set New Goal"}
                </Btn>
                <Btn small outline color={C.red} onClick={() => setResolutions(p => ({ ...p, [cat.id]: "remove" }))} style={{ flex: 1 }}>
                  {res === "remove" ? "✓ Removing" : "Remove Goal"}
                </Btn>
              </div>
            </div>
          );
        })}
        <Btn color={C.green} onClick={applyAll} disabled={!allResolved} style={{ width: "100%", marginTop: 8 }}>
          {allResolved ? "✅ Done — Apply Changes" : `Resolve all ${expiredCats.filter(c => !resolutions[c.id]).length} remaining to continue`}
        </Btn>
      </div>
    </div>
  );
}

function EditTxModal({ tx, budget, isLocked, isStartingBalance, onSave, onDelete, onClose, canonicalNames, getDisplayName, getPayeeDefaultCategory, getPayeeSuggestedCategory, findCCPaymentCatId, updateBudget }) {
  const locked = isLocked(tx);
  const [form, setForm] = useState(() => {
    // For payment transactions, derive the logical category value for the picker
    let categoryId = tx.categoryId || "";
    if (tx.type === "payment") {
      if (tx.paymentFromAccountId) {
        categoryId = makePayFromValue(tx.paymentFromAccountId);
      } else if (tx.categoryId) {
        categoryId = tx.categoryId;
      }
    } else if (tx.type === "income") {
      // Income transactions have no categoryId; pre-select RTA so saving without
      // changing keeps it as income instead of silently converting to expense
      categoryId = "__rta__";
    }
    return {
      payee: getDisplayName(tx.originalPayee),
      accountId: tx.accountId || "",
      categoryId,
      date: tx.date,
      note: tx.note || "",
      amount: Math.abs(tx.amount),
      isRefund: tx.type === "expense" && tx.amount < 0,
      splits: tx.splits || null,
      type: tx.type,
    };
  });
  const [payeeDropOpen, setPayeeDropOpen] = useState(false);

  // splitTotal is always an absolute value; isRefund on form determines the sign
  const [splitTotal, setSplitTotal] = useState(() => form.splits ? Math.abs(tx.amount) : 0);

  const handleSave = () => {
    if (isStartingBalance || locked) { onClose(); return; }

    if (form.splits) {
      const splitSum = form.splits.filter(s => s.categoryId && s.amount > 0).reduce((s, sp) => s + Math.abs(sp.amount), 0);
      if (Math.abs(splitSum - splitTotal) > 0.005) return;
    }

    const updates = { note: form.note.trim() };
    if (form.payee.trim() !== getDisplayName(tx.originalPayee)) {
      const newOriginal = toTitleCase(form.payee.trim());
      updates.payee = newOriginal; updates.originalPayee = newOriginal;
    }
    if (form.accountId !== tx.accountId) updates.accountId = form.accountId;
    const oldMk = tx.date.slice(0, 7);
    const newMk = form.date.slice(0, 7);
    const monthChanged = form.date !== tx.date;
    if (monthChanged) updates.date = form.date;

    const accountId = form.accountId || tx.accountId;
    const isCardAccount = budget.creditCards.some(c => c.id === accountId);
    const isBankAccount = budget.accounts.some(a => a.id === accountId);

    // Split transaction
    if (form.splits) {
      const validSplits = form.splits.filter(s => s.categoryId && s.amount > 0);
      const signedSplits = validSplits.map(s => ({ ...s, amount: form.isRefund ? -Math.abs(s.amount) : Math.abs(s.amount) }));
      const signedTotal = form.isRefund ? -Math.abs(splitTotal) : Math.abs(splitTotal);
      updates.splits = signedSplits; updates.categoryId = null; updates.amount = signedTotal; updates.categoryConfirmed = undefined;
      updates.type = "expense";
      if (isCardAccount) {
        const ccPayCatId = findCCPaymentCatId(accountId);
        if (ccPayCatId) {
          // Use SIGNED amounts so refunds (negative) reverse in the correct direction.
          const oldSigned = Number(tx.amount);   // original signed amount on the card
          const newSigned = signedTotal;          // new signed total (already refund-aware)
          let newMB = JSON.parse(JSON.stringify(budget.monthlyBudgets));
          if (monthChanged) {
            newMB[oldMk] = { ...(newMB[oldMk] || {}) }; newMB[oldMk][ccPayCatId] = (newMB[oldMk][ccPayCatId] || 0) - oldSigned;
            newMB[newMk] = { ...(newMB[newMk] || {}) }; newMB[newMk][ccPayCatId] = (newMB[newMk][ccPayCatId] || 0) + newSigned;
          } else if (Math.abs(newSigned - oldSigned) > 0.005) {
            newMB[oldMk] = { ...(newMB[oldMk] || {}) }; newMB[oldMk][ccPayCatId] = (newMB[oldMk][ccPayCatId] || 0) + (newSigned - oldSigned);
          }
          updateBudget({ transactions: budget.transactions.map(t => t.id === tx.id ? { ...t, ...updates } : t), monthlyBudgets: newMB });
          onClose(); return;
        }
      }
      onSave(tx.id, updates); onClose(); return;
    }

    // Category-driven type detection (same logic as addTx and new form)
    const catId = form.categoryId;

    // RTA → income (or staying as income)
    if (catId === "__rta__") {
      const newAmount = Math.abs(form.amount) || Math.abs(tx.amount);
      const convUpdates = { type: "income", categoryId: null, categoryConfirmed: undefined, paymentLinkStatus: undefined, paymentFromAccountId: undefined, amount: newAmount };
      let newInflows = { ...budget.inflows };
      if (tx.type === "income") {
        // Already income — adjust inflows for amount/date change only
        const oldMkLocal = tx.date.slice(0, 7);
        const newMkLocal = (updates.date || tx.date).slice(0, 7);
        newInflows[oldMkLocal] = (newInflows[oldMkLocal] || 0) - Math.abs(tx.amount);
        newInflows[newMkLocal] = (newInflows[newMkLocal] || 0) + newAmount;
      } else {
        // Converting expense/payment → income: add new amount to inflows
        const mk = tx.date.slice(0, 7);
        newInflows[mk] = (newInflows[mk] || 0) + newAmount;
      }
      updateBudget({
        transactions: budget.transactions.map(t => t.id === tx.id ? { ...t, ...updates, ...convUpdates } : t),
        inflows: newInflows,
      });
      onClose(); return;
    }

    // CC account + "Payment from [X]" → CC-side payment
    if (isCardAccount && isPayFromValue(catId)) {
      const fromAccountId = getPayFromAccountId(catId);
      const convUpdates = { type: "payment", categoryId: undefined, categoryConfirmed: undefined, paymentLinkStatus: "broken", paymentFromAccountId: fromAccountId, amount: form.amount };
      const scanned = runPaymentMatchScan(
        budget.transactions.map(t => t.id === tx.id ? { ...t, ...updates, ...convUpdates } : t),
        budget.creditCards, budget.accounts
      );
      updateBudget({ transactions: scanned }); onClose(); return;
    }

    // Bank account + CC payment category → bank-side payment
    if (isBankAccount && catId) {
      const ccPayCat = budget.categories.find(c => c.id === catId && c.creditCardId);
      if (ccPayCat) {
        const convUpdates = { type: "payment", categoryId: catId, categoryConfirmed: undefined, paymentLinkStatus: "broken", paymentFromAccountId: undefined, amount: form.amount };
        const scanned = runPaymentMatchScan(
          budget.transactions.map(t => t.id === tx.id ? { ...t, ...updates, ...convUpdates } : t),
          budget.creditCards, budget.accounts
        );
        updateBudget({ transactions: scanned }); onClose(); return;
      }
    }

    // Regular expense (or revert from income/payment to expense)
    const rawAmount = form.isRefund ? -Math.abs(form.amount) : Math.abs(form.amount);
    updates.amount = rawAmount;
    updates.categoryId = catId || null;
    updates.categoryConfirmed = catId ? true : undefined;
    updates.type = "expense";
    updates.paymentLinkStatus = undefined;
    updates.paymentFromAccountId = undefined;

    // If converting FROM income, remove old amount from inflows
    if (tx.type === "income") {
      const mk = tx.date.slice(0, 7);
      const newInflows = { ...budget.inflows };
      newInflows[mk] = (newInflows[mk] || 0) - Math.abs(tx.amount);
      updateBudget({ transactions: budget.transactions.map(t => t.id === tx.id ? { ...t, ...updates } : t), inflows: newInflows });
      onClose(); return;
    }

    if (monthChanged && tx.type === "income") {
      updateBudget({ transactions: budget.transactions.map(t => t.id === tx.id ? { ...t, ...updates } : t), inflows: { ...budget.inflows, [oldMk]: (budget.inflows[oldMk] || 0) - Number(tx.amount), [newMk]: (budget.inflows[newMk] || 0) + Number(tx.amount) } });
      onClose(); return;
    }
    // Card expense: keep the CC payment category in sync with month and/or amount changes.
    // Use SIGNED amounts (rawAmount is refund-aware) so refunds reverse correctly.
    if (isCardAccount && tx.type === "expense") {
      const ccPayCatId = findCCPaymentCatId(accountId);
      if (ccPayCatId) {
        const oldSigned = Number(tx.amount);
        const newSigned = rawAmount;
        let newMB = JSON.parse(JSON.stringify(budget.monthlyBudgets));
        if (monthChanged) {
          newMB[oldMk] = { ...(newMB[oldMk] || {}) }; newMB[oldMk][ccPayCatId] = (newMB[oldMk][ccPayCatId] || 0) - oldSigned;
          newMB[newMk] = { ...(newMB[newMk] || {}) }; newMB[newMk][ccPayCatId] = (newMB[newMk][ccPayCatId] || 0) + newSigned;
          updateBudget({ transactions: budget.transactions.map(t => t.id === tx.id ? { ...t, ...updates } : t), monthlyBudgets: newMB });
          onClose(); return;
        } else if (Math.abs(newSigned - oldSigned) > 0.005) {
          newMB[oldMk] = { ...(newMB[oldMk] || {}) }; newMB[oldMk][ccPayCatId] = (newMB[oldMk][ccPayCatId] || 0) + (newSigned - oldSigned);
          updateBudget({ transactions: budget.transactions.map(t => t.id === tx.id ? { ...t, ...updates } : t), monthlyBudgets: newMB });
          onClose(); return;
        }
        // No month or amount change affecting the card → fall through to plain save
      }
    }
    onSave(tx.id, updates);
    onClose();
  };

  if (isStartingBalance) {
    return (
      <Modal title="🏦 Starting Balance" onClose={onClose}>
        <div style={{ background: "#F4F1EB", border: `1px solid ${C.border}`, borderRadius: 8, padding: 10, fontSize: 12, color: C.textLight, marginBottom: 14 }}>
          🔒 This is a Starting Balance transaction. It's permanently locked and cannot be edited or deleted.
        </div>
        <Btn outline color={C.muted} onClick={onClose} style={{ width: "100%" }}>Close</Btn>
      </Modal>
    );
  }

  return (
    <Modal title="Edit Transaction" onClose={onClose} closeLabel="Discard">
      {locked && (
        <div style={{ background: "#F4F1EB", border: `1px solid ${C.border}`, borderRadius: 8, padding: 10, fontSize: 12, color: C.textLight, marginBottom: 14 }}>
          🔒 This transaction is locked (reconciled). Category and note can still be edited.
        </div>
      )}


      {/* Payee with autocomplete */}
      <Field label="Date">
        <input type="date" value={form.date} disabled={locked}
          onChange={e => setForm(p => ({ ...p, date: e.target.value }))}
          style={{ ...inputSt, width: "100%", minWidth: 0, maxWidth: "100%", WebkitAppearance: "none", appearance: "none", boxSizing: "border-box", color: locked ? C.muted : C.text }} />
      </Field>

      {/* Payee — hidden for payment transactions */}
      {form.type !== "payment" && !isPayFromValue(form.categoryId) && !budget.categories.some(c => c.id === form.categoryId && c.creditCardId) && (
      <Field label="Payee">
        <div style={{ position: "relative" }}>
          <input style={inputSt} value={form.payee} autoComplete="off" autoCorrect="off" autoCapitalize="words" spellCheck={false} disabled={locked}
            onChange={e => { setForm(p => ({ ...p, payee: e.target.value })); setPayeeDropOpen(true); }}
            onFocus={() => setPayeeDropOpen(true)}
            onBlur={() => setTimeout(() => setPayeeDropOpen(false), 150)} />
          {payeeDropOpen && form.payee.trim() && (() => {
            const q = form.payee.trim().toLowerCase();
            const matches = canonicalNames.filter(n => n.toLowerCase().includes(q));
            if (!matches.length) return null;
            return (
              <div style={{ position: "absolute", top: "100%", left: 0, right: 0, zIndex: 500, background: C.surface, border: `1.5px solid ${C.navy}`, borderRadius: 8, boxShadow: "0 4px 20px rgba(0,0,0,0.15)", marginTop: 2, maxHeight: 200, overflowY: "auto" }}>
                {matches.slice(0, 8).map(name => (
                  <button key={name} type="button" onMouseDown={() => { setForm(p => ({ ...p, payee: name })); setPayeeDropOpen(false); }}
                    style={{ display: "block", width: "100%", textAlign: "left", padding: "10px 14px", background: "none", border: "none", borderBottom: `1px solid #F4F1EB`, fontSize: 14, color: C.text, cursor: "pointer", fontFamily: "inherit" }}>
                    {name}
                  </button>
                ))}
              </div>
            );
          })()}
        </div>
      </Field>
      )}

      {!locked && (
        <SearchableSel label="Account" value={form.accountId} onChange={v => setForm(p => ({ ...p, accountId: v, categoryId: "" }))}
          options={buildAccountOptions(budget.accounts, budget.creditCards)} placeholder="Search accounts..." />
      )}

      {/* Category — always shown, options depend on account type */}
      {!form.splits && (
        <SearchableSel label="Category" value={form.categoryId}
          onChange={v => setForm(p => ({ ...p, categoryId: v }))}
          options={buildCatOptionsForAccount(form.accountId || tx.accountId, budget, [
            { value: "__rta__", label: "→ Ready to Assign (convert to income)" },
          ])}
          placeholder="Search categories..." disabled={locked && !form.categoryId} />
      )}

      {/* Amount — +/- toggle only for regular expenses */}
      {!form.splits && (() => {
        const isIncome = form.categoryId === "__rta__";
        const isPaymentCat = isPayFromValue(form.categoryId) || budget.categories.some(c => c.id === form.categoryId && c.creditCardId);
        const isSpecial = isIncome || isPaymentCat;
        if (isSpecial) {
          return (
            <AmountInput label="Amount" initialValue={form.amount || undefined}
              onCommit={v => setForm(p => ({ ...p, amount: Math.max(0, v) }))}
              onChange={v => setForm(p => ({ ...p, amount: Math.max(0, v) }))}
              placeholder="0.00" disabled={locked} />
          );
        }
        return (
          <Field label="Amount">
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <div style={{ display: "flex", borderRadius: 8, overflow: "hidden", border: `1.5px solid ${C.border}`, flexShrink: 0 }}>
                <button onClick={() => setForm(p => ({ ...p, isRefund: false }))} disabled={locked}
                  style={{ padding: "0 14px", height: 44, background: !form.isRefund ? C.red : "transparent", color: !form.isRefund ? "#fff" : C.muted, border: "none", borderRight: `1px solid ${C.border}`, cursor: locked ? "default" : "pointer", fontSize: 18, fontWeight: 900, fontFamily: "inherit" }}>−</button>
                <button onClick={() => setForm(p => ({ ...p, isRefund: true }))} disabled={locked}
                  style={{ padding: "0 14px", height: 44, background: form.isRefund ? C.green : "transparent", color: form.isRefund ? "#fff" : C.muted, border: "none", cursor: locked ? "default" : "pointer", fontSize: 18, fontWeight: 900, fontFamily: "inherit" }}>+</button>
              </div>
              {locked ? (
                <div style={{ ...inputSt, flex: 1, color: C.muted, display: "flex", alignItems: "center", gap: 4 }}>
                  <span style={{ fontWeight: 800 }}>{form.isRefund ? "+" : "−"}</span>
                  <span>{fmt(form.amount)}</span>
                </div>
              ) : (
                <AmountInput label="Amount" initialValue={form.amount} signPrefix={form.isRefund ? "+" : "−"}
                  onToggleSign={() => setForm(p => ({ ...p, isRefund: !p.isRefund }))}
                  onCommit={v => setForm(p => ({ ...p, amount: v }))}
                  onChange={v => setForm(p => ({ ...p, amount: v }))}
                  placeholder="0.00" style={{ flex: 1 }} />
              )}
            </div>
          </Field>
        );
      })()}

      {/* Split — only for regular expense categories; requires amount */}
      {!form.splits && !locked && form.categoryId !== "__rta__" && !isPayFromValue(form.categoryId) && !budget.categories.some(c => c.id === form.categoryId && c.creditCardId) && (
        <button
          onClick={() => { setSplitTotal(Math.abs(form.amount) || 0); setForm(p => ({ ...p, splits: [{ categoryId: p.categoryId || "", amount: Math.abs(p.amount) || 0 }, { categoryId: "", amount: 0 }], preSplitCategoryId: p.categoryId, preSplitAmount: p.amount, categoryId: "" })); }}
          disabled={!form.amount}
          style={{ background: "none", border: "none", color: form.amount ? C.purple : C.muted, fontSize: 12, fontWeight: 700, cursor: form.amount ? "pointer" : "not-allowed", padding: "0 0 14px", fontFamily: "inherit", opacity: form.amount ? 1 : 0.5 }}>
          🔀 Split into multiple categories
        </button>
      )}

      {form.splits && (() => {
        const splitSum = form.splits.reduce((s, sp) => s + Math.abs(sp.amount || 0), 0);
        const remaining = Math.round((splitTotal - splitSum) * 100) / 100;
        const balanced = Math.abs(remaining) < 0.005;
        return (
          <div style={{ marginBottom: 14 }}>
            <label style={{ display: "block", fontSize: 11, fontWeight: 700, color: C.muted, marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.07em" }}>Split Categories</label>
            {/* Total at top with +/- toggle */}
            <Field label="Total Transaction Amount">
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <div style={{ display: "flex", borderRadius: 8, overflow: "hidden", border: `1.5px solid ${C.border}`, flexShrink: 0 }}>
                  <button onClick={() => setForm(p => ({ ...p, isRefund: false }))}
                    style={{ padding: "0 14px", height: 44, background: !form.isRefund ? C.red : "transparent", color: !form.isRefund ? "#fff" : C.muted, border: "none", borderRight: `1px solid ${C.border}`, cursor: "pointer", fontSize: 18, fontWeight: 900, fontFamily: "inherit" }}>−</button>
                  <button onClick={() => setForm(p => ({ ...p, isRefund: true }))}
                    style={{ padding: "0 14px", height: 44, background: form.isRefund ? C.green : "transparent", color: form.isRefund ? "#fff" : C.muted, border: "none", cursor: "pointer", fontSize: 18, fontWeight: 900, fontFamily: "inherit" }}>+</button>
                </div>
                <AmountInput label="Total Transaction Amount" initialValue={splitTotal} signPrefix={form.isRefund ? "+" : "−"} placeholder="0.00" style={{ flex: 1 }}
                  onToggleSign={() => setForm(p => ({ ...p, isRefund: !p.isRefund }))}
                  onChange={v => setSplitTotal(Math.abs(v))} onCommit={v => setSplitTotal(Math.abs(v))} />
              </div>
            </Field>
            {/* Individual splits — positive amounts only */}
            {form.splits.map((sp, i) => (
              <div key={i} style={{ display: "flex", gap: 8, marginBottom: 8, alignItems: "flex-start" }}>
                <div style={{ flex: 2 }}>
                  <SearchableSel value={sp.categoryId} onChange={v => setForm(p => ({ ...p, splits: p.splits.map((s, j) => j === i ? { ...s, categoryId: v } : s) }))}
                    options={buildCatOptions(budget.categoryGroups, budget.categories.filter(c => !c.creditCardId), { emptyLabel: "Category..." })} placeholder="Search..." />
                </div>
                <div style={{ flex: 1 }}>
                  <AmountInput initialValue={Math.abs(sp.amount) || undefined} placeholder="0.00"
                    onChange={v => setForm(p => ({ ...p, splits: p.splits.map((s, j) => j === i ? { ...s, amount: Math.abs(v) } : s) }))}
                    onCommit={v => setForm(p => ({ ...p, splits: p.splits.map((s, j) => j === i ? { ...s, amount: Math.abs(v) } : s) }))} />
                </div>
                <button onClick={() => {
                  if (form.splits.length <= 1) return;
                  const next = form.splits.filter((_, j) => j !== i);
                  if (next.length === 1) {
                    setForm(p => ({ ...p, categoryId: p.preSplitCategoryId || next[0].categoryId || "", amount: p.preSplitAmount || splitTotal || 0, splits: null, preSplitCategoryId: undefined, preSplitAmount: undefined }));
                  } else {
                    setForm(p => ({ ...p, splits: next }));
                  }
                }} style={{ background: "none", border: "none", color: "#C0BBCC", fontSize: 18, cursor: "pointer", padding: "8px 2px" }}>×</button>
              </div>
            ))}
            <div style={{ display: "flex", gap: 8, marginTop: 4, marginBottom: 8 }}>
              <button onClick={() => setForm(p => ({ ...p, splits: [...p.splits, { categoryId: "", amount: 0 }] }))}
                style={{ background: "none", border: "none", color: C.purple, fontSize: 12, fontWeight: 700, cursor: "pointer", padding: 0, fontFamily: "inherit" }}>+ Add Split</button>
              <button onClick={() => setForm(p => ({ ...p, categoryId: p.preSplitCategoryId || "", amount: p.preSplitAmount || splitTotal || 0, splits: null, preSplitCategoryId: undefined, preSplitAmount: undefined }))}
                style={{ background: "none", border: "none", color: C.muted, fontSize: 12, cursor: "pointer", padding: 0, fontFamily: "inherit" }}>✕ Cancel Split</button>
            </div>
            {/* Balance indicator */}
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, padding: "6px 8px", borderRadius: 6, background: balanced ? "#EAF6F0" : "#FFF4E5" }}>
              <span style={{ color: balanced ? C.green : C.amber, fontWeight: 700 }}>{balanced ? "✓ Balanced" : `${fmt(remaining)} remaining`}</span>
              <span style={{ color: C.muted }}>Total: {form.isRefund ? "+" : "−"}{fmt(splitTotal)}</span>
            </div>
          </div>
        );
      })()}

      <Field label="Note">
        <input style={inputSt} value={form.note} placeholder="Add a note..." onChange={e => setForm(p => ({ ...p, note: e.target.value }))} />
      </Field>

      <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
        <Btn outline color={C.muted} onClick={onClose} style={{ flex: 1 }}>Discard</Btn>
        <Btn color={C.navy} onClick={handleSave} disabled={form.splits && Math.abs(form.splits.reduce((s, sp) => s + Math.abs(sp.amount || 0), 0) - splitTotal) > 0.005} style={{ flex: 1 }}>Save & Close</Btn>
        {!locked && <Btn color={C.red} onClick={() => { onDelete(tx); onClose(); }} style={{ flex: 1 }}>Delete</Btn>}
      </div>
    </Modal>
  );
}

function CatNoteModal({ cat, month, existing, onSave, onClose }) {
  const [noteVal, setNoteVal] = useState(existing);
  const monthLabel = new Date(month + "-15").toLocaleDateString("en-US", { month: "short", year: "2-digit" });
  const persistentNote = cat?.note || "";
  return (
    <Modal title={`📝 ${cat?.name}`} onClose={onClose} closeLabel="Discard">
      <div style={{ fontSize: 11, fontWeight: 700, color: C.muted, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6 }}>Note for {monthLabel}</div>
      <div style={{ fontSize: 12, color: C.textLight, marginBottom: 8, lineHeight: 1.6 }}>
        Appended to all transactions in this category for {monthLabel}.
      </div>
      <Field label="">
        <textarea value={noteVal} onChange={e => setNoteVal(e.target.value)} placeholder={`e.g. "Holiday spending"`} style={{ ...inputSt, minHeight: 80, resize: "vertical", fontFamily: "inherit" }} autoFocus />
      </Field>
      <BtnRow onCancel={onClose} onSave={() => onSave(noteVal)} saveLabel={noteVal.trim() ? "Save Note" : "Clear Note"} saveColor={C.navy} />
      {persistentNote && (
        <div style={{ marginTop: 16, paddingTop: 14, borderTop: `1px solid ${C.border}` }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: C.muted, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6 }}>Category Note</div>
          <div style={{ fontSize: 13, color: C.text, lineHeight: 1.7, whiteSpace: "pre-wrap", background: C.inputBg, borderRadius: 8, padding: "10px 12px" }}>{persistentNote}</div>
        </div>
      )}
    </Modal>
  );
}

// ── TxSearchBar: search input + autocomplete dropdown + chip row ──────────────
function TxSearchBar({ value, onChange, chips, onAddChip, onRemoveChip, onClearChips, budget, getDisplayName, UNCONFIRMED_FILTER, C, inputSt, fmt, searchRef }) {
  const [focused, setFocused] = useState(false);
  const [activeIdx, setActiveIdx] = useState(-1);
  const inputRef = useRef(null);
  const dropRef = useRef(null);

  // Build suggestions from current input
  const suggestions = useMemo(() => {
    const raw = (value || "").trim();
    if (!raw) return [];
    const q = raw.toLowerCase();
    const groups = [];

    // ── Payees ──
    const payeeNames = [...new Set(
      budget.transactions.map(tx => getDisplayName(tx.originalPayee)).filter(Boolean)
    )];
    const payeeMatches = payeeNames.filter(n => n.toLowerCase().includes(q)).slice(0, 4);
    if (payeeMatches.length) groups.push({ group: "Payees", icon: "👤", items: payeeMatches.map(n => ({ type: "payee", label: n, value: n, display: n })) });

    // ── Categories ──
    const catMatches = budget.categories.filter(c => !c.archived && c.name.toLowerCase().includes(q)).slice(0, 4);
    if (catMatches.length) groups.push({ group: "Categories", icon: "🏷", items: catMatches.map(c => ({ type: "category", label: c.name, value: c.id, display: c.name })) });

    // ── Accounts ──
    const accMatches = [
      ...budget.accounts.filter(a => !a.archived && a.name.toLowerCase().includes(q)).map(a => ({ type: "account", label: a.name, value: a.id, display: a.name })),
      ...budget.creditCards.filter(c => !c.archived && c.name.toLowerCase().includes(q)).map(c => ({ type: "account", label: c.name, value: c.id, display: c.name })),
    ].slice(0, 4);
    if (accMatches.length) groups.push({ group: "Accounts", icon: "🏦", items: accMatches });

    // ── Amounts ── digit-substring match: "2156" finds $21.56, $215.60, $2156.00 etc.
    const digitsOnly = raw.replace(/[^0-9]/g, "");
    if (digitsOnly.length > 0 && /^[\d$,. ]+$/.test(raw)) {
      groups.push({ group: "Amount", icon: "💰", items: [
        { type: "amount_digits", label: `Amount containing "${digitsOnly}"`, value: digitsOnly, display: `amt: ${digitsOnly}` },
      ]});
    }

    // ── Months ── e.g. "june", "jun 2026", "2026-06"
    const monthNames = ["january","february","march","april","may","june","july","august","september","october","november","december"];
    const monthAbbr  = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"];
    const today = new Date();
    let monthIdx = monthNames.findIndex(m => m.startsWith(q));
    if (monthIdx === -1) monthIdx = monthAbbr.findIndex(m => m === q.slice(0,3));
    // ISO month prefix e.g. "2026-06"
    const isoMonthMatch = raw.match(/^(\d{4})-(\d{2})$/);
    if (isoMonthMatch) {
      const [, yr, mo] = isoMonthMatch;
      const label = new Date(Number(yr), Number(mo)-1, 1).toLocaleString("default", { month: "long", year: "numeric" });
      groups.push({ group: "Month", icon: "📅", items: [{ type: "month", label, value: `${yr}-${mo}`, display: label }] });
    } else if (monthIdx !== -1) {
      // Show current year and next year matches
      [-1, 0, 1].map(offset => {
        const yr = today.getFullYear() + offset;
        const mo = String(monthIdx + 1).padStart(2, "0");
        const mk = `${yr}-${mo}`;
        // Only include if there are transactions in that month
        const hasTx = budget.transactions.some(tx => tx.date.startsWith(mk));
        if (hasTx) {
          const label = new Date(yr, monthIdx, 1).toLocaleString("default", { month: "long", year: "numeric" });
          return { type: "month", label, value: mk, display: label };
        }
        return null;
      }).filter(Boolean).slice(0, 3).forEach(item => {
        if (!groups.find(g => g.group === "Month")) groups.push({ group: "Month", icon: "📅", items: [] });
        groups.find(g => g.group === "Month").items.push(item);
      });
    }

    // ── Transaction type ──
    const typeMap = { income: { label: "Income", value: "income" }, expense: { label: "Expenses", value: "expense" }, payment: { label: "Payments", value: "payment" }, transfer: { label: "Transfers", value: "transfer" } };
    const typeMatches = Object.entries(typeMap).filter(([k]) => k.startsWith(q)).map(([, v]) => ({ type: "txtype", label: v.label, value: v.value, display: v.label }));
    if (typeMatches.length) groups.push({ group: "Type", icon: "🔄", items: typeMatches });

    return groups;
  }, [value, budget]);

  // Flat list for keyboard nav
  const flatItems = useMemo(() => suggestions.flatMap(g => g.items), [suggestions]);

  const applyItem = (item) => {
    onAddChip({ id: uid(), type: item.type, label: item.display || item.label, value: item.value });
    setActiveIdx(-1);
  };

  const handleKeyDown = (e) => {
    if (!focused || !flatItems.length) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setActiveIdx(p => Math.min(p + 1, flatItems.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActiveIdx(p => Math.max(p - 1, -1)); }
    else if (e.key === "Enter" && activeIdx >= 0) { e.preventDefault(); applyItem(flatItems[activeIdx]); }
    else if (e.key === "Escape") { setFocused(false); inputRef.current?.blur(); }
    else if (e.key === "Backspace" && !value && chips.length) { onRemoveChip(chips[chips.length - 1].id); }
  };

  const showDrop = focused && suggestions.length > 0;

  // Chip type → color
  const chipColor = (type) => {
    if (type === "payee") return C.navy;
    if (type === "category") return C.purple;
    if (type === "account") return "#2E7D32";
    if (type.startsWith("amount")) return C.gold;
    if (type === "month") return "#0277BD";
    if (type === "txtype") return C.muted;
    return C.navy;
  };

  return (
    <div style={{ position: "relative" }}>
      {/* Search input */}
      <div style={{ padding: "8px 14px", display: "flex", gap: 7, background: C.surface, borderBottom: `1px solid ${C.border}`, alignItems: "center" }}>
        <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 6, background: "#fff", border: `1.5px solid ${focused ? C.navy : C.border}`, borderRadius: 8, padding: "5px 10px", transition: "border-color 0.15s" }}>
          <span style={{ color: C.muted, fontSize: 14, flexShrink: 0 }}>🔍</span>
          <input
            ref={(el) => { inputRef.current = el; if (searchRef) searchRef.current = el; }}
            value={value}
            onChange={e => { onChange(e.target.value); setActiveIdx(-1); }}
            onFocus={() => setFocused(true)}
            onBlur={() => setTimeout(() => setFocused(false), 150)}
            onKeyDown={handleKeyDown}
            placeholder={chips.length ? "Add another filter..." : "Search payees, categories, amounts, dates..."}
            style={{ flex: 1, border: "none", outline: "none", fontSize: 13, background: "transparent", fontFamily: "inherit", color: C.text, minWidth: 0 }}
          />
          {value && <button onClick={() => onChange("")} style={{ background: "none", border: "none", color: C.muted, cursor: "pointer", fontSize: 16, padding: "0 2px", flexShrink: 0 }}>×</button>}
        </div>
      </div>

      {/* Autocomplete dropdown */}
      {showDrop && (
        <div ref={dropRef} style={{ position: "absolute", top: "100%", left: 14, right: 14, background: "#fff", border: `1px solid ${C.border}`, borderRadius: 10, boxShadow: "0 4px 20px rgba(0,0,0,0.12)", zIndex: 400, maxHeight: 360, overflowY: "auto" }}>
          {suggestions.map((group, gi) => (
            <div key={gi}>
              <div style={{ fontSize: 10, fontWeight: 800, color: C.muted, textTransform: "uppercase", letterSpacing: "0.07em", padding: "8px 12px 4px" }}>
                {group.icon} {group.group}
              </div>
              {group.items.map((item, ii) => {
                const flatIdx = flatItems.indexOf(item);
                const isActive = flatIdx === activeIdx;
                return (
                  <div key={ii}
                    onMouseDown={() => applyItem(item)}
                    style={{ padding: "8px 12px", cursor: "pointer", fontSize: 13, background: isActive ? "#EEF2FF" : "transparent", display: "flex", alignItems: "center", gap: 8, borderTop: ii === 0 ? `1px solid ${C.border}` : "none" }}>
                    <span style={{ flex: 1, fontWeight: 500 }}>{item.label}</span>
                    <span style={{ fontSize: 11, color: C.muted, background: "#F0EEE9", borderRadius: 4, padding: "1px 5px" }}>{group.group}</span>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}

      {/* Chips row */}
      {chips.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, padding: "6px 14px", background: C.surface, borderBottom: `1px solid ${C.border}` }}>
          {chips.map(chip => (
            <div key={chip.id} style={{ display: "inline-flex", alignItems: "center", gap: 4, background: chipColor(chip.type), color: "#fff", borderRadius: 20, padding: "3px 8px 3px 10px", fontSize: 12, fontWeight: 600, maxWidth: 220 }}>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{chip.label}</span>
              <button onClick={() => onRemoveChip(chip.id)} style={{ background: "rgba(255,255,255,0.3)", border: "none", color: "#fff", borderRadius: "50%", width: 16, height: 16, cursor: "pointer", fontSize: 11, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, padding: 0, fontFamily: "inherit" }}>×</button>
            </div>
          ))}
          <button onClick={onClearChips} style={{ background: "none", border: "none", color: C.muted, cursor: "pointer", fontSize: 12, padding: "3px 4px", fontFamily: "inherit" }}>Clear all</button>
        </div>
      )}
    </div>
  );
}

function MainApp({ appData, onSave, onUndo, canUndo, onRedo, canRedo, userAccount, onSaveUserAccount, onLogOut }) {
  const [nav, setNav] = useState("budget");
  const [month, setMonth] = useState(toKey(new Date()));
  const [modal, setModal] = useState(null);
  const [collapsed, setCollapsed] = useState({});
  const [showArchived, setShowArchived] = useState(false);
  const [reorderMode, setReorderMode] = useState(false);
  const [avgHintCatId, setAvgHintCatId] = useState(null);
  const [showExpiredGoals, setShowExpiredGoals] = useState(true);
  const [showAutoAssignWarning, setShowAutoAssignWarning] = useState(false);
  const [confirmTxDelete, setConfirmTxDelete] = useState(null); // tx to delete after confirm
  const [selectedTxIds, setSelectedTxIds] = useState(new Set()); // bulk selection
  const [bulkDeleteConfirm, setBulkDeleteConfirm] = useState(false);
  const [bulkCatModal, setBulkCatModal] = useState(false);
  const inSelectionMode = selectedTxIds.size > 0;
  const exitSelection = () => setSelectedTxIds(new Set());
  const filteredTxsRef = useRef([]); // tracks current filtered tx list for Select All
  const [coverOverspendModal, setCoverOverspendModal] = useState(null);
  const [suggestMergeNav, setSuggestMergeNav] = useState(false); // signals PayeesView to open merge modal
  const [catNoteModal, setCatNoteModal] = useState(null); // { catId, month }
  const [catNoteTooltip, setCatNoteTooltip] = useState(null); // { catId, text }

  const openMergeFromNav = () => { setNav("payees"); setSuggestMergeNav(true); };
  const [inlineCatPickerTxId, setInlineCatPickerTxId] = useState(null);
  const [payeeDropOpen, setPayeeDropOpen] = useState(false);

  const localToday = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`; };
  const blankTxForm = () => ({ date: localToday(), payee: "", categoryId: "", amount: 0, note: "", type: "expense", accountId: "", splits: null, isRefund: false });
  const [txForm, setTxForm] = useState(blankTxForm());
  const [catSettingsId, setCatSettingsId] = useState(null);
  const [moveMoneyState, setMoveMoneyState] = useState(null);
  const [editGroupId, setEditGroupId] = useState(null);
  const [cascadePrompt, setCascadePrompt] = useState(null);
  const [savingsPrompt, setSavingsPrompt] = useState(null);
  const [clawbackPrompt, setClawbackPrompt] = useState(null);
  const [autoAssignPreview, setAutoAssignPreview] = useState(null); // { amounts: {catId: number}, result }
  const [recapData, setRecapData] = useState(null);
  const [contextMenu, setContextMenu] = useState(null);
  const [expandedTxId, setExpandedTxId] = useState(null);
  const [editingTx, setEditingTx] = useState(null);
  const [txSearch, setTxSearch] = useState("");
  const [txSearchChips, setTxSearchChips] = useState([]); // [{ id, type, label, value }]
  const addChip = (chip) => { setTxSearchChips(p => [...p.filter(c => !(c.type === chip.type && c.value === chip.value)), chip]); setTxSearch(""); };
  const removeChip = (id) => setTxSearchChips(p => p.filter(c => c.id !== id));
  const clearChips = () => setTxSearchChips([]);
  const [showTxFilters, setShowTxFilters] = useState(false);
  const blankTxFilters = () => ({ accountId: "", categoryId: "", categoryIds: null, categoryLabel: "", payee: "", type: "", dateFrom: "", dateTo: "", amountGT: false, amountLT: false, amountEQ: true, amountVal: "" });
  const UNCONFIRMED_FILTER = "__unconfirmed__";  const [txFilters, setTxFilters] = useState(blankTxFilters());
  // Navigate to the Transactions tab with a specific filter applied (and the filter panel open).
  const goToTransactions = (filterPatch) => {
    setTxFilters({ ...blankTxFilters(), ...filterPatch });
    setTxSearch(""); clearChips();
    setShowTxFilters(true);
    setNav("transactions");
  };
  const [importState, setImportState] = useState(null);

  const longPressTimer = useRef(null);

  const budget = appData.budgets.find(b => b.id === appData.activeBudgetId);
  const updateBudget = (updates) => onSave({ ...appData, budgets: appData.budgets.map(b => b.id === budget.id ? { ...b, ...updates } : b) });

  // Efficiency: sort transactions by date once per data change rather than on every render.
  // This is a pure transform; the transaction-list filter consumes it below.
  const sortedTxsByDate = useMemo(
    () => [...(budget?.transactions || [])].sort((a, b) => b.date.localeCompare(a.date)),
    [budget?.transactions]
  );

  // ── Long press / right click binding ──
  const bindContextMenu = (items) => ({
    onTouchStart: () => { longPressTimer.current = setTimeout(() => setContextMenu({ items }), 500); },
    onTouchEnd: () => { if (longPressTimer.current) { clearTimeout(longPressTimer.current); longPressTimer.current = null; } },
    onTouchMove: () => { if (longPressTimer.current) { clearTimeout(longPressTimer.current); longPressTimer.current = null; } },
    onContextMenu: (e) => { e.preventDefault(); setContextMenu({ items }); },
  });

  // Long-press on a transaction row enters bulk selection mode
  const bindTxLongPress = (txId) => ({
    onTouchStart: () => { longPressTimer.current = setTimeout(() => { setSelectedTxIds(new Set([txId])); }, 500); },
    onTouchEnd: () => { if (longPressTimer.current) { clearTimeout(longPressTimer.current); longPressTimer.current = null; } },
    onTouchMove: () => { if (longPressTimer.current) { clearTimeout(longPressTimer.current); longPressTimer.current = null; } },
    onContextMenu: (e) => { e.preventDefault(); setSelectedTxIds(new Set([txId])); },
  });

  // ── Drag & drop reordering for categories and groups ──
  const pendingDragRef = useRef(null);
  const dragInfoRef = useRef(null);
  const [dragInfo, setDragInfoState] = useState(null);
  const dropTargetRef = useRef(null);
  const [dropTarget, setDropTargetState] = useState(null);
  const preDragCollapsedRef = useRef(null);
  const setDragInfo = (v) => { dragInfoRef.current = v; setDragInfoState(v); };
  const setDropTarget = (v) => { dropTargetRef.current = v; setDropTargetState(v); };

  // Begin a potential drag; promoted to an actual drag once the pointer moves past a small threshold.
  // Bound to a small handle so it doesn't fight with the row's long-press/right-click context menu.
  const bindDragHandle = (type, id) => ({
    onMouseDown: (e) => { if (e.button !== 0) return; e.stopPropagation(); pendingDragRef.current = { type, id, startX: e.clientX, startY: e.clientY }; },
    onTouchStart: (e) => {
      e.stopPropagation();
      const t = e.touches[0];
      pendingDragRef.current = { type, id, startX: t.clientX, startY: t.clientY };
      // Lock page-level touch gestures (scroll/swipe) immediately so the artifact preview
      // doesn't swipe away while the finger is on the drag handle.
      document.documentElement.style.touchAction = "none";
      document.body.style.touchAction = "none";
    },
  });

  const moveCategory = (catId, targetGroupId, beforeCatId) => {
    const cats = budget.categories;
    const cat = cats.find(c => c.id === catId);
    if (!cat || beforeCatId === catId) return;
    const others = cats.filter(c => c.id !== catId);
    const updatedCat = { ...cat, groupId: targetGroupId };
    let newArr = [];
    if (beforeCatId) {
      others.forEach(c => { if (c.id === beforeCatId) newArr.push(updatedCat); newArr.push(c); });
      if (!newArr.includes(updatedCat)) newArr.push(updatedCat);
    } else {
      const groupCats = others.filter(c => c.groupId === targetGroupId);
      const lastId = groupCats[groupCats.length - 1]?.id;
      if (lastId) others.forEach(c => { newArr.push(c); if (c.id === lastId) newArr.push(updatedCat); });
      else newArr = [...others, updatedCat];
    }
    updateBudget({ categories: newArr });
  };

  const moveGroup = (groupId, beforeGroupId) => {
    const groups = [...budget.categoryGroups];
    const idx = groups.findIndex(g => g.id === groupId);
    if (idx < 0 || beforeGroupId === groupId) return;
    const [g] = groups.splice(idx, 1);
    if (beforeGroupId) {
      const newIdx = groups.findIndex(gg => gg.id === beforeGroupId);
      groups.splice(newIdx < 0 ? groups.length : newIdx, 0, g);
    } else {
      groups.push(g);
    }
    updateBudget({ categoryGroups: groups });
  };

  useEffect(() => {
    const THRESH = 8;
    const getPoint = (e) => e.touches ? e.touches[0] : e;
    const onMove = (e) => {
      if (dragInfoRef.current) {
        e.preventDefault?.();
        const point = getPoint(e);
        const el = document.elementFromPoint(point.clientX, point.clientY);
        if (dragInfoRef.current.type === "category") {
          const catEl = el?.closest("[data-dnd-cat]");
          const hdrEl = el?.closest("[data-dnd-grouphdr]");
          if (catEl) {
            const rect = catEl.getBoundingClientRect();
            const groupId = catEl.dataset.dndGroup;
            const catId = catEl.dataset.dndCat;
            let beforeId = catId;
            if (point.clientY > rect.top + rect.height / 2) {
              const groupCats = budget.categories.filter(c => c.groupId === groupId && !c.archived);
              const idx = groupCats.findIndex(c => c.id === catId);
              beforeId = groupCats[idx + 1]?.id || null;
            }
            setDropTarget({ groupId, beforeId });
          } else if (hdrEl) {
            const groupId = hdrEl.dataset.dndGrouphdr;
            const groupCats = budget.categories.filter(c => c.groupId === groupId && !c.archived);
            setDropTarget({ groupId, beforeId: groupCats[0]?.id || null });
          }
        } else if (dragInfoRef.current.type === "group") {
          const hdrEl = el?.closest("[data-dnd-grouphdr]");
          if (hdrEl) {
            const rect = hdrEl.getBoundingClientRect();
            const groupId = hdrEl.dataset.dndGrouphdr;
            let beforeGroupId = groupId;
            if (point.clientY > rect.top + rect.height / 2) {
              const idx = budget.categoryGroups.findIndex(g => g.id === groupId);
              beforeGroupId = budget.categoryGroups[idx + 1]?.id || null;
            }
            setDropTarget({ beforeGroupId });
          }
        }
      } else if (pendingDragRef.current) {
        e.preventDefault?.();
        const point = getPoint(e);
        const dx = Math.abs(point.clientX - pendingDragRef.current.startX);
        const dy = Math.abs(point.clientY - pendingDragRef.current.startY);
        if (dx > THRESH || dy > THRESH) {
          const { type, id } = pendingDragRef.current;
          if (type === "group") {
            preDragCollapsedRef.current = collapsed;
            const allCollapsed = {};
            budget.categoryGroups.forEach(g => { allCollapsed[g.id] = true; });
            setCollapsed(allCollapsed);
          }
          setDragInfo({ type, id });
        }
      }
    };
    const onUp = () => {
      if (dragInfoRef.current) {
        const { type, id } = dragInfoRef.current;
        const dt = dropTargetRef.current;
        if (dt) {
          if (type === "category") moveCategory(id, dt.groupId, dt.beforeId);
          else moveGroup(id, dt.beforeGroupId);
        }
        if (type === "group" && preDragCollapsedRef.current) setCollapsed(preDragCollapsedRef.current);
        preDragCollapsedRef.current = null;
        setDragInfo(null);
        setDropTarget(null);
      }
      pendingDragRef.current = null;
      document.documentElement.style.touchAction = "";
      document.body.style.touchAction = "";
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    window.addEventListener("touchmove", onMove, { passive: false });
    window.addEventListener("touchend", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("touchmove", onMove);
      window.removeEventListener("touchend", onUp);
    };
  }, [budget, collapsed]);

  // Suppress text selection everywhere while a category/group drag is in progress
  useEffect(() => {
    if (dragInfo) {
      const prev = document.body.style.userSelect;
      const prevWebkit = document.body.style.webkitUserSelect;
      document.body.style.userSelect = "none";
      document.body.style.webkitUserSelect = "none";
      return () => { document.body.style.userSelect = prev; document.body.style.webkitUserSelect = prevWebkit; };
    }
  }, [dragInfo]);

  // ── Global keyboard shortcuts ──
  useEffect(() => {
    let pendingG = false;
    let gTimer = null;
    const resetG = () => { pendingG = false; clearTimeout(gTimer); };

    const onKey = (e) => {
      // Never fire when focus is inside a text input or editable element
      const tag = document.activeElement?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || document.activeElement?.isContentEditable) return;
      // Never fire when the custom amount pad is open
      if (document.querySelector("[data-amount-pad-open]")) return;

      const meta = e.metaKey || e.ctrlKey;

      // Cmd/Ctrl+Z → undo, Cmd/Ctrl+Shift+Z → redo
      if (meta && e.key === "z" && !e.shiftKey) { e.preventDefault(); if (canUndo) onUndo(); return; }
      if (meta && (e.key === "Z" || (e.key === "z" && e.shiftKey))) { e.preventDefault(); if (canRedo) onRedo(); return; }
      if (meta) return; // don't intercept other Cmd/Ctrl combos

      // Escape → close any open modal/panel
      if (e.key === "Escape") {
        setShowShortcuts(false);
        setNotifOpen(false);
        setShowTxFilters(false);
        resetG();
        return;
      }

      // ? → shortcuts help modal
      if (e.key === "?") { e.preventDefault(); setShowShortcuts(p => !p); resetG(); return; }

      // G-prefix navigation
      if (e.key === "g" || e.key === "G") {
        e.preventDefault();
        pendingG = true;
        clearTimeout(gTimer);
        gTimer = setTimeout(resetG, 1000);
        return;
      }
      if (pendingG) {
        resetG();
        const dest = { b: "budget", t: "transactions", a: "accounts", p: "payees", s: "settings" }[e.key.toLowerCase()];
        if (dest) { e.preventDefault(); setNav(dest); }
        return;
      }

      // ← / → month navigation (budget view)
      if (nav === "budget") {
        if (e.key === "ArrowLeft") { e.preventDefault(); setMonth(prevKey(month)); return; }
        if (e.key === "ArrowRight") { e.preventDefault(); setMonth(nextKey(month)); return; }
      }

      // Transactions view shortcuts
      if (nav === "transactions") {
        if (e.key === "n" || e.key === "N") { e.preventDefault(); setModal("tx"); return; }
        if (e.key === "/") { e.preventDefault(); txSearchInputRef.current?.focus(); return; }
      }
    };

    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("keydown", onKey); clearTimeout(gTimer); };
  }, [nav, month, canUndo, canRedo, onUndo, onRedo]);
  // Used to decide whether a month has "history" behind it (for rollover / RTA carryforward),
  // even across gap months that have no explicit entries of their own.
  const monthKeysWithData = [
    ...Object.keys(budget.monthlyBudgets),
    ...Object.keys(budget.inflows),
    ...budget.transactions.map(tx => tx.date.slice(0, 7)),
  ];
  const budgetStartMonth = monthKeysWithData.length > 0 ? monthKeysWithData.sort()[0] : null;
  const hasPriorData = (mk) => budgetStartMonth !== null && prevKey(mk) >= budgetStartMonth;
  const todayMonth = toKey(new Date());

  // ── Spend map: pre-compute spent amounts by month+category in one pass (#1) ──
  // Instead of scanning all transactions on every getAvailableSim call, build a lookup
  // table once and reuse it. Re-memoized only when transactions change.
  const spentByMonthCat = useMemo(() => {
    const map = {};
    budget.transactions.forEach(tx => {
      if (tx.type !== "expense" && tx.type !== "payment") return;
      if (!tx.date) return;
      const mk = tx.date.slice(0, 7);
      if (!map[mk]) map[mk] = {};
      // Use signed amount — negative expenses (refunds) reduce activity
      if (tx.splits) {
        tx.splits.forEach(sp => {
          if (!sp.categoryId) return;
          map[mk][sp.categoryId] = (map[mk][sp.categoryId] || 0) + Number(sp.amount);
        });
      } else if (tx.categoryId) {
        map[mk][tx.categoryId] = (map[mk][tx.categoryId] || 0) + Number(tx.amount);
      }
    });
    return map;
  }, [budget.transactions]);

  // ── Account & card balance maps: pre-compute in one pass (#17) ──
  const accountBalanceMap = useMemo(() => {
    const map = {};
    budget.accounts.forEach(a => { map[a.id] = a.balance; });
    budget.creditCards.forEach(c => { map[c.id] = c.balance; });
    const isCard = (id) => budget.creditCards.some(c => c.id === id);
    budget.transactions.forEach(tx => {
      const amt = Number(tx.amount); // keep sign — refunds (negative expenses) reduce balance
      if (tx.type === "income") {
        if (map[tx.accountId] !== undefined) map[tx.accountId] += Math.abs(amt);
      } else if (tx.type === "expense") {
        if (isCard(tx.accountId)) {
          // Card: positive expense increases debt; negative expense (refund) reduces debt
          if (map[tx.accountId] !== undefined) map[tx.accountId] += amt;
        } else {
          // Bank: positive expense reduces balance; negative expense (refund) increases balance
          if (map[tx.accountId] !== undefined) map[tx.accountId] -= amt;
        }
      } else if (tx.type === "transfer") {
        // Transfer amount is signed: from-tx has negative amount, to-tx has positive amount
        if (map[tx.accountId] !== undefined) map[tx.accountId] += amt;
      } else if (tx.type === "payment") {
        // Each side of a payment is its own transaction — reduce its own account balance
        if (map[tx.accountId] !== undefined) map[tx.accountId] -= Math.abs(amt);
      } else if (tx.type === "adjustment") {
        if (map[tx.accountId] !== undefined) map[tx.accountId] += amt;
      }
    });
    return map;
  }, [budget.transactions, budget.accounts, budget.creditCards]);

  // ── Per-month rollover: effective rollover type for a given month ──
  // cat.rollover is the original type; cat.rolloverChanges: [{ month, type }] records changes
  // made going forward from a specific month. Always use this instead of cat.rollover directly.
  const getEffectiveRollover = (cat, mk) => {
    if (!cat?.rolloverChanges?.length) return cat?.rollover || "rollover";
    // Find the latest change with month <= mk
    const applicable = cat.rolloverChanges
      .filter(c => c.month <= mk)
      .sort((a, b) => b.month.localeCompare(a.month));
    return applicable[0]?.type ?? (cat?.rollover || "rollover");
  };

  // ── Available / Returned / Ready-to-Assign (parametrized for simulation) ──
  const getAvailableSim = (catId, mk, mb, inf, depth = 0) => {
    if (depth > 60) return 0;
    const cat = budget.categories.find(c => c.id === catId);
    const budgeted = Number((mb[mk] || {})[catId] || 0);
    // Use pre-computed spend map when using live budget data; fall back to scan for simulations (#1)
    const spent = (mb === budget.monthlyBudgets && inf === budget.inflows)
      ? (spentByMonthCat[mk]?.[catId] || 0)
      : budget.transactions
          .filter(tx => tx.date.startsWith(mk) && (tx.type === "expense" || tx.type === "payment"))
          .reduce((s, tx) => {
            if (tx.splits) {
              return s + tx.splits.filter(sp => sp.categoryId === catId).reduce((ss, sp) => ss + Number(sp.amount), 0);
            }
            return tx.categoryId === catId ? s + Number(tx.amount) : s;
          }, 0);
    if (!hasPriorData(mk)) return budgeted - spent;
    const pk = prevKey(mk);
    const prevAvail = getAvailableSim(catId, pk, mb, inf, depth + 1);
    let rollover;
    if (prevAvail < 0) {
      rollover = prevAvail;
    } else if (cat?.goal?.type === "date") {
      const target = cat.goal.target || 0;
      rollover = Math.min(prevAvail, target);
    } else {
      const s = getEffectiveRollover(cat, pk); // use effective rollover for the PREVIOUS month
      if (s === "return") rollover = 0;
      else if (s === "max") rollover = Math.min(prevAvail, cat?.rolloverMax || 0);
      else rollover = prevAvail;
    }
    return budgeted - spent + rollover;
  };
  // Returns how much a single category returned to RTA for month `mk`
  const getCatReturnedToRTA = (cat, mk, mb, inf) => {
    if (!hasPriorData(mk)) return 0;
    const pk = prevKey(mk);
    const pv = getAvailableSim(cat.id, pk, mb, inf);
    if (pv <= 0) return 0;
    if (cat.goal?.type === "date") {
      const target = cat.goal.target || 0;
      return Math.max(0, pv - Math.min(pv, target));
    }
    const s = getEffectiveRollover(cat, pk);
    if (s === "return") return pv;
    if (s === "max") return Math.max(0, pv - (cat.rolloverMax || 0));
    return 0;
  };
  // Total returned to RTA across all categories for a given month (used in RTA calc).
  // Only counts past months for RTA purposes (current month money may still be spent).
  const getReturnedToRTASim = (mk, mb, inf) => {
    if (!hasPriorData(mk)) return 0;
    const pk = prevKey(mk);
    if (pk >= todayMonth) return 0;
    return budget.categories.reduce((total, cat) => total + getCatReturnedToRTA(cat, mk, mb, inf), 0);
  };
  // Ready to Assign is a running balance: this month's surplus/deficit plus whatever
  // was left unassigned (or overassigned) at the end of the previous month.
  const getToAssignSim = (mk, mb, inf, depth = 0) => {
    if (depth > 60) return 0;
    const budgetsForMonth = mb[mk] || {};
    const totalBudgeted = Object.values(budgetsForMonth).reduce((s, v) => s + Number(v), 0);
    const totalInflow = Number(inf[mk] || 0);
    const returned = getReturnedToRTASim(mk, mb, inf);
    const prevRTA = hasPriorData(mk) ? getToAssignSim(prevKey(mk), mb, inf, depth + 1) : 0;
    return prevRTA + totalInflow + returned - totalBudgeted;
  };
  const getAvailable = (catId, mk) => getAvailableSim(catId, mk, budget.monthlyBudgets, budget.inflows);
  const getReturnedToRTA = (mk) => getReturnedToRTASim(mk, budget.monthlyBudgets, budget.inflows);

  // ── Precomputed available map for all live-data lookups ──
  // Replaces repeated recursive getAvailable calls in render loops.
  // Re-memoized only when budget data changes.
  const availableMap = useMemo(() => {
    const monthKeys = Array.from(new Set([
      ...Object.keys(budget.monthlyBudgets),
      ...Object.keys(budget.inflows),
      ...budget.transactions.map(tx => tx.date.slice(0, 7)),
      toKey(new Date()),
    ]));
    const map = {};
    budget.categories.forEach(cat => {
      monthKeys.forEach(mk => {
        if (!map[cat.id]) map[cat.id] = {};
        map[cat.id][mk] = getAvailableSim(cat.id, mk, budget.monthlyBudgets, budget.inflows);
      });
    });
    return map;
  }, [budget.monthlyBudgets, budget.inflows, budget.transactions, budget.categories]);

  // O(1) lookup backed by availableMap; falls back to live computation for unknown months
  const getAvailableFast = (catId, mk) => availableMap[catId]?.[mk] ?? getAvailableSim(catId, mk, budget.monthlyBudgets, budget.inflows);

  // Trailing average spend for a category: up to 3 prior months (excluding the
  // current in-progress month), refund-aware. Returns null if no history exists.
  // Returns { avg, monthsUsed }.
  const getTrailingAvg = (catId, mk) => {
    let k = prevKey(mk);
    let sum = 0, count = 0, guard = 0;
    while (count < 3 && guard < 3) {
      const monthSpend = spentByMonthCat[k]?.[catId];
      if (monthSpend !== undefined) { sum += monthSpend; count++; }
      k = prevKey(k); guard++;
    }
    if (count === 0) return null;
    return { avg: sum / count, monthsUsed: count };
  };

  // Precomputed returnedToRTA per month
  const returnedToRTAMap = useMemo(() => {
    const monthKeys = Object.keys(availableMap[Object.keys(availableMap)[0]] || {});
    const map = {};
    monthKeys.forEach(mk => { map[mk] = getReturnedToRTASim(mk, budget.monthlyBudgets, budget.inflows); });
    return map;
  }, [availableMap, budget.monthlyBudgets, budget.inflows]);

  // ── Month navigation accessibility ──
  // The next month is always reachable. Months beyond that require the prior
  // month to have any money assigned. Past months need either activity
  // (transactions) or assigned money to remain reachable.
  const monthHasAssigned = (mk) => Object.values(budget.monthlyBudgets[mk] || {}).some(v => Number(v) !== 0);
  const monthHasActivity = (mk) => budget.transactions.some(tx => tx.date.startsWith(mk));
  const monthIsAccessible = (mk) => {
    if (mk <= todayMonth) {
      if (mk === todayMonth) return true;
      return monthHasActivity(mk) || monthHasAssigned(mk);
    }
    if (mk === nextKey(todayMonth)) return true;
    return monthHasAssigned(prevKey(mk));
  };

  const checkUnderfundedSim = (mk, mb, inf) => budget.categories.some(cat => {
    if (!cat.goal?.type || cat.archived) return false;
    const avail = getAvailableSim(cat.id, mk, mb, inf);
    const m = getGoalMetrics(cat, avail, (mb[mk] || {})[cat.id] || 0, mk);
    if (!m || m.complete) return false;
    return (m.type === "monthly" && m.underfunded) || (m.type === "date" && !m.onTrack);
  });

  const budgetsNow = budget.monthlyBudgets[month] || {};
  const totalBudgeted = Object.values(budgetsNow).reduce((s, v) => s + Number(v), 0);

  // activityByCat: use the already-memoized spend map — correctly handles split transactions
  const activityByCat = spentByMonthCat[month] || {};

  // ── Account / Credit Card running ledger balances ──
  // Use pre-computed accountBalanceMap for O(1) lookup (#17)
  const getAccountBalance = (accId) => accountBalanceMap[accId] ?? 0;
  const getCardBalance = (ccId) => accountBalanceMap[ccId] ?? 0;

  // ── Reconciliation locking ──
  // A transaction is locked once its account (or, for a payment, the card it paid) has been
  // reconciled as of a date on or after the transaction's date.
  // O(1) account/card lookup by id — built once, reused in hot paths like isLocked
  const acctById = useMemo(() => {
    const m = {};
    budget.accounts.forEach(a => { m[a.id] = a; });
    budget.creditCards.forEach(c => { m[c.id] = c; });
    return m;
  }, [budget.accounts, budget.creditCards]);

  const isLocked = (tx) => {
    if (tx.reconciled) return true;
    const acc = acctById[tx.accountId];
    if (acc?.reconciledDate && tx.date <= acc.reconciledDate) return true;
    return false;
  };


  // ── Payees ──
  // Display name resolution: every transaction's `originalPayee` maps (via budget.payees)
  // to a `canonicalName` that's shown throughout the UI. If no mapping exists, the original
  // name displays as itself.
  const getDisplayName = (originalName) => {
    if (!originalName) return originalName;
    const rec = (budget.payees || []).find(p => p.name === originalName);
    return rec?.canonicalName || originalName;
  };
  // All distinct canonical (display) names currently in use, derived from transactions and
  // payee records — used for the Payees tab list and the transaction-entry autocomplete.
  const canonicalNames = useMemo(() => Array.from(new Set([
    ...budget.transactions.filter(tx => tx.subtype !== "starting_balance").map(tx => getDisplayName(tx.originalPayee)).filter(Boolean),
    ...(budget.payees || []).map(p => p.canonicalName).filter(Boolean),
  ])), [budget.transactions, budget.payees]);

  const rejectedMerges = budget.rejectedMerges || [];

  // sortedPayees: canonical names that have at least one non-starting-balance transaction.
  // Memoized to avoid O(n×m) scan on every render. (#8, #16)
  const sortedPayees = useMemo(() => {
    const withTx = new Set(
      budget.transactions
        .filter(tx => tx.subtype !== "starting_balance")
        .map(tx => getDisplayName(tx.originalPayee))
        .filter(Boolean)
    );
    return [...canonicalNames].filter(n => withTx.has(n)).sort((a, b) => a.localeCompare(b));
  }, [canonicalNames, budget.transactions]);

  // Merge suggestion badge count — uses the same buildMergeGroups as PayeesView
  // so the badge count always matches what the modal actually shows. (#4, #7)
  const mainSuggestedMergeGroups = useMemo(
    () => buildMergeGroups(sortedPayees, rejectedMerges, budget.mergeExcludeWords || []),
    [sortedPayees, rejectedMerges, budget.mergeExcludeWords]
  );
  // All original payee names that currently display as `canonicalName`.
  const getOriginalsForCanonical = (canonicalName) => {
    const fromPayees = (budget.payees || []).filter(p => p.canonicalName === canonicalName).map(p => p.name);
    const fromTx = budget.transactions
      .map(tx => tx.originalPayee)
      .filter(Boolean)
      .filter(name => getDisplayName(name) === canonicalName);
    return Array.from(new Set([...fromPayees, ...fromTx]));
  };
  const getPayeeDefaultCategory = (canonicalName) => {
    for (const name of getOriginalsForCanonical(canonicalName)) {
      const rec = (budget.payees || []).find(p => p.name === name);
      if (rec?.defaultCategoryId) return rec.defaultCategoryId;
    }
    return "";
  };
  const setPayeeDefaultCategory = (canonicalName, categoryId) => {
    const originals = getOriginalsForCanonical(canonicalName);
    let newPayees = [...(budget.payees || [])];
    originals.forEach(name => {
      const existing = newPayees.find(p => p.name === name);
      if (existing) newPayees = newPayees.map(p => p.name === name ? { ...p, defaultCategoryId: categoryId, suggestedCategoryId: "" } : p);
      else newPayees.push({ id: uid(), name, defaultCategoryId: categoryId, suggestedCategoryId: "", canonicalName });
    });
    updateBudget({ payees: newPayees });
  };
  const getPayeeSuggestedCategory = (canonicalName) => {
    for (const name of getOriginalsForCanonical(canonicalName)) {
      const rec = (budget.payees || []).find(p => p.name === name);
      if (rec?.suggestedCategoryId) return rec.suggestedCategoryId;
    }
    return "";
  };
  const setPayeeSuggestedCategory = (canonicalName, categoryId) => {
    const originals = getOriginalsForCanonical(canonicalName);
    let newPayees = [...(budget.payees || [])];
    originals.forEach(name => {
      const existing = newPayees.find(p => p.name === name);
      if (existing) newPayees = newPayees.map(p => p.name === name ? { ...p, suggestedCategoryId: categoryId, defaultCategoryId: "" } : p);
      else newPayees.push({ id: uid(), name, defaultCategoryId: "", suggestedCategoryId: categoryId, canonicalName });
    });
    updateBudget({ payees: newPayees });
  };
  // Ensure a payee record exists for `originalName` (canonicalName defaults to itself).
  // Returns the resulting payees array without calling updateBudget.
  // Remove payee records that have no transactions referencing their original name.
  // Set the canonical display name for a set of original payee names (merge / display-name change).
  const setCanonicalForNames = (originalNames, canonicalName) => {
    canonicalName = canonicalName.trim();
    if (!canonicalName) return;
    let newPayees = [...(budget.payees || [])];
    originalNames.forEach(name => { newPayees = ensurePayeeRecord(newPayees, name, ""); });
    newPayees = newPayees.map(p => originalNames.includes(p.name) ? { ...p, canonicalName } : p);
    updateBudget({ payees: prunePayees(newPayees, budget.transactions) });
  };
  // Reset a single original payee name back to displaying itself.
  const unmergeOriginal = (originalName) => {
    let newPayees = ensurePayeeRecord(budget.payees || [], originalName, "");
    newPayees = newPayees.map(p => p.name === originalName ? { ...p, canonicalName: p.name } : p);
    updateBudget({ payees: prunePayees(newPayees, budget.transactions) });
  };
  // Reset ALL original names under a canonical in one atomic update.
  const unmergeAllForCanonical = (originalNames) => {
    let newPayees = [...(budget.payees || [])];
    originalNames.forEach(name => { newPayees = ensurePayeeRecord(newPayees, name, ""); });
    newPayees = newPayees.map(p => originalNames.includes(p.name) ? { ...p, canonicalName: p.name } : p);
    updateBudget({ payees: prunePayees(newPayees, budget.transactions) });
  };

  // ── Open (missing account or category) transactions — drives Transactions tab badge ──
  // Unconfirmed-category transactions are handled separately via notifications.
  const openTransactions = budget.transactions.filter(tx =>
    !tx.accountId ||
    (tx.type === "expense" && !tx.categoryId && !tx.splits) ||
    (tx.type === "expense" && tx.categoryId && !tx.splits && tx.categoryConfirmed === false)
  );

  // ── Notification system ──
  const [notifOpen, setNotifOpen] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const txSearchInputRef = useRef(null);
  const [dupReviewOpen, setDupReviewOpen] = useState(false);
  const [pendingReconcile, setPendingReconcile] = useState(null); // { id, name, isCard }
  const [pendingAccountAction, setPendingAccountAction] = useState(null); // { id, isCard, action, name, balance }
  const triggerTransferRef = useRef(null); // set by AccountsView so MainApp modal can open transfer
  // Close duplicate review modal when all pairs are resolved
  useEffect(() => {
    if (!dupReviewOpen) return;
    const remaining = (budget.pendingDuplicates || []).filter(p =>
      budget.transactions.some(t => t.id === p.newTxId) &&
      budget.transactions.some(t => t.id === p.existingTxId)
    );
    if (remaining.length === 0) setDupReviewOpen(false);
  }, [budget.pendingDuplicates, budget.transactions, dupReviewOpen]);
  const [expandedNotifId, setExpandedNotifId] = useState(null);
  // activeNotifications, lastReconciledDateFor and notifCount are computed below
  // after oldestPastOverspendMk and pastMonthsWithOverspend are available.
  const furthestMonth = [month, ...Object.keys(budget.monthlyBudgets)].sort().pop();
  const globalFree = getToAssignSim(furthestMonth, budget.monthlyBudgets, budget.inflows);

  // Simple direct sum of everything already assigned in months after the displayed month
  const assignedAhead = Object.entries(budget.monthlyBudgets)
    .filter(([mk]) => mk > month)
    .reduce((sum, [, vals]) => sum + Object.values(vals).reduce((s, v) => s + Number(v), 0), 0);

  // ── Budget History: computed only when the history modal is open (#6) ──
  // (moved inside modal render — see modal === "history" below)

  // Priority for clawing back assignments from future months (lowest number = unassigned first)
  const unassignPriority = (cat) => {
    if (!cat.goal?.type) return 0;
    if (cat.goal.type === "savings") return 1;
    if (cat.goal.type === "date") return 2;
    return 3; // monthly funding goals — last
  };
  const unassignComparator = (a, b) => {
    const pa = unassignPriority(a), pb = unassignPriority(b);
    if (pa !== pb) return pa - pb;
    if (pa === 2) return (b.goal.targetDate || "").localeCompare(a.goal.targetDate || ""); // furthest deadline first
    return 0;
  };

  const underfundedGoals = budget.categories.filter(cat => {
    if (!cat.goal?.type || cat.archived) return false;
    const m = getGoalMetrics(cat, getAvailableFast(cat.id, month), budgetsNow[cat.id] || 0, month);
    if (!m || m.complete) return false;
    return (m.type === "monthly" && m.underfunded) || (m.type === "date" && !m.onTrack);
  });
  const totalGoalNeeded = underfundedGoals.reduce((s, cat) => { const m = getGoalMetrics(cat, getAvailableFast(cat.id, month), budgetsNow[cat.id] || 0, month); if (!m) return s; if (m.type === "monthly") return s + m.needed; if (m.type === "date") return s + Math.max(0, m.monthlyNeeded - (budgetsNow[cat.id] || 0)); return s; }, 0);
  const hasGoalCats = budget.categories.some(c => c.goal?.type && !c.archived);

  // ── Pure: compute assignments for one month ──
  const computeMonthAssignments = (mk, mb, inf) => {
    const budgetsForMonth = mb[mk] || {};
    let pool = getToAssignSim(mk, mb, inf);
    const newMB = { ...budgetsForMonth };
    const assignments = [];
    if (pool <= 0) return { mb: { ...mb, [mk]: newMB }, assignments, remaining: pool };

    const mbWorking = { ...mb, [mk]: newMB };
    const assign = (catId, amt) => { newMB[catId] = (newMB[catId] || 0) + amt; pool -= amt; assignments.push({ categoryId: catId, amount: amt }); };

    budget.categories.filter(c => c.goal?.type === "monthly" && !c.archived)
      .forEach(cat => {
        if (pool <= 0) return;
        const avail = getAvailableSim(cat.id, mk, mbWorking, inf);
        const m = getGoalMetrics(cat, avail, newMB[cat.id] || 0, mk);
        if (!m) return;
        const n = Math.max(0, m.target - (newMB[cat.id] || 0));
        if (n > 0) assign(cat.id, Math.min(n, pool));
      });

    budget.categories.filter(c => c.goal?.type === "date" && c.goal.targetDate && !c.archived)
      .sort((a, b) => a.goal.targetDate.localeCompare(b.goal.targetDate))
      .forEach(cat => {
        if (pool <= 0) return;
        const avail = getAvailableSim(cat.id, mk, mbWorking, inf);
        const m = getGoalMetrics(cat, avail, newMB[cat.id] || 0, mk);
        if (!m || m.complete) return;
        const n = Math.max(0, m.monthlyNeeded - (newMB[cat.id] || 0));
        if (n > 0) assign(cat.id, Math.min(n, pool));
      });

    return { mb: { ...mb, [mk]: newMB }, assignments, remaining: pool };
  };

  const buildRecap = (allAssignments) => allAssignments.filter(m => m.assignments.length > 0).map(m => ({
    month: m.month,
    items: m.assignments.map(a => ({ name: budget.categories.find(c => c.id === a.categoryId)?.name || "Unknown", amount: a.amount })),
    total: m.assignments.reduce((s, a) => s + a.amount, 0),
  }));

  // Savings-target goals (no date/monthly component) that still need funding
  const getOpenSavingsGoals = (mk, mb, inf) => budget.categories
    .filter(cat => cat.goal?.type === "savings" && !cat.archived)
    .map(cat => {
      const current = getAvailableSim(cat.id, mk, mb, inf);
      const target = cat.goal.target || 0;
      return { id: cat.id, name: cat.name, current, target, need: Math.max(0, target - current) };
    })
    .filter(g => g.need > 0.001);

  // ── Auto-Assign (initial trigger) ──
  const autoAssign = () => {
    const result = computeMonthAssignments(month, budget.monthlyBudgets, budget.inflows);
    if (result.assignments.length === 0) return;
    const amounts = {};
    result.assignments.forEach(a => { amounts[a.categoryId] = a.amount; });
    setAutoAssignPreview({ amounts, result });
  };

  const confirmAutoAssign = () => {
    if (!autoAssignPreview) return;
    const { amounts, result, cascadeContext } = autoAssignPreview;

    if (cascadeContext) {
      // Cascade mode: apply user-edited amounts for this future month
      const { nextM, mb: baseMB, inflows, allAssignments: prevAssignments } = cascadeContext;
      const monthMB = { ...(baseMB[nextM] || {}) };
      const assignments = [];
      result.assignments.forEach(a => {
        const userAmt = Number(amounts[a.categoryId]) || 0;
        if (userAmt > 0) {
          monthMB[a.categoryId] = (monthMB[a.categoryId] || 0) + userAmt;
          assignments.push({ categoryId: a.categoryId, amount: userAmt });
        }
      });
      const newMB = { ...baseMB, [nextM]: monthMB };
      const newAllAssignments = [...prevAssignments, { month: nextM, assignments }];
      const logEntry = assignments.length > 0 ? appendMoveLog({
        type: "assign", month: nextM,
        entries: assignments.map(a => ({ from: "rta", to: a.categoryId, amount: a.amount })),
      }) : {};
      updateBudget({ monthlyBudgets: newMB, ...logEntry });
      setAutoAssignPreview(null);
      proceedAfterAssignment(nextM, newMB, inflows, 0, newAllAssignments);
    } else {
      // Initial month: apply user-edited amounts for the current budget month
      const monthMB = { ...(budget.monthlyBudgets[month] || {}) };
      const assignments = [];
      result.assignments.forEach(a => {
        const userAmt = Number(amounts[a.categoryId]) || 0;
        if (userAmt > 0) {
          monthMB[a.categoryId] = (monthMB[a.categoryId] || 0) + userAmt;
          assignments.push({ categoryId: a.categoryId, amount: userAmt });
        }
      });
      const newMB = { ...budget.monthlyBudgets, [month]: monthMB };
      const totalApplied = assignments.reduce((s, a) => s + a.amount, 0);
      const remaining = globalFree - totalApplied;
      const allAssignments = assignments.length > 0 ? [{ month, assignments }] : [];
      const logEntry = assignments.length > 0 ? appendMoveLog({
        type: "assign", month,
        entries: assignments.map(a => ({ from: "rta", to: a.categoryId, amount: a.amount })),
      }) : {};
      updateBudget({ monthlyBudgets: newMB, ...logEntry });
      setAutoAssignPreview(null);
      proceedAfterAssignment(month, newMB, budget.inflows, remaining, allAssignments);
    }
  };

  // Shared "what's next" logic after assigning for a month: offer to fund
  // plain savings-target goals, then offer to cascade, then recap.
  const proceedAfterAssignment = (mk, mb, inf, _remaining, allAssignments) => {
    // Compute the real RTA from the new mb, using the furthest month across all data.
    // This matches globalFree exactly and accounts for all future-month assignments.
    const newFurthest = [mk, ...Object.keys(mb)].sort().pop();
    const trueRemaining = getToAssignSim(newFurthest, mb, inf);
    const stillUnderfunded = checkUnderfundedSim(mk, mb, inf);
    if (stillUnderfunded || trueRemaining <= 0) {
      setRecapData(buildRecap(allAssignments));
      return;
    }
    const openSavings = getOpenSavingsGoals(mk, mb, inf);
    if (openSavings.length > 0) {
      setSavingsPrompt({ remaining: trueRemaining, mb, inflows: inf, fromMonth: mk, allAssignments, goals: openSavings, amounts: {} });
    } else if (hasGoalCats) {
      setCascadePrompt({ remaining: trueRemaining, mb, inflows: inf, fromMonth: mk, allAssignments });
    } else {
      setRecapData(buildRecap(allAssignments));
    }
  };

  // ── Savings-goal funding prompt ──
  const setSavingsAmount = (catId, val) => setSavingsPrompt(p => ({ ...p, amounts: { ...p.amounts, [catId]: val } }));
  const savingsAllocatedTotal = savingsPrompt ? Object.values(savingsPrompt.amounts).reduce((s, v) => s + (Number(v) || 0), 0) : 0;
  const savingsRemainingAfter = savingsPrompt ? savingsPrompt.remaining - savingsAllocatedTotal : 0;

  const confirmSavingsFund = () => {
    const monthMB = { ...(savingsPrompt.mb[savingsPrompt.fromMonth] || {}) };
    const newAssignments = [];
    let totalAllocated = 0;
    savingsPrompt.goals.forEach(g => {
      const amt = Number(savingsPrompt.amounts[g.id]) || 0;
      if (amt > 0) { monthMB[g.id] = (monthMB[g.id] || 0) + amt; totalAllocated += amt; newAssignments.push({ categoryId: g.id, amount: amt }); }
    });
    const newMB = { ...savingsPrompt.mb, [savingsPrompt.fromMonth]: monthMB };
    const remaining = savingsPrompt.remaining - totalAllocated;
    const allAssignments = [...savingsPrompt.allAssignments];
    const idx = allAssignments.findIndex(a => a.month === savingsPrompt.fromMonth);
    if (newAssignments.length > 0) {
      if (idx >= 0) allAssignments[idx] = { ...allAssignments[idx], assignments: [...allAssignments[idx].assignments, ...newAssignments] };
      else allAssignments.push({ month: savingsPrompt.fromMonth, assignments: newAssignments });
    }
    if (totalAllocated > 0) {
      const logEntry = appendMoveLog({
        type: "assign", month: savingsPrompt.fromMonth,
        entries: newAssignments.map(a => ({ from: "rta", to: a.categoryId, amount: a.amount })),
      });
      updateBudget({ monthlyBudgets: newMB, ...logEntry });
    }
    const inflowsNow = savingsPrompt.inflows;
    setSavingsPrompt(null);
    if (remaining > 0 && hasGoalCats) {
      setCascadePrompt({ remaining, mb: newMB, inflows: inflowsNow, fromMonth: savingsPrompt.fromMonth, allAssignments });
    } else {
      setRecapData(buildRecap(allAssignments));
    }
  };

  const skipSavingsFund = () => {
    const { remaining, mb, inflows, fromMonth, allAssignments } = savingsPrompt;
    setSavingsPrompt(null);
    if (remaining > 0 && hasGoalCats) {
      setCascadePrompt({ remaining, mb, inflows, fromMonth, allAssignments });
    } else {
      setRecapData(buildRecap(allAssignments));
    }
  };

  // ── Cascade actions ──
  const cascadeStop = () => { setRecapData(buildRecap(cascadePrompt.allAssignments)); setCascadePrompt(null); };

  const cascadeNextMonth = () => {
    const nextM = nextKey(cascadePrompt.fromMonth);
    const result = computeMonthAssignments(nextM, cascadePrompt.mb, cascadePrompt.inflows);
    // Show preview modal for this cascade month — user can edit amounts before committing
    const amounts = {};
    result.assignments.forEach(a => { amounts[a.categoryId] = a.amount; });
    const savedCascade = { ...cascadePrompt };
    setCascadePrompt(null);
    setAutoAssignPreview({
      amounts,
      result,
      cascadeContext: { nextM, mb: savedCascade.mb, inflows: savedCascade.inflows, allAssignments: savedCascade.allAssignments },
    });
  };

  const cascadeFundAll = () => {
    let curMB = cascadePrompt.mb, curMonth = cascadePrompt.fromMonth, remaining = cascadePrompt.remaining;
    const curInflows = cascadePrompt.inflows;
    let allAssignments = [...cascadePrompt.allAssignments];
    let iterations = 0;
    while (remaining > 0 && iterations < 24) {
      const nextM = nextKey(curMonth);
      const result = computeMonthAssignments(nextM, curMB, curInflows);
      curMB = result.mb;
      allAssignments.push({ month: nextM, assignments: result.assignments });
      remaining = result.remaining;
      curMonth = nextM;
      iterations++;
      if (result.assignments.length === 0) break;
    }
    updateBudget({
      monthlyBudgets: curMB,
      moneyMoveLog: [
        ...(budget.moneyMoveLog || []),
        ...allAssignments.map(a => ({
          type: "assign", month: a.month, ts: new Date().toISOString(),
          entries: a.assignments.map(e => ({ from: "rta", to: e.categoryId, amount: e.amount })),
        })),
      ].slice(-200),
    });
    setRecapData(buildRecap(allAssignments));
    setCascadePrompt(null);
  };

  // ── Handlers ──
  const [showMoveLog, setShowMoveLog] = useState(false);

  const getCatName = (catId) => {
    if (!catId || catId === "rta") return "Ready to Assign";
    return budget.categories.find(c => c.id === catId)?.name || "Unknown";
  };

  const appendMoveLog = (entry) => {
    const log = [...(budget.moneyMoveLog || []), { ...entry, ts: new Date().toISOString() }];
    return { moneyMoveLog: log.slice(-200) }; // keep last 200 entries
  };

  const moveMoney = (fromCatId, toCatId, amount) => {
    const nMB = { ...(budget.monthlyBudgets[month] || {}) };
    if (fromCatId) nMB[fromCatId] = (nMB[fromCatId] || 0) - amount;
    if (toCatId) nMB[toCatId] = (nMB[toCatId] || 0) + amount;
    updateBudget({
      monthlyBudgets: { ...budget.monthlyBudgets, [month]: nMB },
      ...appendMoveLog({ type: "move", month, entries: [{ from: fromCatId, to: toCatId, amount }] }),
    });
  };

  // Move money for a specific month key (used by cover overspending which may target past months)
  const moveMoneyForMonth = (mk, fromCatId, toCatId, amount, existingMB = null) => {
    const base = existingMB || budget.monthlyBudgets;
    const nMB = { ...(base[mk] || {}) };
    if (fromCatId === "rta") {
      // RTA: just increase the overspent category's budget (pulls from unassigned)
      if (toCatId) nMB[toCatId] = (nMB[toCatId] || 0) + amount;
    } else {
      if (fromCatId) nMB[fromCatId] = (nMB[fromCatId] || 0) - amount;
      if (toCatId) nMB[toCatId] = (nMB[toCatId] || 0) + amount;
    }
    return { ...base, [mk]: nMB };
  };

  // Apply all sources to cover overspending in targetMonth, then check if any
  // future months now have new overspending due to the source reductions.
  const coverOverspending = (targetMonth, overspentCats, sources) => {
    let newMB = { ...budget.monthlyBudgets };
    const logEntries = [];
    sources.forEach(src => {
      overspentCats.forEach(cat => {
        const shortfall = Math.abs(getAvailableSim(cat.id, targetMonth, newMB, budget.inflows));
        if (shortfall < 0.005) return;
        const apply = Math.min(src.amount, shortfall);
        newMB = moveMoneyForMonth(targetMonth, src.id, cat.id, apply, newMB);
        logEntries.push({ from: src.id, to: cat.id, amount: apply });
        src = { ...src, amount: src.amount - apply };
      });
    });
    updateBudget({
      monthlyBudgets: newMB,
      ...appendMoveLog({ type: "cover", month: targetMonth, entries: logEntries }),
    });

    // Current month is fully covered — close and advance to the next overspent month.
    setCoverOverspendModal(null);
    let checkMk = nextKey(targetMonth);
    const todayMk = toKey(new Date());
    for (let i = 0; i < 24; i++) {
      if (checkMk > todayMk) break;
      const isNowOverspent = budget.categories.some(c =>
        !c.archived && !c.creditCardId &&
        getAvailableSim(c.id, checkMk, newMB, budget.inflows) < -0.005
      );
      if (isNowOverspent) {
        const cascadeMk = checkMk;
        const wasAlreadyOverspent = budget.categories.some(c =>
          !c.archived && !c.creditCardId &&
          getAvailableSim(c.id, cascadeMk, budget.monthlyBudgets, budget.inflows) < -0.005
        );
        setTimeout(() => {
          setMonth(cascadeMk);
          setCoverOverspendModal({
            targetMonth: cascadeMk,
            ...(!wasAlreadyOverspent ? {
              cascadeNote: `Covering overspending in ${keyLabel(targetMonth)} created overspending in ${keyLabel(cascadeMk)}. Please cover it below.`,
            } : {}),
          });
        }, 100);
        break;
      }
      checkMk = nextKey(checkMk);
    }
  };
  const setBudgetAmt = (catId, val) => {
    const prev = budgetsNow[catId] || 0;
    const delta = val - prev;
    const newMB = { ...budget.monthlyBudgets, [month]: { ...budgetsNow, [catId]: val } };
    const logEntry = delta !== 0 ? appendMoveLog({
      type: "assign",
      month,
      entries: [{ from: delta < 0 ? catId : "rta", to: delta < 0 ? "rta" : catId, amount: Math.abs(delta) }],
    }) : {};
    updateBudget({ monthlyBudgets: newMB, ...logEntry });
  };

  // Validate an assignment against the global "Truly Free" pool; if it would overdraw,
  // offer to claw back from future months (furthest first, lowest-priority categories first).
  // Each candidate reduction is tested by actually recomputing Truly Free with the real
  // RTA formula — this correctly handles Roll Over / Return / Max rollover types without
  // needing to hand-derive how each one propagates forward.
  const attemptSetBudgetAmt = (catId, newVal) => {
    const oldVal = budgetsNow[catId] || 0;
    const delta = newVal - oldVal;
    if (delta <= 1e-6 || delta <= globalFree + 1e-6) { setBudgetAmt(catId, newVal); return; }

    const shortfall = delta - globalFree;
    let remaining = shortfall;
    const plan = [];
    const workingMB = JSON.parse(JSON.stringify(budget.monthlyBudgets));
    let currentFree = globalFree;

    let mk = furthestMonth;
    while (mk > month && remaining > 1e-6) {
      const cats = budget.categories.filter(c => !c.archived && ((workingMB[mk] || {})[c.id] || 0) > 1e-6).sort(unassignComparator);
      for (const c of cats) {
        if (remaining <= 1e-6) break;
        const maxAmount = workingMB[mk][c.id];
        const take = Math.min(maxAmount, remaining);
        const before = workingMB[mk][c.id];
        workingMB[mk][c.id] = before - take;
        const newFree = getToAssignSim(furthestMonth, workingMB, budget.inflows);
        const gain = newFree - currentFree;
        if (gain <= 1e-6) {
          workingMB[mk][c.id] = before; // no benefit (e.g. Return/Max rollover in an earlier month) — revert
          continue;
        }
        plan.push({ month: mk, categoryId: c.id, categoryName: c.name, amount: take });
        currentFree = newFree;
        remaining -= gain;
      }
      mk = prevKey(mk);
    }

    if (remaining > 1e-6) {
      setClawbackPrompt({ insufficient: true, shortfall, available: shortfall - remaining });
    } else {
      const catName = budget.categories.find(c => c.id === catId)?.name || "this category";
      setClawbackPrompt({ insufficient: false, shortfall, plan, catId, newVal, catName });
    }
  };

  // Trigger the clawback flow to cover remaining overspending using future months
  const confirmClawback = () => {
    const newMB = JSON.parse(JSON.stringify(budget.monthlyBudgets));
    const logEntries = [];

    if (clawbackPrompt.coverMode) {
      // Dead path — kept defensively in case of stale state
    } else {
      // Normal mode: freed money goes to one specific category in current month
      clawbackPrompt.plan.forEach(({ month: mk, categoryId, amount }) => {
        newMB[mk] = newMB[mk] || {};
        newMB[mk][categoryId] = (newMB[mk][categoryId] || 0) - amount;
        // Two-step log: category → RTA in future month
        logEntries.push({ type: "move", month: mk, entries: [{ from: categoryId, to: "rta", amount }] });
      });
      // RTA → target category in current month
      newMB[month] = { ...(newMB[month] || {}), [clawbackPrompt.catId]: clawbackPrompt.newVal };
      logEntries.push({ type: "assign", month, entries: [{ from: "rta", to: clawbackPrompt.catId, amount: clawbackPrompt.shortfall }] });
    }

    const logUpdates = logEntries.length > 0 ? { moneyMoveLog: [...(budget.moneyMoveLog || []), ...logEntries.map(e => ({ ...e, ts: new Date().toISOString() }))].slice(-200) } : {};
    updateBudget({ monthlyBudgets: newMB, ...logUpdates });
    setClawbackPrompt(null);
  };
  const updateCategory = (updated) => updateBudget({ categories: budget.categories.map(c => c.id === updated.id ? updated : c) });

  // ── Name de-duplication helpers ──
  const nameExists = (name, excludeId) => budget.categories.some(c => c.id !== excludeId && c.name.toLowerCase() === name.trim().toLowerCase());
  const getUniqueName = (base, excludeId) => {
    if (!nameExists(base, excludeId)) return base;
    let i = 2;
    while (nameExists(`${base} (${i})`, excludeId)) i++;
    return `${base} (${i})`;
  };
  const groupNameExists = (name, excludeId) => budget.categoryGroups.some(g => g.id !== excludeId && g.name.toLowerCase() === name.trim().toLowerCase());
  const getUniqueGroupName = (base, excludeId) => {
    if (!groupNameExists(base, excludeId)) return base;
    let i = 2;
    while (groupNameExists(`${base} (${i})`, excludeId)) i++;
    return `${base} (${i})`;
  };
  const accountNameExists = (name, excludeId) => budget.accounts.some(a => a.id !== excludeId && a.name.toLowerCase() === name.trim().toLowerCase());
  const ccNameExists = (name, excludeId) => budget.creditCards.some(c => c.id !== excludeId && c.name.toLowerCase() === name.trim().toLowerCase());
  const todayStamp = () => { const d = new Date(); return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`; };
  const ARCHIVE_PREFIX_RE = /^\(\d{8}\) /;

  // Ensure a "Uncategorized" group exists; returns its id and any new groups list to merge in
  const ensureUncategorizedGroup = (groups) => {
    let g = groups.find(grp => grp.name === "Uncategorized");
    if (g) return { id: g.id, groups };
    g = { id: uid(), name: "Uncategorized" };
    return { id: g.id, groups: [...groups, g] };
  };

  const archiveCategory = (cat) => {
    if (!cat.archived) {
      // Archiving: tag with today's date, move to Uncategorized, remember origin group,
      // and return its currently-Available balance (not its whole history) to Ready to Assign.
      const { id: ucgId, groups } = ensureUncategorizedGroup(budget.categoryGroups);
      const baseName = `(${todayStamp()}) ${cat.name}`;
      const newName = getUniqueName(baseName, cat.id);
      const avail = getAvailableFast(cat.id, month);
      const newMB = JSON.parse(JSON.stringify(budget.monthlyBudgets));
      if (avail > 0.001) {
        newMB[month] = newMB[month] || {};
        newMB[month][cat.id] = (newMB[month][cat.id] || 0) - avail;
      }
      updateBudget({
        categoryGroups: groups,
        categories: budget.categories.map(c => c.id === cat.id ? { ...c, archived: true, name: newName, previousGroupId: cat.groupId, groupId: ucgId } : c),
        monthlyBudgets: newMB,
      });
    } else {
      // Restoring: strip the date prefix and return to its previous group (if it still exists)
      const stripped = cat.name.replace(ARCHIVE_PREFIX_RE, "");
      const newName = getUniqueName(stripped, cat.id);
      const targetGroupId = budget.categoryGroups.some(g => g.id === cat.previousGroupId) ? cat.previousGroupId : cat.groupId;
      updateBudget({ categories: budget.categories.map(c => c.id === cat.id ? { ...c, archived: false, name: newName, groupId: targetGroupId } : c) });
    }
  };

  const catHasTransactions = (catId) => budget.transactions.some(tx => tx.categoryId === catId || (tx.splits && tx.splits.some(sp => sp.categoryId === catId)));

  const deleteCategory = (cat) => {
    if (catHasTransactions(cat.id)) return;
    // Any money assigned to this category across any month returns to Ready to Assign
    const newMB = JSON.parse(JSON.stringify(budget.monthlyBudgets));
    Object.keys(newMB).forEach(mk => { delete newMB[mk][cat.id]; });
    updateBudget({ categories: budget.categories.filter(c => c.id !== cat.id), monthlyBudgets: newMB });
  };

  const addCategory = (newCat) => updateBudget({ categories: [...budget.categories, newCat] });
  const addGroup = (newGroup) => updateBudget({ categoryGroups: [...budget.categoryGroups, newGroup] });
  const updateGroup = (updated) => updateBudget({ categoryGroups: budget.categoryGroups.map(g => g.id === updated.id ? updated : g) });

  // Deleting a group is always allowed; its categories (archived or not) move to Uncategorized.
  const deleteGroup = (groupId) => {
    const { id: ucgId, groups } = ensureUncategorizedGroup(budget.categoryGroups);
    if (groupId === ucgId) return; // can't delete Uncategorized itself
    updateBudget({
      categoryGroups: groups.filter(g => g.id !== groupId),
      categories: budget.categories.map(c => c.groupId === groupId ? { ...c, groupId: ucgId, previousGroupId: c.groupId } : c),
    });
  };

  const findCCPaymentCatId = (cardId) => budget.categories.find(c => c.creditCardId === cardId)?.id;

  // Compute new pendingDuplicates to merge into the same updateBudget call as the transaction.
  // Must be called BEFORE updateBudget so we read the correct budget.pendingDuplicates snapshot.
  const buildFuzzyDupUpdates = (newTx, existingTxsBeforeAdd) => {
    const pairs = findFuzzyDuplicates(newTx, existingTxsBeforeAdd);
    if (pairs.length === 0) return {};
    const already = budget.pendingDuplicates || [];
    const deduped = pairs.filter(p =>
      !already.some(e => e.newTxId === p.newTxId && e.existingTxId === p.existingTxId)
    );
    if (deduped.length === 0) return {};
    return { pendingDuplicates: [...already, ...deduped] };
  };

  const addTx = () => {
    const isPaymentTx = isPayFromValue(txForm.categoryId) || budget.categories.some(c => c.id === txForm.categoryId && c.creditCardId);
    if (!txForm.accountId || (!isPaymentTx && !txForm.payee) || !txForm.amount) return;
    const isCardAccount = budget.creditCards.some(c => c.id === txForm.accountId);
    const isBankAccount = budget.accounts.some(a => a.id === txForm.accountId);
    const typedPayee = (txForm.payee || "").trim();
    const originalPayee = typedPayee ? toTitleCase(typedPayee) : "";
    const newTxId = uid();
    const existingTxs = budget.transactions; // snapshot before add

    // Income: RTA selected
    if (txForm.categoryId === "__rta__") {
      const tx = { id: newTxId, date: txForm.date, payee: originalPayee, originalPayee, note: txForm.note.trim(), type: "income", accountId: txForm.accountId, categoryId: null, amount: txForm.amount };
      const updates = { transactions: [...existingTxs, tx] };
      if (!isCardAccount) {
        const txMonth = txForm.date.slice(0, 7);
        updates.inflows = { ...budget.inflows, [txMonth]: (budget.inflows[txMonth] || 0) + txForm.amount };
      }
      updates.payees = ensurePayeeRecord(budget.payees || [], originalPayee, "");
      updateBudget({ ...updates, ...buildFuzzyDupUpdates(tx, existingTxs) });

    // CC account + "Payment from [X]" virtual category → CC-side payment
    } else if (isCardAccount && isPayFromValue(txForm.categoryId)) {
      const fromAccountId = getPayFromAccountId(txForm.categoryId);
      if (!fromAccountId) return;
      const payeeName = originalPayee || "Payment";
      const newTx = { id: newTxId, date: txForm.date, payee: payeeName, originalPayee: payeeName, note: txForm.note.trim(), type: "payment", accountId: txForm.accountId, amount: txForm.amount, paymentLinkStatus: "broken", paymentFromAccountId: fromAccountId };
      const scanned = runPaymentMatchScan([...existingTxs, newTx], budget.creditCards, budget.accounts);
      updateBudget({ transactions: scanned, ...buildFuzzyDupUpdates(newTx, existingTxs) });

    // Bank account + CC payment category → bank-side payment
    } else if (isBankAccount && txForm.categoryId) {
      const ccPayCat = budget.categories.find(c => c.id === txForm.categoryId && c.creditCardId);
      if (ccPayCat) {
        const payeeName = originalPayee || `${budget.creditCards.find(c => c.id === ccPayCat.creditCardId)?.name || "Card"} Payment`;
        const newTx = { id: newTxId, date: txForm.date, payee: payeeName, originalPayee: payeeName, note: txForm.note.trim(), type: "payment", accountId: txForm.accountId, categoryId: txForm.categoryId, amount: txForm.amount, paymentLinkStatus: "broken" };
        const scanned = runPaymentMatchScan([...existingTxs, newTx], budget.creditCards, budget.accounts);
        updateBudget({ transactions: scanned, ...buildFuzzyDupUpdates(newTx, existingTxs) });
        setTxForm(blankTxForm()); setModal(null); return;
      }
      // Normal bank expense (fall through)
      const splits = txForm.splits && txForm.splits.length > 0 ? txForm.splits : null;
      const rawTotal = Number(txForm.amount) || 0;
      const total = txForm.isRefund ? -Math.abs(rawTotal) : Math.abs(rawTotal);
      const processedSplits = splits ? splits.map(sp => ({ ...sp, amount: txForm.isRefund ? -Math.abs(sp.amount) : Math.abs(sp.amount) })) : null;
      const displayedPayee = getDisplayName(originalPayee);
      const isSuggestedCat = !splits && txForm.categoryId && !getPayeeDefaultCategory(displayedPayee) && !getPayeeSuggestedCategory(displayedPayee);
      const tx = { id: newTxId, date: txForm.date, payee: originalPayee, originalPayee, note: txForm.note.trim(), type: "expense", accountId: txForm.accountId, amount: total, ...(processedSplits ? { splits: processedSplits } : { categoryId: txForm.categoryId, categoryConfirmed: true }) };
      updateBudget({ transactions: [...existingTxs, tx], payees: ensurePayeeRecord(budget.payees || [], originalPayee, "", isSuggestedCat ? txForm.categoryId : ""), ...buildFuzzyDupUpdates(tx, existingTxs) });

    // Regular expense (CC or bank, normal category or no category)
    } else {
      const splits = txForm.splits && txForm.splits.length > 0 ? txForm.splits : null;
      const rawTotal = Number(txForm.amount) || 0;
      const total = txForm.isRefund ? -Math.abs(rawTotal) : Math.abs(rawTotal);
      const processedSplits = splits ? splits.map(sp => ({ ...sp, amount: txForm.isRefund ? -Math.abs(sp.amount) : Math.abs(sp.amount) })) : null;
      const displayedPayee = getDisplayName(originalPayee);
      const isSuggestedCat = !splits && txForm.categoryId && !getPayeeDefaultCategory(displayedPayee) && !getPayeeSuggestedCategory(displayedPayee);
      const tx = { id: newTxId, date: txForm.date, payee: originalPayee, originalPayee, note: txForm.note.trim(), type: "expense", accountId: txForm.accountId, amount: total, ...(processedSplits ? { splits: processedSplits } : { ...(txForm.categoryId ? { categoryId: txForm.categoryId, categoryConfirmed: true } : {}) }) };
      const updates = { transactions: [...existingTxs, tx] };
      if (isCardAccount) {
        const ccPayCatId = findCCPaymentCatId(txForm.accountId);
        if (ccPayCatId) {
          const txMonth = txForm.date.slice(0, 7);
          const monthMB = { ...(budget.monthlyBudgets[txMonth] || {}) };
          monthMB[ccPayCatId] = (monthMB[ccPayCatId] || 0) + total; // signed: refunds reduce payment budget
          updates.monthlyBudgets = { ...budget.monthlyBudgets, [txMonth]: monthMB };
        }
      }
      updates.payees = ensurePayeeRecord(budget.payees || [], originalPayee, "", isSuggestedCat ? txForm.categoryId : "");
      updateBudget({ ...updates, ...buildFuzzyDupUpdates(tx, existingTxs) });
    }
    setTxForm(blankTxForm());
    setModal(null);
  };

  const deleteTx = (tx) => {
    if (isLocked(tx)) return; // locked by reconciliation — cannot delete

    // Transfers are atomic: deleting one side deletes its linked partner too.
    let idsToRemove = [tx.id];
    if (tx.type === "transfer" && tx.transferLinkId) {
      const partner = budget.transactions.find(t => t.transferLinkId === tx.transferLinkId && t.id !== tx.id);
      if (partner) idsToRemove.push(partner.id);
    }

    let newTransactions = budget.transactions.filter(t => !idsToRemove.includes(t.id));

    // Linked payments: deleting one side leaves the partner unmatched → mark it broken.
    if (tx.type === "payment" && tx.paymentLinkStatus === "linked" && tx.paymentLinkId) {
      newTransactions = newTransactions.map(t =>
        t.id === tx.paymentLinkId ? { ...t, paymentLinkStatus: "broken" } : t
      );
    }

    const updates = { transactions: newTransactions };

    // Reverse the automatic CC Payment-category bump created by a card expense
    if (tx.type === "expense" && budget.creditCards.some(c => c.id === tx.accountId)) {
      const ccPayCatId = findCCPaymentCatId(tx.accountId);
      if (ccPayCatId) {
        const txMonth = tx.date.slice(0, 7);
        const monthMB = { ...(budget.monthlyBudgets[txMonth] || {}) };
        monthMB[ccPayCatId] = (monthMB[ccPayCatId] || 0) - Number(tx.amount);
        updates.monthlyBudgets = { ...budget.monthlyBudgets, [txMonth]: monthMB };
      }
    }
    // Reverse an income's contribution to that month's inflow
    if (tx.type === "income" && !budget.creditCards.some(c => c.id === tx.accountId)) {
      const txMonth = tx.date.slice(0, 7);
      updates.inflows = { ...budget.inflows, [txMonth]: (budget.inflows[txMonth] || 0) - Number(tx.amount) };
    }
    // Reverse an adjustment's contribution to that month's inflow (cash/bank accounts only)
    if (tx.type === "adjustment" && budget.accounts.some(a => a.id === tx.accountId)) {
      const txMonth = tx.date.slice(0, 7);
      updates.inflows = { ...budget.inflows, [txMonth]: (budget.inflows[txMonth] || 0) - Number(tx.amount) };
    }
    updates.payees = prunePayees(budget.payees || [], updates.transactions);
    updateBudget(updates);
  };

  // Edit a transaction's category, note, and/or amount — allowed even when locked
  // (locking only blocks deletion).
  const editTx = (txId, updates) => updateBudget({ transactions: budget.transactions.map(t => t.id === txId ? { ...t, ...updates } : t) });

  // ── Bulk transaction operations ──
  const bulkConfirm = () => {
    const ids = [...selectedTxIds];
    updateBudget({ transactions: budget.transactions.map(t =>
      ids.includes(t.id) && t.type === "expense" && !t.splits && t.categoryConfirmed === false && t.categoryId && !isLocked(t)
        ? { ...t, categoryConfirmed: true }
        : t
    )});
    exitSelection();
  };

  const bulkDelete = () => {
    const ids = [...selectedTxIds];
    let txList = budget.transactions;
    const toDelete = txList.filter(t => ids.includes(t.id) && !isLocked(t));
    let idsToRemove = [];
    const updates = {};
    let mbUpdates = { ...budget.monthlyBudgets };
    let inflowUpdates = { ...budget.inflows };

    toDelete.forEach(tx => {
      idsToRemove.push(tx.id);
      // Delete transfer partner
      if (tx.type === "transfer" && tx.transferLinkId) {
        const partner = txList.find(t => t.transferLinkId === tx.transferLinkId && t.id !== tx.id);
        if (partner && !isLocked(partner)) idsToRemove.push(partner.id);
      }
      // Reverse CC payment category bump for card expenses
      if (tx.type === "expense" && budget.creditCards.some(c => c.id === tx.accountId)) {
        const ccPayCatId = findCCPaymentCatId(tx.accountId);
        if (ccPayCatId) {
          const mk = tx.date.slice(0, 7);
          mbUpdates = { ...mbUpdates, [mk]: { ...(mbUpdates[mk] || {}), [ccPayCatId]: ((mbUpdates[mk] || {})[ccPayCatId] || 0) - Number(tx.amount) } };
        }
      }
      // Reverse income inflows
      if (tx.type === "income" && budget.accounts.some(a => a.id === tx.accountId)) {
        const mk = tx.date.slice(0, 7);
        inflowUpdates = { ...inflowUpdates, [mk]: (inflowUpdates[mk] || 0) - Number(tx.amount) };
      }
    });

    // Mark linked payment partners as broken
    const uniqueIds = [...new Set(idsToRemove)];
    let newTxList = txList.filter(t => !uniqueIds.includes(t.id));
    newTxList = newTxList.map(t => {
      if (t.type === "payment" && t.paymentLinkStatus === "linked" && uniqueIds.includes(t.paymentLinkId))
        return { ...t, paymentLinkStatus: "broken" };
      return t;
    });

    updates.transactions = newTxList;
    updates.monthlyBudgets = mbUpdates;
    updates.inflows = inflowUpdates;
    updates.payees = prunePayees(budget.payees || [], newTxList);
    updateBudget(updates);
    setBulkDeleteConfirm(false);
    exitSelection();
  };

  const bulkCategorize = (categoryId) => {
    const ids = [...selectedTxIds];
    let mbUpdates = { ...budget.monthlyBudgets };
    let newTxList = [...budget.transactions];
    const isCCPayCat = budget.categories.some(c => c.id === categoryId && c.creditCardId);
    const isPayFrom = isPayFromValue(categoryId);

    // First pass: apply the category change to each selected transaction
    newTxList = newTxList.map(t => {
      if (!ids.includes(t.id) || isLocked(t)) return t;
      const isBankAcct = budget.accounts.some(a => a.id === t.accountId);
      const isCardAcct = budget.creditCards.some(c => c.id === t.accountId);

      // Card account + "Payment from [X]" → convert to CC-side payment
      if (isCardAcct && isPayFrom) {
        const fromAccountId = getPayFromAccountId(categoryId);
        return { ...t, type: "payment", categoryId: undefined, categoryConfirmed: undefined, paymentLinkStatus: "broken", paymentFromAccountId: fromAccountId, splits: undefined };
      }
      // Bank account + CC payment category → convert to bank-side payment
      if (isBankAcct && isCCPayCat) {
        return { ...t, type: "payment", categoryId, categoryConfirmed: undefined, paymentLinkStatus: "broken", splits: undefined };
      }
      // Card account expense: reverse old CC bump, apply new (amount unchanged)
      if (isCardAcct && (t.type === "expense" || t.type === "income")) {
        const ccPayCatId = findCCPaymentCatId(t.accountId);
        if (ccPayCatId && t.type === "expense") {
          const mk = t.date.slice(0, 7);
          // Old bump already in monthlyBudgets; category reassignment doesn't change the amount
          // so CC payment budget is unaffected — no adjustment needed
        }
      }
      // Standard category assignment — remove splits if present
      const updated = { ...t, categoryId, categoryConfirmed: true };
      if (updated.splits) delete updated.splits;
      return updated;
    });

    // Second pass: run payment match scan if any transactions became payments
    const hasNewPayments = ids.some(id => {
      const orig = budget.transactions.find(t => t.id === id);
      const updated = newTxList.find(t => t.id === id);
      return orig?.type !== "payment" && updated?.type === "payment";
    });
    if (hasNewPayments) {
      newTxList = runPaymentMatchScan(newTxList, budget.creditCards, budget.accounts);
    }

    updateBudget({ transactions: newTxList, monthlyBudgets: mbUpdates });
    setBulkCatModal(false);
    exitSelection();
  };
  // Records an account/card as reconciled as of `date`, optionally creating an adjustment
  // transaction to close a difference between the computed and real-world balance.
  // If `txIdsToLock` is provided (mismatch path), those specific transactions are marked
  // tx.reconciled=true rather than relying solely on date-based locking.
  const reconcileAccount = (accId, date, diff, txIdsToLock = null) => {
    const isCard = budget.creditCards.some(c => c.id === accId);
    const updates = {};
    let txList = budget.transactions;
    let mbChanged = null; // holds monthlyBudgets when a card adjustment bumps the payment category

    // Helper: apply the balance-adjustment side-effects (shared by both paths)
    const applyAdjustment = () => {
      if (Math.abs(diff) <= 0.001) return;
      const tx = { id: uid(), date, payee: "Balance Adjustment", originalPayee: "Balance Adjustment", note: "", type: "adjustment", accountId: accId, categoryId: null, amount: diff, reconciled: true };
      txList = [...txList, tx];
      if (!isCard) {
        // Bank: the surplus/shortfall flows to/from RTA via inflows
        const txMonth = date.slice(0, 7);
        updates.inflows = { ...budget.inflows, [txMonth]: (budget.inflows[txMonth] || 0) + diff };
      } else {
        // Card: more/less debt means more/less must be set aside in the payment category.
        // Bumping the payment-category budget by diff automatically pulls from (or returns to)
        // RTA via the budgeted-total relationship — no inflow change needed.
        const ccPayCatId = findCCPaymentCatId(accId);
        if (ccPayCatId) {
          const txMonth = date.slice(0, 7);
          const monthMB = { ...((mbChanged || budget.monthlyBudgets)[txMonth] || {}) };
          monthMB[ccPayCatId] = (monthMB[ccPayCatId] || 0) + diff;
          mbChanged = { ...(mbChanged || budget.monthlyBudgets), [txMonth]: monthMB };
        }
      }
    };

    if (txIdsToLock) {
      // Mismatch path: lock only the specified transactions by ID flag.
      // Use lastReconciledDisplay (display only) rather than reconciledDate so that
      // transactions the user deliberately UNCHECKED are not locked by the date rule.
      txList = txList.map(tx => txIdsToLock.includes(tx.id) ? { ...tx, reconciled: true } : tx);
      applyAdjustment();
      updates.transactions = txList;
      if (mbChanged) updates.monthlyBudgets = mbChanged;
      if (isCard) updates.creditCards = budget.creditCards.map(c => c.id === accId ? { ...c, lastReconciledDisplay: date } : c);
      else updates.accounts = budget.accounts.map(a => a.id === accId ? { ...a, lastReconciledDisplay: date } : a);
    } else {
      // Match path: date-based locking, set reconciledDate.
      applyAdjustment();
      updates.transactions = txList;
      if (mbChanged) updates.monthlyBudgets = mbChanged;
      if (isCard) updates.creditCards = budget.creditCards.map(c => c.id === accId ? { ...c, reconciledDate: date } : c);
      else updates.accounts = budget.accounts.map(a => a.id === accId ? { ...a, reconciledDate: date } : a);
    }
    updateBudget(updates);
  };

  // ── Account/Card management ──
  const accountHasTransactions = (accId) => budget.transactions.some(tx => tx.accountId === accId);
  // ── Archive / Delete account interceptor ──
  const requestAccountAction = (id, isCard, action, skipReconcileGate = false) => {
    const acct = isCard ? budget.creditCards.find(c => c.id === id) : budget.accounts.find(a => a.id === id);
    if (!acct) return;

    // ── Gate 1: Uncategorized or unconfirmed transactions ──
    const uncatTxs = budget.transactions.filter(tx =>
      tx.accountId === id &&
      tx.type === "expense" && !tx.splits && (
        !tx.categoryId ||
        tx.categoryConfirmed === false
      )
    );
    if (uncatTxs.length > 0) {
      setPendingAccountAction({
        id, isCard, action, name: acct.name, balance: 0,
        blockedByUncat: true, uncatCount: uncatTxs.length,
      });
      return;
    }

    // ── Gate 2 (archive only): Unreconciled transactions ──
    // skipReconcileGate=true after reconciliation completes to avoid async state loop
    if (action === "archive" && !skipReconcileGate) {
      const unreconciledTxs = budget.transactions.filter(tx =>
        tx.accountId === id && !tx.reconciled
      );
      if (unreconciledTxs.length > 0) {
        setPendingReconcile({
          id, name: acct.name, isCard,
          onComplete: (reconciledUpdates) => {
            // Reconcile committed — now continue through remaining gates using
            // the already-computed reconciledUpdates (don't re-read stale budget state)
            const mergedBudget = { ...budget, ...reconciledUpdates };
            const balance2 = isCard ? getCardBalance(id) : getAccountBalance(id);

            // Gate 3: CC balance check
            if (isCard) {
              if (balance2 <= 0.005) {
                // Merge archive into the same update
                const today2 = new Date();
                const stamp2 = `${today2.getFullYear()}${String(today2.getMonth()+1).padStart(2,"0")}${String(today2.getDate()).padStart(2,"0")}`;
                const baseName2 = `(${stamp2}) ${acct.name}`;
                let archName = baseName2; let ai = 2;
                while (mergedBudget.creditCards.some(c => c.id !== id && c.name.toLowerCase() === archName.toLowerCase())) { archName = `${baseName2} (${ai})`; ai++; }
                updateBudget({ ...reconciledUpdates, creditCards: mergedBudget.creditCards.map(c => c.id === id ? { ...c, archived: true, name: archName } : c) });
                setPendingReconcile(null);
                return;
              }
              const ccPayCatId2 = findCCPaymentCatId(id);
              const setAside2 = ccPayCatId2 ? getAvailableFast(ccPayCatId2, todayMonthStr) : 0;
              if (setAside2 < balance2 - 0.005) {
                const shortfall2 = balance2 - Math.max(0, setAside2);
                updateBudget(reconciledUpdates);
                setPendingAccountAction({ id, isCard, action, name: acct.name, balance: balance2, setAside: Math.max(0, setAside2), shortfall: shortfall2, blocked: true });
                setPendingReconcile(null);
                return;
              }
            }

            // Gate 4: bank balance check — merge archive with reconcile if zero balance
            const absBalance2 = Math.abs(balance2);
            if (!isCard && absBalance2 < 0.005) {
              // Zero balance — archive atomically with reconcile
              const today2 = new Date();
              const stamp2 = `${today2.getFullYear()}${String(today2.getMonth()+1).padStart(2,"0")}${String(today2.getDate()).padStart(2,"0")}`;
              const baseName2 = `(${stamp2}) ${acct.name}`;
              let archName = baseName2; let ai = 2;
              while (mergedBudget.accounts.some(a => a.id !== id && a.name.toLowerCase() === archName.toLowerCase())) { archName = `${baseName2} (${ai})`; ai++; }
              updateBudget({ ...reconciledUpdates, accounts: mergedBudget.accounts.map(a => a.id === id ? { ...a, archived: true, name: archName } : a) });
            } else {
              // Non-zero balance — commit reconcile first, then show resolution modal
              updateBudget(reconciledUpdates);
              setPendingAccountAction({ id, isCard, action, name: acct.name, balance: balance2 });
            }
            setPendingReconcile(null);
          },
        });
        return;
      }
    }

    // ── Gate 3: CC balance vs payment category ──
    const balance = isCard ? getCardBalance(id) : getAccountBalance(id);
    if (isCard) {
      if (balance <= 0.005) {
        archiveAccount(id, isCard);
        return;
      }
      const ccPayCatId = findCCPaymentCatId(id);
      const setAside = ccPayCatId ? getAvailableFast(ccPayCatId, todayMonthStr) : 0;
      if (setAside >= balance - 0.005) {
        archiveAccount(id, isCard);
        return;
      }
      const shortfall = balance - Math.max(0, setAside);
      setPendingAccountAction({ id, isCard, action, name: acct.name, balance, setAside: Math.max(0, setAside), shortfall, blocked: true });
      return;
    }

    // ── Gate 4: Bank account balance ──
    if (Math.abs(balance) < 0.005) {
      if (action === "archive") archiveAccount(id, isCard);
      else deleteAccount(id, isCard);
      return;
    }
    setPendingAccountAction({ id, isCard, action, name: acct.name, balance });
  };

  const archiveAccount = (id, isCard) => {
    const today = new Date();
    const stamp = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, "0")}${String(today.getDate()).padStart(2, "0")}`;
    const ACC_ARCHIVE_RE = /^\(\d{8}\) /;
    if (isCard) {
      const cc = budget.creditCards.find(c => c.id === id);
      if (!cc) return;
      if (!cc.archived) {
        const baseName = `(${stamp}) ${cc.name}`;
        let name = baseName;
        let i = 2;
        while (budget.creditCards.some(c => c.id !== id && c.name.toLowerCase() === name.toLowerCase())) { name = `${baseName} (${i})`; i++; }
        updateBudget({ creditCards: budget.creditCards.map(c => c.id === id ? { ...c, archived: true, name } : c) });
      } else {
        const stripped = cc.name.replace(ACC_ARCHIVE_RE, "");
        let name = stripped;
        let i = 2;
        while (budget.creditCards.some(c => c.id !== id && c.name.toLowerCase() === name.toLowerCase())) { name = `${stripped} (${i})`; i++; }
        updateBudget({ creditCards: budget.creditCards.map(c => c.id === id ? { ...c, archived: false, name } : c) });
      }
    } else {
      const acc = budget.accounts.find(a => a.id === id);
      if (!acc) return;
      if (!acc.archived) {
        const baseName = `(${stamp}) ${acc.name}`;
        let name = baseName;
        let i = 2;
        while (budget.accounts.some(a => a.id !== id && a.name.toLowerCase() === name.toLowerCase())) { name = `${baseName} (${i})`; i++; }
        updateBudget({ accounts: budget.accounts.map(a => a.id === id ? { ...a, archived: true, name } : a) });
      } else {
        const stripped = acc.name.replace(ACC_ARCHIVE_RE, "");
        let name = stripped;
        let i = 2;
        while (budget.accounts.some(a => a.id !== id && a.name.toLowerCase() === name.toLowerCase())) { name = `${stripped} (${i})`; i++; }
        updateBudget({ accounts: budget.accounts.map(a => a.id === id ? { ...a, archived: false, name } : a) });
      }
    }
  };
  const deleteAccount = (id, isCard) => {
    if (accountHasTransactions(id)) return;
    if (isCard) updateBudget({ creditCards: budget.creditCards.filter(c => c.id !== id), categories: budget.categories.filter(c => c.creditCardId !== id) });
    else updateBudget({ accounts: budget.accounts.filter(a => a.id !== id) });
  };
  const renameAccount = (id, isCard, name) => {
    if (isCard) updateBudget({ creditCards: budget.creditCards.map(c => c.id === id ? { ...c, name } : c) });
    else updateBudget({ accounts: budget.accounts.map(a => a.id === id ? { ...a, name } : a) });
  };

  // Reset every original payee name back to displaying itself (undo all merges/custom names).
  const unmergeAllPayees = () => updateBudget({ payees: prunePayees((budget.payees || []).map(p => ({ ...p, canonicalName: p.name })), budget.transactions) });

  const clearAllPayeeDefaults = () => updateBudget({ payees: (budget.payees || []).map(p => ({ ...p, defaultCategoryId: "", suggestedCategoryId: "" })) });


  // ── Fix open (unassigned-account) transactions ──
  const fixTransaction = (txId, updates) => updateBudget({ transactions: budget.transactions.map(t => t.id === txId ? { ...t, ...updates } : t) });

  // ── CSV Import ──
  // Remember the column mapping used for each account, so future imports for that
  // account can skip straight to a pre-filled (or auto-applied) mapping.
  const saveImportTemplate = (accountId, mapping) => updateBudget({ importTemplates: { ...(budget.importTemplates || {}), [accountId]: mapping } });
  const getImportTemplate = (accountId) => (budget.importTemplates || {})[accountId] || null;

  const importTransactions = (parsedTxs, accountId) => {
    const isCardAccount = budget.creditCards.some(c => c.id === accountId);
    const newTransactions = [...budget.transactions];
    const newMonthlyBudgets = JSON.parse(JSON.stringify(budget.monthlyBudgets));
    let newInflows = { ...budget.inflows };
    let newPayees = [...(budget.payees || [])];
    const ccPayCatId = isCardAccount ? findCCPaymentCatId(accountId) : null;

    parsedTxs.forEach(p => {
      const typedPayeeRaw = (p.payee || "").trim();
      const originalPayee = typedPayeeRaw ? toTitleCase(typedPayeeRaw) : p.payee;
      const existingPayee = newPayees.find(pp => pp.name === originalPayee);
      const hasDefault = !!(existingPayee?.defaultCategoryId);
      const hasSuggested = !!(existingPayee?.suggestedCategoryId);

      const isRTAIncome = p.categoryId === "__rta__";
      const isPayFrom = isPayFromValue(p.categoryId);
      const ccPayCat = !isRTAIncome && !isPayFrom && p.categoryId
        ? budget.categories.find(c => c.id === p.categoryId && c.creditCardId)
        : null;
      const isBankCCPayment = !!(ccPayCat && !isCardAccount);

      const effectiveType = isRTAIncome ? "income"
        : (isPayFrom || isBankCCPayment) ? "payment"
        : "expense";

      let effectiveAmount;
      if (isPayFrom || isBankCCPayment || isRTAIncome) {
        effectiveAmount = Math.abs(p.amount);
      } else if (p.amount > 0) {
        effectiveAmount = -Math.abs(p.amount);
      } else {
        effectiveAmount = Math.abs(p.amount);
      }

      const catId = isRTAIncome ? null
        : isPayFrom ? null
        : isBankCCPayment ? p.categoryId
        : p.categoryId || null;

      const payFromAccountId = isPayFrom ? getPayFromAccountId(p.categoryId) : undefined;

      const tx = {
        id: uid(), date: p.date, payee: originalPayee, originalPayee, note: "", type: effectiveType,
        accountId,
        amount: effectiveAmount,
        ...(catId ? { categoryId: catId } : {}),
        ...((isPayFrom || isBankCCPayment) ? { paymentLinkStatus: "broken" } : {}),
        ...(payFromAccountId ? { paymentFromAccountId: payFromAccountId } : {}),
        ...(effectiveType === "expense" && catId ? { categoryConfirmed: true } : {}),
      };
      newTransactions.push(tx);

      if (isBankCCPayment) {
        // Bank-side payment: no monthlyBudgets bump (category consumed via activityByCat)
      } else if (effectiveType === "expense" && isCardAccount && ccPayCatId) {
        const mk = p.date.slice(0, 7);
        newMonthlyBudgets[mk] = newMonthlyBudgets[mk] || {};
        newMonthlyBudgets[mk][ccPayCatId] = (newMonthlyBudgets[mk][ccPayCatId] || 0) + effectiveAmount;
      } else if (effectiveType === "income" && !isCardAccount) {
        const mk = p.date.slice(0, 7);
        newInflows[mk] = (newInflows[mk] || 0) + effectiveAmount;
      }

      const isSuggestedCat = effectiveType === "expense" && catId && !hasDefault && !hasSuggested;
      if (originalPayee) {
        if (!existingPayee) {
          newPayees.push({ id: uid(), name: originalPayee, defaultCategoryId: "", suggestedCategoryId: isSuggestedCat ? catId : "", canonicalName: originalPayee });
        } else if (isSuggestedCat && !existingPayee.suggestedCategoryId && !existingPayee.defaultCategoryId) {
          newPayees = newPayees.map(pp => pp.name === originalPayee ? { ...pp, suggestedCategoryId: catId } : pp);
        }
      }
    });
    const scannedTransactions = runPaymentMatchScan(newTransactions, budget.creditCards, budget.accounts);
    // Detect fuzzy duplicates between newly imported txs and pre-existing txs
    const preExistingTxs = budget.transactions;
    const newlyAdded = scannedTransactions.filter(t => !preExistingTxs.some(e => e.id === t.id));
    let newPendingDups = [...(budget.pendingDuplicates || [])];
    newlyAdded.forEach(newTx => {
      const pairs = findFuzzyDuplicates(newTx, preExistingTxs);
      pairs.forEach(p => {
        if (!newPendingDups.some(e => e.newTxId === p.newTxId && e.existingTxId === p.existingTxId)) {
          newPendingDups.push(p);
        }
      });
    });
    updateBudget({ transactions: scannedTransactions, monthlyBudgets: newMonthlyBudgets, inflows: newInflows, payees: newPayees, pendingDuplicates: newPendingDups });
  };

  const totalActivity = Object.values(activityByCat).reduce((s, v) => s + v, 0);
  const SHOW_ACTIVITY = !IS_TOUCH; // hide Activity column on mobile
  const BUDGET_COLS = SHOW_ACTIVITY ? "1fr 64px 56px 70px" : "1fr 72px 80px"; // name | budgeted | [activity] | available
  const totalAvailable = budget.categories.reduce((s, c) => s + getAvailableFast(c.id, month), 0);
  const catForSettings = catSettingsId ? budget.categories.find(c => c.id === catSettingsId) : null;
  const groupForEdit = editGroupId ? budget.categoryGroups.find(g => g.id === editGroupId) : null;
  const archivedCats = budget.categories.filter(c => c.archived);

  // Goals that auto-assign could still act on this month (not yet satisfied)
  const openGoalCats = budget.categories.filter(cat => {
    if (!cat.goal?.type || cat.archived) return false;
    const avail = getAvailableFast(cat.id, month);
    const budgeted = budgetsNow[cat.id] || 0;
    const m = getGoalMetrics(cat, avail, budgeted, month);
    if (!m) return false;
    if (m.type === "savings") return !m.complete;
    if (m.type === "monthly") return m.underfunded;
    if (m.type === "date") return !m.onTrack;
    return false;
  });
  const showAutoAssign = globalFree > 0 && openGoalCats.length > 0;

  // Expired by-date goals — categories with goal.type === "date" where targetDate < this month
  const todayMonthStr = toKey(new Date());
  const expiredGoalCats = budget.categories.filter(cat =>
    cat.goal?.type === "date" && cat.goal?.targetDate && cat.goal.targetDate < todayMonthStr && !cat.archived
  );

  // Overspending detection: find past months with negative available categories
  const monthKeysWithBudgetData = Object.keys(budget.monthlyBudgets);
  const monthKeysWithTxData = budget.transactions.map(tx => tx.date.slice(0, 7));
  const allMonthKeys = Array.from(new Set([...monthKeysWithBudgetData, ...monthKeysWithTxData])).sort();
  const pastMonthsWithOverspend = useMemo(() => allMonthKeys.filter(mk => {
    if (mk > todayMonthStr) return false;
    return budget.categories.some(c =>
      !c.archived && !c.creditCardId && getAvailableFast(c.id, mk) < -0.005
    );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [availableMap, budget.categories, todayMonthStr]);
  const oldestPastOverspendMk = pastMonthsWithOverspend[0] || null;

  // ── Notification computations (placed here so oldestPastOverspendMk is available) ──
  const lastReconciledDateFor = (accId) => {
    const acc = budget.accounts.find(a => a.id === accId) || budget.creditCards.find(c => c.id === accId);
    const txDate = budget.transactions
      .filter(tx => tx.reconciled && tx.accountId === accId)
      .map(tx => tx.date).sort().pop();
    const candidates = [acc?.reconciledDate, acc?.lastReconciledDisplay, txDate].filter(Boolean);
    return candidates.length ? candidates.sort().pop() : null;
  };

  const activeNotifications = (() => {
    const notes = [];

    // 1. Merge suggestions
    if (mainSuggestedMergeGroups.length > 0) {
      notes.push({
        id: "merge-suggestions",
        icon: "🔀",
        subject: `${mainSuggestedMergeGroups.length} payee merge suggestion${mainSuggestedMergeGroups.length !== 1 ? "s" : ""}`,
        tag: "Payees",
        body: `${mainSuggestedMergeGroups.length} group${mainSuggestedMergeGroups.length !== 1 ? "s" : ""} of payees look like they might be the same vendor. Merging duplicates keeps your payee list clean and makes reports more accurate.`,
        action: { label: "Review Merge Suggestions", color: C.purple, onClick: openMergeFromNav },
      });
    }

    // 2. Missing or unconfirmed category transactions
    const missingCatList = budget.transactions.filter(tx =>
      !tx.accountId || (tx.type === "expense" && !tx.categoryId && !tx.splits)
    );
    const unconfirmedList = budget.transactions.filter(tx =>
      tx.type === "expense" && tx.categoryId && !tx.splits && tx.categoryConfirmed === false
    );
    const needsAttentionCount = missingCatList.length + unconfirmedList.length;
    if (needsAttentionCount > 0) {
      const missingPart = missingCatList.length > 0 ? `${missingCatList.length} missing a category` : "";
      const unconfirmedPart = unconfirmedList.length > 0 ? `${unconfirmedList.length} with an unconfirmed category` : "";
      const parts = [missingPart, unconfirmedPart].filter(Boolean).join(", ");
      notes.push({
        id: "unconfirmed-transactions",
        icon: "❓",
        subject: `${needsAttentionCount} transaction${needsAttentionCount !== 1 ? "s" : ""} need${needsAttentionCount === 1 ? "s" : ""} attention`,
        tag: "Transactions",
        body: `${parts}. Tap to review — assign categories, confirm suggestions with ✓, or change them with ✕.`,
        action: {
          label: "Review Transactions",
          color: C.gold,
          onClick: () => {
            setTxFilters({ ...blankTxFilters(), categoryId: UNCONFIRMED_FILTER });
            setTxSearch("");
            setShowTxFilters(true);
            setNav("transactions");
          },
        },
      });
    }

    // 3. Overspending
    if (oldestPastOverspendMk) {
      const count = pastMonthsWithOverspend.length;
      notes.push({
        id: "overspending",
        icon: "🔴",
        subject: `Overspending in ${keyLabel(oldestPastOverspendMk)}${count > 1 ? ` (+${count - 1} more month${count - 1 !== 1 ? "s" : ""})` : ""}`,
        tag: "Budget",
        body: `${count > 1 ? `${count} months have` : `${keyLabel(oldestPastOverspendMk)} has`} unresolved overspending. Covering overspending moves funds from other categories to bring the overspent categories back to zero. Start with the oldest month first — after covering it the notification will advance to the next.`,
        action: {
          label: `Cover Overspending in ${keyLabel(oldestPastOverspendMk)}`,
          color: C.red,
          onClick: () => { setNav("budget"); setMonth(oldestPastOverspendMk); setCoverOverspendModal({ targetMonth: oldestPastOverspendMk }); },
        },
      });
    }

    // 4. Unmatched credit card payments
    budget.transactions.filter(tx => tx.type === "payment" && tx.paymentLinkStatus === "broken").forEach(tx => {
      const isCardSide = budget.creditCards.some(c => c.id === tx.accountId);
      const acct = isCardSide
        ? budget.creditCards.find(c => c.id === tx.accountId)
        : budget.accounts.find(a => a.id === tx.accountId);
      const acctName = acct?.name || "Unknown";
      const dateLabel = new Date(tx.date + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" });

      // Figure out what the missing side looks like so we can pre-fill the new tx modal
      let missingAccountId = "";
      let missingCategoryId = "";
      if (isCardSide) {
        // Card has the payment; missing = bank side. Use paymentFromAccountId if set.
        const fromAcct = tx.paymentFromAccountId
          ? budget.accounts.find(a => a.id === tx.paymentFromAccountId)
          : budget.accounts[0];
        missingAccountId = fromAcct?.id || budget.accounts[0]?.id || "";
        // Find the CC payment category for this card in the bank account
        const ccPayCat = budget.categories.find(c => c.creditCardId === tx.accountId);
        missingCategoryId = ccPayCat?.id || "";
      } else {
        // Bank has the payment; missing = card side. categoryId on bank tx points to CC pay cat → find the card.
        const ccPayCat = budget.categories.find(c => c.id === tx.categoryId && c.creditCardId);
        missingAccountId = ccPayCat?.creditCardId || "";
        // On the card side, category uses "Payment from [bankAcctId]" virtual value
        missingCategoryId = makePayFromValue(tx.accountId);
      }

      notes.push({
        id: `broken-payment-${tx.id}`,
        icon: "⛓️‍💥",
        subject: `${fmt(tx.amount)} payment on ${dateLabel} — unmatched`,
        tag: acctName,
        body: isCardSide
          ? `A ${fmt(tx.amount)} payment on ${dateLabel} was recorded on ${acctName} but hasn't been matched to the bank side. Tap to enter the missing bank transaction.`
          : `A ${fmt(tx.amount)} payment on ${dateLabel} from ${acctName} hasn't been matched to the credit card side. Tap to enter the missing card transaction.`,
        action: {
          label: "Enter Missing Transaction",
          color: C.navy,
          onClick: () => {
            setTxForm({
              ...blankTxForm(),
              date: tx.date,
              amount: tx.amount,
              accountId: missingAccountId,
              categoryId: missingCategoryId,
              payee: "",
            });
            setModal("tx");
          },
        },
      });
    });

    // 5. Credit card balance vs payment category mismatch
    budget.creditCards.filter(c => !c.archived).forEach(cc => {
      const ccBalance = getCardBalance(cc.id);
      if (ccBalance <= 0.005) return; // paid off or overpaid — no issue
      const ccPayCatId = findCCPaymentCatId(cc.id);
      if (!ccPayCatId) return;
      const setAside = getAvailableFast(ccPayCatId, todayMonthStr);
      const shortfall = ccBalance - setAside;
      if (shortfall > 0.005) {
        notes.push({
          id: `cc-mismatch-${cc.id}`,
          icon: "💳",
          subject: `${cc.name} payment category is underfunded`,
          tag: "Credit Cards",
          body: `Your ${cc.name} balance is ${fmt(ccBalance)}, but you've only set aside ${fmt(Math.max(0, setAside))} in the payment category — a shortfall of ${fmt(shortfall)}. Budget an additional ${fmt(shortfall)} to the ${cc.name} payment category to cover the full balance.`,
          action: { label: "Go to Budget", color: C.navy, onClick: () => { setNav("budget"); setNotifOpen(false); } },
        });
      }
    });

    // 6. Accounts not reconciled in 30+ days
    [...budget.accounts.filter(a => !a.archived), ...budget.creditCards.filter(c => !c.archived)].forEach(acct => {
      const lastDate = lastReconciledDateFor(acct.id);
      const days = lastDate ? daysSince(lastDate) : null;
      if (days === null || days >= 30) {
        notes.push({
          id: `unrec-${acct.id}`,
          icon: "📋",
          subject: `${acct.name} hasn't been reconciled${days !== null ? ` in ${days} days` : " yet"}`,
          tag: budget.creditCards.some(c => c.id === acct.id) ? "Credit Card" : "Account",
          body: `Regular reconciliation confirms your ClearBudget balances match your actual bank statements and helps catch errors early. ${days !== null ? `${acct.name} was last reconciled ${days} days ago.` : `${acct.name} has never been reconciled.`} Go to the Accounts tab to reconcile.`,
          action: { label: `Reconcile ${acct.name}`, color: C.navy, onClick: () => { setPendingReconcile({ id: acct.id, name: acct.name, isCard: budget.creditCards.some(c => c.id === acct.id) }); setNav("accounts"); setNotifOpen(false); } },
        });
      }
    });

    // 7. Pending fuzzy duplicate transactions
    const pendingDups = (budget.pendingDuplicates || []).filter(p =>
      budget.transactions.some(t => t.id === p.newTxId) &&
      budget.transactions.some(t => t.id === p.existingTxId)
    );
    if (pendingDups.length > 0) {
      notes.push({
        id: "fuzzy-duplicates",
        icon: "⚠️",
        subject: `Potential duplicate transaction${pendingDups.length !== 1 ? "s" : ""} found`,
        tag: "Transactions",
        body: `${pendingDups.length} transaction${pendingDups.length !== 1 ? "s" : ""} may be duplicated — similar amount and date found in the same account. Review each pair and choose which to keep.`,
        action: { label: "Review Duplicates", color: C.gold, onClick: () => setDupReviewOpen(true) },
      });
    }

    return notes;
  })();

  const notifCount = activeNotifications.length;
  // Viewing a future month — any overspending shown there is rolled forward from past/current

  const UndoRedoGroup = () => (
    <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
      <IconBtn onClick={onUndo} disabled={!canUndo}>↩</IconBtn>
      <IconBtn onClick={onRedo} disabled={!canRedo}>↪</IconBtn>
    </div>
  );

  // ── Value row sub-components ──
  const ValueCells = ({ cat, budgeted, activity, available }) => {
    const isPos = available > 0, isNeg = available < 0;
    const hasActivity = activity !== 0;
    return (
      <>
        <div style={{ textAlign: "right", minWidth: 0 }} onClick={e => e.stopPropagation()}>
          <AmountInput
            initialValue={budgeted || undefined}
            onCommit={val => attemptSetBudgetAmt(cat.id, val)}
            style={{ width: "100%", border: "none", outline: "none", fontSize: 12, fontFamily: "inherit", background: "transparent", padding: "2px 0", boxSizing: "border-box", textAlign: "right", cursor: "pointer", color: budgeted === 0 ? "#C4C0CC" : C.text }}
          />
        </div>
        {SHOW_ACTIVITY && (
          <div
            onClick={hasActivity ? () => { const r = monthDateRange(month); goToTransactions({ categoryId: cat.id, dateFrom: r.from, dateTo: r.to }); } : undefined}
            style={{ textAlign: "right", fontSize: 12, color: activity > 0 ? C.red : activity < 0 ? C.green : "#C4C0CC", minWidth: 0, cursor: hasActivity ? "pointer" : "default" }}>
            {activity > 0 ? "-" : activity < 0 ? "+" : ""}{fmt(Math.abs(activity))}
          </div>
        )}
        <div style={{ textAlign: "right", minWidth: 0 }}>
          <span onClick={() => { if (isPos) setMoveMoneyState({ fromId: cat.id, toId: null }); else if (isNeg) setMoveMoneyState({ fromId: null, toId: cat.id }); }}
            style={{ fontSize: 12, fontWeight: 700, color: isNeg ? C.red : available === 0 ? "#C4C0CC" : C.green, cursor: (isPos || isNeg) ? "pointer" : "default" }}>{fmt(available)}</span>
        </div>
      </>
    );
  };

  const GroupValueCells = ({ budgeted, activity, available, onActivityClick }) => {
    const hasActivity = activity !== 0;
    return (
      <>
        <div style={{ textAlign: "right", fontSize: 12, color: budgeted === 0 ? "#B5B0BD" : "#6A6575", minWidth: 0 }}>{fmt(budgeted)}</div>
        {SHOW_ACTIVITY && <div onClick={hasActivity ? onActivityClick : undefined} style={{ textAlign: "right", fontSize: 12, color: activity > 0 ? C.red : activity < 0 ? C.green : "#B5B0BD", minWidth: 0, cursor: hasActivity ? "pointer" : "default" }}>{activity > 0 ? "-" : activity < 0 ? "+" : ""}{fmt(Math.abs(activity))}</div>}
        <div style={{ textAlign: "right", fontSize: 12, fontWeight: 700, color: available < 0 ? C.red : available > 0 ? C.green : "#B5B0BD", minWidth: 0 }}>{fmt(available)}</div>
      </>
    );
  };

  return (
    <div style={{ fontFamily: "-apple-system, BlinkMacSystemFont, sans-serif", background: C.bg, height: "100vh", color: C.text, display: "flex", flexDirection: "column", overflow: "hidden" }}>

      {/* Scrollable content area */}
      <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column" }}>

      {/* Header */}
      <div style={{ background: C.navy, color: "#fff", position: "sticky", top: 0, zIndex: 20 }}>
        <div style={{ display: "flex", alignItems: "center", padding: "6px 10px", gap: 8 }}>
          {/* Notification bell */}
          <button onClick={() => setNotifOpen(true)}
            style={{ flexShrink: 0, background: notifCount > 0 ? C.red : "rgba(255,255,255,0.15)", border: "none", borderRadius: 10, color: "#fff", fontSize: 11, fontWeight: 800, padding: "4px 8px", cursor: "pointer", fontFamily: "inherit", lineHeight: 1.4, minWidth: 32, textAlign: "center" }}>
            {notifCount > 0 ? `🔔 ${notifCount}` : "🔔"}
          </button>
          {/* Month picker (budget) or page title (other screens) — center */}
          {nav === "budget" ? (
            <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 5 }}>
              <button onClick={() => setMonth(prevKey(month))} disabled={!monthIsAccessible(prevKey(month))}
                style={{ background: "rgba(255,255,255,0.12)", border: "1.5px solid rgba(255,255,255,0.2)", borderRadius: 7, color: "#fff", fontSize: 16, fontWeight: 700, cursor: monthIsAccessible(prevKey(month)) ? "pointer" : "not-allowed", opacity: monthIsAccessible(prevKey(month)) ? 1 : 0.3, padding: "3px 9px", lineHeight: 1, fontFamily: "inherit" }}>‹</button>
              <button onClick={() => setModal("history")}
                style={{ background: month === todayMonth ? "rgba(255,255,255,0.2)" : "rgba(255,255,255,0.08)", border: `1.5px solid ${month === todayMonth ? "rgba(255,255,255,0.5)" : "rgba(255,255,255,0.2)"}`, borderRadius: 7, color: "#fff", minWidth: 110, textAlign: "center", cursor: "pointer", padding: "3px 10px", fontFamily: "inherit", lineHeight: 1.2 }}>
                <div style={{ fontSize: 14, fontWeight: 800 }}>{keyLabel(month)}</div>
                <div style={{ fontSize: 9, opacity: 0.5, marginTop: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{budget.name}</div>
              </button>
              <button onClick={() => setMonth(nextKey(month))} disabled={!monthIsAccessible(nextKey(month))}
                style={{ background: "rgba(255,255,255,0.12)", border: "1.5px solid rgba(255,255,255,0.2)", borderRadius: 7, color: "#fff", fontSize: 16, fontWeight: 700, cursor: monthIsAccessible(nextKey(month)) ? "pointer" : "not-allowed", opacity: monthIsAccessible(nextKey(month)) ? 1 : 0.3, padding: "3px 9px", lineHeight: 1, fontFamily: "inherit" }}>›</button>
            </div>
          ) : (
            <div style={{ flex: 1, textAlign: "center" }}>
              <div style={{ fontSize: 14, fontWeight: 800, color: "#fff", opacity: 0.9 }}>
                {nav === "accounts" ? "Accounts" : nav === "transactions" ? "Transactions" : nav === "payees" ? "Payees" : nav === "settings" ? "Settings" : ""}
              </div>
              <div style={{ fontSize: 9, opacity: 0.45, marginTop: 1 }}>{budget.name}</div>
            </div>
          )}
          {/* RTA */}
          <div style={{ flexShrink: 0, textAlign: "right" }}>
            <div style={{ fontSize: 9, opacity: 0.55, textTransform: "uppercase", letterSpacing: "0.08em", lineHeight: 1 }}>Ready to Assign</div>
            <div style={{ fontSize: 16, fontWeight: 800, lineHeight: 1.2, color: globalFree < 0 ? "#FF6B6B" : globalFree === 0 ? "rgba(255,255,255,0.35)" : C.greenLight }}>{fmt(globalFree)}</div>
          </div>
        </div>
        {nav === "budget" && assignedAhead > 0.001 && (
          <div style={{ padding: "0 12px 5px", textAlign: "center", fontSize: 10, color: "rgba(255,255,255,0.6)" }}>
            📅 {fmt(assignedAhead)} assigned in future months
          </div>
        )}
      </div>

      {/* Budget View */}
      {nav === "accounts" && <AccountsView budget={budget} updateBudget={updateBudget} getAccountBalance={getAccountBalance} getCardBalance={getCardBalance} reconcileAccount={reconcileAccount} transactions={budget.transactions} isLocked={isLocked} goToTransactions={goToTransactions} archiveAccount={archiveAccount} deleteAccount={deleteAccount} requestAccountAction={requestAccountAction} accountHasTransactions={accountHasTransactions} accountNameExists={accountNameExists} ccNameExists={ccNameExists} renameAccount={renameAccount} pendingReconcile={pendingReconcile} onClearPendingReconcile={() => setPendingReconcile(null)} triggerTransferRef={triggerTransferRef} />}

      {nav === "budget" && (
        <>
          {/* Toolbar — compact icon row */}
          <div style={{ padding: "5px 10px", display: "flex", gap: 6, alignItems: "center", background: C.surface, borderBottom: `1px solid ${C.border}` }}>
            <button onClick={() => setModal("tx")} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 1, background: C.navy, border: "none", borderRadius: 8, color: "#fff", cursor: "pointer", padding: "5px 8px", fontFamily: "inherit", minWidth: 52 }}>
              <span style={{ fontSize: 15 }}>＋</span>
              <span style={{ fontSize: 9, opacity: 0.85 }}>Txn</span>
            </button>
            <button onClick={() => setModal("addCat")} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 1, background: C.purple, border: "none", borderRadius: 8, color: "#fff", cursor: "pointer", padding: "5px 8px", fontFamily: "inherit", minWidth: 52 }}>
              <span style={{ fontSize: 15 }}>＋</span>
              <span style={{ fontSize: 9, opacity: 0.85 }}>Category</span>
            </button>
            <button onClick={() => setModal("addGroup")} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 1, background: "#6A6575", border: "none", borderRadius: 8, color: "#fff", cursor: "pointer", padding: "5px 8px", fontFamily: "inherit", minWidth: 52 }}>
              <span style={{ fontSize: 15 }}>＋</span>
              <span style={{ fontSize: 9, opacity: 0.85 }}>Group</span>
            </button>
            <button onClick={() => setModal("editAllGoals")} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 1, background: C.green, border: "none", borderRadius: 8, color: "#fff", cursor: "pointer", padding: "5px 8px", fontFamily: "inherit", minWidth: 52 }}>
              <span style={{ fontSize: 15 }}>🎯</span>
              <span style={{ fontSize: 9, opacity: 0.85 }}>Goals</span>
            </button>
            {showAutoAssign && (
              <button onClick={() => { if (expiredGoalCats.length > 0) { setShowAutoAssignWarning(true); } else { autoAssign(); } }}
                style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 1, background: C.amber, border: "none", borderRadius: 8, color: "#fff", cursor: "pointer", padding: "5px 8px", fontFamily: "inherit", minWidth: 52 }}>
                <span style={{ fontSize: 15 }}>✨</span>
                <span style={{ fontSize: 9, opacity: 0.85 }}>Assign</span>
              </button>
            )}
            {(budget.moneyMoveLog || []).some(e => e.month === month) && (
              <button onClick={() => setShowMoveLog(true)}
                style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 1, background: "none", border: `1.5px solid ${C.border}`, borderRadius: 8, color: C.navy, cursor: "pointer", padding: "5px 8px", fontFamily: "inherit", minWidth: 52 }}>
                <span style={{ fontSize: 15 }}>📋</span>
                <span style={{ fontSize: 9, color: C.muted }}>History</span>
              </button>
            )}
          </div>

          {/* Underfunding banner */}
          {underfundedGoals.length > 0 && (
            <div style={{ background: "#FFF8E7", borderBottom: `1px solid ${C.gold}`, borderLeft: `4px solid ${C.gold}`, padding: "8px 14px", fontSize: 12, color: "#7A5800" }}>
              <strong>⚠️ {underfundedGoals.length} goal{underfundedGoals.length !== 1 ? "s" : ""} need{underfundedGoals.length === 1 ? "s" : ""} funding</strong>
              <span style={{ marginLeft: 6 }}>· {fmt(totalGoalNeeded)} still needed</span>
            </div>
          )}

          {/* Column headers */}
          <div style={{ display: "flex", justifyContent: "flex-end", padding: "4px 12px 0", background: C.bg }}>
            <button onClick={() => { setReorderMode(p => !p); setAvgHintCatId(null); }}
              style={{ background: reorderMode ? C.purple : "transparent", color: reorderMode ? "#fff" : C.muted, border: `1.5px solid ${reorderMode ? C.purple : C.border}`, borderRadius: 7, padding: "4px 12px", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
              {reorderMode ? "✓ Done" : "↕ Reorder"}
            </button>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: BUDGET_COLS, gap: 10, padding: "6px 12px 4px", alignItems: "center", background: C.bg }}>
            <span style={{ fontSize: 9, color: C.muted, textTransform: "uppercase", letterSpacing: "0.06em" }}>Category</span>
            <span style={{ fontSize: 9, color: C.muted, textTransform: "uppercase", letterSpacing: "0.06em", textAlign: "right" }}>Budgeted</span>
            {SHOW_ACTIVITY && <span style={{ fontSize: 9, color: C.muted, textTransform: "uppercase", letterSpacing: "0.06em", textAlign: "right" }}>Activity</span>}
            <span style={{ fontSize: 9, color: C.muted, textTransform: "uppercase", letterSpacing: "0.06em", textAlign: "right" }}>Available</span>
          </div>

          {/* Groups + categories */}
          {budget.categoryGroups.map(grp => {
            const cats = budget.categories.filter(c => c.groupId === grp.id && !c.archived);
            if (cats.length === 0 && grp.name === "Uncategorized") return null;
            const isOpen = !collapsed[grp.id];
            const gB = cats.reduce((s, c) => s + Number(budgetsNow[c.id] || 0), 0);
            const gA = cats.reduce((s, c) => s + (activityByCat[c.id] || 0), 0);
            const gAv = cats.reduce((s, c) => s + getAvailableFast(c.id, month), 0);

            const isDraggingGroup = dragInfo?.type === "group";
            const isDraggingCategory = dragInfo?.type === "category";
            const isThisGroupDragged = isDraggingGroup && dragInfo.id === grp.id;
            const groupDropBefore = isDraggingGroup && dropTarget?.beforeGroupId === grp.id;
            const lastVisibleGroupId = [...budget.categoryGroups].reverse().find(g => {
              const c2 = budget.categories.filter(c => c.groupId === g.id && !c.archived);
              return !(c2.length === 0 && g.name === "Uncategorized");
            })?.id;
            const groupDropAfter = isDraggingGroup && dropTarget?.beforeGroupId === null && grp.id === lastVisibleGroupId;
            const catDropInEmptyGroup = isDraggingCategory && dropTarget?.groupId === grp.id && cats.length === 0;

            return (
              <div key={grp.id}>
                {/* Group header */}
                <div data-dnd-grouphdr={grp.id} {...(reorderMode ? bindDragHandle("group", grp.id) : bindContextMenu([{ label: "✏️ Edit Group", onClick: () => setEditGroupId(grp.id) }]))}
                  style={{ background: reorderMode ? "#E4DDF5" : "#EAE7E1", opacity: isThisGroupDragged ? 0.4 : 1, borderTop: (groupDropBefore || catDropInEmptyGroup) ? `3px solid ${C.purple}` : "3px solid transparent", borderBottom: groupDropAfter ? `3px solid ${C.purple}` : `1px solid ${C.border}`, cursor: reorderMode ? "grab" : "default", touchAction: reorderMode ? "none" : "auto", WebkitTouchCallout: "none", WebkitUserSelect: "none", userSelect: "none" }}>
                  <div style={{ display: "grid", gridTemplateColumns: BUDGET_COLS, gap: 10, padding: "8px 10px", alignItems: "center" }}>
                    <span onClick={() => setCollapsed(p => ({ ...p, [grp.id]: !p[grp.id] }))} style={{ display: "flex", alignItems: "center", gap: 5, cursor: "pointer", userSelect: "none", fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: "#6A6575", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      <span style={{ fontSize: 9, opacity: 0.55 }}>{isOpen ? "▼" : "▶"}</span>{grp.name}
                    </span>
                    <GroupValueCells budgeted={gB} activity={gA} available={gAv} onActivityClick={() => { const r = monthDateRange(month); goToTransactions({ categoryIds: cats.map(c => c.id), categoryLabel: grp.name, dateFrom: r.from, dateTo: r.to }); }} />
                  </div>
                </div>

                {isOpen && cats.map(cat => {
                  const budgeted = Number(budgetsNow[cat.id] || 0);
                  const activity = activityByCat[cat.id] || 0;
                  const available = getAvailableFast(cat.id, month);
                  const metrics = getGoalMetrics(cat, available, budgeted, month);

                  const isThisCatDragged = isDraggingCategory && dragInfo.id === cat.id;
                  const catDropBefore = isDraggingCategory && dropTarget?.groupId === grp.id && dropTarget?.beforeId === cat.id;
                  const isLastCatInGroup = cats[cats.length - 1]?.id === cat.id;
                  const catDropAfter = isDraggingCategory && dropTarget?.groupId === grp.id && dropTarget?.beforeId === null && isLastCatInGroup;

                  return (
                    <div key={cat.id} data-dnd-cat={cat.id} data-dnd-group={grp.id} {...(reorderMode ? bindDragHandle("category", cat.id) : bindContextMenu([
                      { label: "⚙️ Category Settings", onClick: () => setCatSettingsId(cat.id) },
                      { label: cat.archived ? "↩ Restore Category" : "🗂 Archive Category", onClick: () => archiveCategory(cat) },
                      { label: "📝 Add Note for This Month", onClick: () => setCatNoteModal({ catId: cat.id, month }) },
                      { label: "📊 View Activity", onClick: () => { const { from, to } = monthDateRange(month); goToTransactions({ categoryId: cat.id, categoryLabel: cat.name, dateFrom: from, dateTo: to }); } },
                    ]))} style={{ background: reorderMode ? "#F3F0FA" : C.surface, borderBottom: "1px solid #F4F1EB", borderTop: catDropBefore ? `3px solid ${C.purple}` : "3px solid transparent", opacity: isThisCatDragged ? 0.4 : 1, cursor: reorderMode ? "grab" : "default", touchAction: reorderMode ? "none" : "auto", WebkitTouchCallout: "none", WebkitUserSelect: "none", userSelect: "none" }}>
                      <div style={{ display: "grid", gridTemplateColumns: BUDGET_COLS, gap: 10, padding: "9px 12px", alignItems: "center", fontSize: 14 }}>
                        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0, display: "flex", alignItems: "center", gap: 3 }}>
                          <span onClick={() => { if (!reorderMode) setAvgHintCatId(p => p === cat.id ? null : cat.id); }} style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: "0 1 auto", minWidth: 0, cursor: reorderMode ? "inherit" : "pointer" }}>{cat.name}</span>
                          {/* Unified note icon — reveals month note + persistent note */}
                          {(cat.note || budget.categoryNotes?.[month]?.[cat.id]) && (
                            <span style={{ flexShrink: 0, fontSize: 11, cursor: "pointer", position: "relative", display: "inline-block", zIndex: 10 }}
                              onClick={e => { e.stopPropagation(); if (window.matchMedia("(hover: none)").matches) setCatNoteTooltip(t => t?.catId === cat.id ? null : { catId: cat.id, monthNote: budget.categoryNotes?.[month]?.[cat.id] || "", persistentNote: cat.note || "" }); }}
                              onMouseEnter={() => { if (!window.matchMedia("(hover: none)").matches) setCatNoteTooltip({ catId: cat.id, monthNote: budget.categoryNotes?.[month]?.[cat.id] || "", persistentNote: cat.note || "" }); }}
                              onMouseLeave={e => { if (!window.matchMedia("(hover: none)").matches) { if (!e.currentTarget.contains(e.relatedTarget)) setCatNoteTooltip(null); } }}>
                              📝
                              {catNoteTooltip?.catId === cat.id && !window.matchMedia("(hover: none)").matches && (
                                <div style={{ position: "fixed", zIndex: 9000, background: C.navy, color: "#fff", borderRadius: 8, padding: "10px 14px", fontSize: 13, minWidth: 200, maxWidth: 300, boxShadow: "0 4px 20px rgba(0,0,0,0.25)", whiteSpace: "pre-wrap", lineHeight: 1.6, marginTop: 4 }}
                                  onMouseEnter={() => setCatNoteTooltip(t => t)}
                                  onMouseLeave={() => setCatNoteTooltip(null)}>
                                  {catNoteTooltip.monthNote && <><span style={{ fontSize: 11, opacity: 0.7, fontWeight: 700 }}>THIS MONTH</span>{"\n"}{catNoteTooltip.monthNote}</>}
                                  {catNoteTooltip.monthNote && catNoteTooltip.persistentNote && <><br /><br /></>}
                                  {catNoteTooltip.persistentNote && <><span style={{ fontSize: 11, opacity: 0.7, fontWeight: 700 }}>CATEGORY</span>{"\n"}{catNoteTooltip.persistentNote}</>}
                                </div>
                              )}
                            </span>
                          )}
                          {catNoteTooltip?.catId === cat.id && window.matchMedia("(hover: none)").matches && (
                            <Modal title={`📝 ${cat.name}`} onClose={() => setCatNoteTooltip(null)} closeLabel="Discard">
                              {catNoteTooltip.monthNote && (
                                <>
                                  <div style={{ fontSize: 11, fontWeight: 700, color: C.muted, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 4 }}>This Month</div>
                                  <div style={{ fontSize: 14, color: C.text, lineHeight: 1.7, whiteSpace: "pre-wrap", marginBottom: catNoteTooltip.persistentNote ? 14 : 0 }}>{catNoteTooltip.monthNote}</div>
                                </>
                              )}
                              {catNoteTooltip.persistentNote && (
                                <>
                                  <div style={{ fontSize: 11, fontWeight: 700, color: C.muted, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 4 }}>Category</div>
                                  <div style={{ fontSize: 14, color: C.text, lineHeight: 1.7, whiteSpace: "pre-wrap" }}>{catNoteTooltip.persistentNote}</div>
                                </>
                              )}
                            </Modal>
                          )}
                          {/* Goal indicator inline on name line */}
                          {cat.goal?.type && !metrics?.complete && <span style={{ flexShrink: 0, fontSize: 11 }}>🎯</span>}
                          {metrics?.complete && <span style={{ flexShrink: 0, fontSize: 11 }}>✅</span>}
                          {/* Goal progress inline */}
                          {metrics?.type === "monthly" && <span style={{ flexShrink: 0, fontSize: 10, color: metrics.underfunded ? C.red : C.green, fontWeight: 600 }}>{metrics.underfunded ? `⚠️ ${fmt(metrics.needed)}` : "✓"}</span>}
                          {metrics?.type === "date" && !metrics.complete && <span style={{ flexShrink: 0, fontSize: 10, color: metrics.onTrack ? C.textLight : C.red, fontWeight: 600 }}>{metrics.onTrack ? "✓" : `⚠️ ${fmt(metrics.monthlyNeeded)}/mo`}</span>}
                          {metrics?.type === "savings" && !metrics.complete && <span style={{ flexShrink: 0, fontSize: 10, color: C.purple, fontWeight: 600 }}>{Math.round(metrics.progress)}%</span>}
                          {/* RTA return arrow inline */}
                          {(() => { const r = getCatReturnedToRTA(cat, month, budget.monthlyBudgets, budget.inflows); return r > 0.005 ? <span style={{ flexShrink: 0, fontSize: 10, color: C.muted }}>↩ {fmt(r)}</span> : null; })()}
                        </span>
                        <ValueCells cat={cat} budgeted={budgeted} activity={activity} available={available} />
                      </div>
                      {/* Trailing-average spending hint (tap category name to reveal) */}
                      {avgHintCatId === cat.id && !reorderMode && (() => {
                        if (cat.creditCardId) return null; // exclude CC payment categories
                        const ta = getTrailingAvg(cat.id, month);
                        if (!ta) return null; // no history → no hint
                        const over = ta.avg > budgeted + 0.005;
                        return (
                          <div style={{ padding: "6px 12px 9px 12px", fontSize: 12, color: C.textLight, display: "flex", alignItems: "center", gap: 6, background: C.surface, borderBottom: "1px solid #F4F1EB", flexWrap: "wrap" }}>
                            <span>📊 {ta.monthsUsed}-mo avg spend:</span>
                            <span style={{ fontWeight: 700, color: over ? C.red : C.green }}>{fmt(ta.avg)}/mo</span>
                            <span style={{ color: C.muted }}>· budgeted {fmt(budgeted)}</span>
                            {over && <span style={{ color: C.red, fontWeight: 600 }}>⚠️ under by {fmt(ta.avg - budgeted)}</span>}
                          </div>
                        );
                      })()}
                    </div>
                  );
                })}
              </div>
            );
          })}

          {/* Archived categories */}
          {archivedCats.length > 0 && (
            <div>
              <div onClick={() => setShowArchived(p => !p)} style={{ padding: "8px 10px", fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: C.muted, background: "#F4F1EB", borderBottom: `1px solid ${C.border}`, cursor: "pointer", userSelect: "none", display: "flex", alignItems: "center", gap: 5 }}>
                <span style={{ fontSize: 9 }}>{showArchived ? "▼" : "▶"}</span>🗂️ Archived ({archivedCats.length})
              </div>
              {showArchived && archivedCats.map(cat => (
                <div key={cat.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 14px 8px 22px", background: C.surface, borderBottom: "1px solid #F4F1EB", opacity: 0.55 }}>
                  <span style={{ fontSize: 14 }}>{cat.name}</span>
                  <Btn small outline color={C.navy} onClick={() => archiveCategory(cat)}>↩ Restore</Btn>
                </div>
              ))}
            </div>
          )}

          {/* Totals */}
          <div style={{ background: C.navy, color: "#fff", position: "sticky", bottom: 0 }}>
            <div style={{ display: "flex", alignItems: "center", padding: "6px 12px", gap: 4 }}>
              <div style={{ flex: 1 }}>
                <span style={{ fontSize: 9, opacity: 0.55, textTransform: "uppercase", letterSpacing: "0.06em" }}>Budgeted </span>
                <span style={{ fontSize: 12, fontWeight: 700 }}>{fmt(totalBudgeted)}</span>
              </div>
              {SHOW_ACTIVITY && (
                <div style={{ flex: 1, textAlign: "center" }}>
                  <span style={{ fontSize: 9, opacity: 0.55, textTransform: "uppercase", letterSpacing: "0.06em" }}>Activity </span>
                  <span style={{ fontSize: 12, fontWeight: 700, color: totalActivity < 0 ? C.greenLight : "#FF9999" }}>{totalActivity < 0 ? "+" : "-"}{fmt(Math.abs(totalActivity))}</span>
                </div>
              )}
              <div style={{ flex: 1, textAlign: "right" }}>
                <span style={{ fontSize: 9, opacity: 0.55, textTransform: "uppercase", letterSpacing: "0.06em" }}>Available </span>
                <span style={{ fontSize: 12, fontWeight: 700, color: C.greenLight }}>{fmt(totalAvailable)}</span>
              </div>
            </div>
          </div>
        </>
      )}

      {/* Transactions View */}
      {nav === "transactions" && (
        <>
          <div style={{ padding: "8px 14px", display: "flex", gap: 7, background: C.surface, borderBottom: `1px solid ${C.border}`, alignItems: "center" }}>
            <Btn color={C.navy} small onClick={() => setModal("tx")}>+ Add Transaction</Btn>
            <Btn color={C.muted} outline small onClick={() => setModal("import")}>📥 Import</Btn>
          </div>

          <div style={{ position: "relative" }}>
            <div style={{ display: "flex", alignItems: "stretch", background: C.surface, borderBottom: `1px solid ${C.border}` }}>
              <div style={{ flex: 1 }}>
                <TxSearchBar
                  value={txSearch}
                  onChange={setTxSearch}
                  chips={txSearchChips}
                  onAddChip={addChip}
                  onRemoveChip={removeChip}
                  onClearChips={clearChips}
                  budget={budget}
                  getDisplayName={getDisplayName}
                  UNCONFIRMED_FILTER={UNCONFIRMED_FILTER}
                  C={C}
                  inputSt={inputSt}
                  fmt={fmt}
                  searchRef={txSearchInputRef}
                />
              </div>
              <div style={{ display: "flex", alignItems: "flex-start", padding: "8px 10px 0 0", gap: 4, flexShrink: 0 }}>
                <IconBtn onClick={() => onSave({ ...appData, showReconciled: !(appData.showReconciled ?? false) })} active={appData.showReconciled ?? false} title={(appData.showReconciled ?? false) ? "Reconciled transactions visible — tap to hide" : "Reconciled transactions hidden — tap to show"}>🔒</IconBtn>
                <IconBtn onClick={() => setShowTxFilters(p => !p)} active={showTxFilters}>⚙️</IconBtn>
              </div>
            </div>
          </div>

          {showTxFilters && (
            <div style={{ padding: "10px 14px", background: "#F8F6F2", borderBottom: `1px solid ${C.border}` }}>
              {txFilters.payee && (
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8, padding: "6px 10px", background: "#fff", border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 12 }}>
                  <span style={{ color: C.muted }}>Payee:</span>
                  <span style={{ fontWeight: 700, flex: 1 }}>{txFilters.payee}</span>
                  <button onClick={() => setTxFilters(p => ({ ...p, payee: "" }))} title="Clear" style={{ background: "none", border: "none", color: C.muted, cursor: "pointer", fontSize: 16, padding: "0 2px" }}>×</button>
                </div>
              )}
              {txFilters.categoryIds && (
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8, padding: "6px 10px", background: "#fff", border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 12 }}>
                  <span style={{ color: C.muted }}>Group:</span>
                  <span style={{ fontWeight: 700, flex: 1 }}>{txFilters.categoryLabel}</span>
                  <button onClick={() => setTxFilters(p => ({ ...p, categoryIds: null, categoryLabel: "" }))} title="Clear" style={{ background: "none", border: "none", color: C.muted, cursor: "pointer", fontSize: 16, padding: "0 2px" }}>×</button>
                </div>
              )}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 8 }}>
                <Sel value={txFilters.accountId} onChange={e => setTxFilters(p => ({ ...p, accountId: e.target.value }))}>
                  <option value="">All Accounts</option>
                  {budget.accounts.length > 0 && <optgroup label="Accounts">{budget.accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</optgroup>}
                  {budget.creditCards.length > 0 && <optgroup label="Credit Cards">{budget.creditCards.map(cc => <option key={cc.id} value={cc.id}>{cc.name}</option>)}</optgroup>}
                </Sel>
                <Sel value={txFilters.categoryId} onChange={e => setTxFilters(p => ({ ...p, categoryId: e.target.value, categoryIds: null, categoryLabel: "" }))}>
                  <option value="">All Categories</option>
                  <option value={UNCONFIRMED_FILTER}>⚠️ Missing or Unconfirmed</option>
                  {budget.categoryGroups.map(g => (<optgroup key={g.id} label={g.name}>{budget.categories.filter(c => c.groupId === g.id).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</optgroup>))}
                </Sel>
              </div>
              <div style={{ marginBottom: 8 }}>
                <Sel value={txFilters.type} onChange={e => setTxFilters(p => ({ ...p, type: e.target.value }))}>
                  <option value="">All Types</option><option value="expense">Expense</option><option value="income">Income</option><option value="payment">Payment</option><option value="adjustment">Adjustment</option>
                </Sel>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 8 }}>
                <div>
                  <label style={{ display: "block", fontSize: 10, fontWeight: 700, color: C.muted, marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.06em" }}>From Date</label>
                  <div style={{ display: "flex", gap: 4 }}>
                    <input type="date" style={{ ...inputSt, padding: "8px 6px", fontSize: 12, flex: 1, minWidth: 0 }} value={txFilters.dateFrom} onChange={e => setTxFilters(p => ({ ...p, dateFrom: e.target.value }))} />
                    {txFilters.dateFrom && <button onClick={() => setTxFilters(p => ({ ...p, dateFrom: "" }))} title="Clear" style={{ background: "none", border: "none", color: C.muted, cursor: "pointer", fontSize: 16, padding: "0 2px" }}>×</button>}
                  </div>
                </div>
                <div>
                  <label style={{ display: "block", fontSize: 10, fontWeight: 700, color: C.muted, marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.06em" }}>To Date</label>
                  <div style={{ display: "flex", gap: 4 }}>
                    <input type="date" style={{ ...inputSt, padding: "8px 6px", fontSize: 12, flex: 1, minWidth: 0 }} value={txFilters.dateTo} onChange={e => setTxFilters(p => ({ ...p, dateTo: e.target.value }))} />
                    {txFilters.dateTo && <button onClick={() => setTxFilters(p => ({ ...p, dateTo: "" }))} title="Clear" style={{ background: "none", border: "none", color: C.muted, cursor: "pointer", fontSize: 16, padding: "0 2px" }}>×</button>}
                  </div>
                </div>
              </div>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <div style={{ display: "flex", gap: 4 }}>
                  <IconBtn active={txFilters.amountGT} onClick={() => setTxFilters(p => ({ ...p, amountGT: !p.amountGT, amountLT: p.amountGT ? p.amountLT : false }))}>{">"}</IconBtn>
                  <IconBtn active={txFilters.amountEQ} onClick={() => setTxFilters(p => ({ ...p, amountEQ: !p.amountEQ }))}>{"="}</IconBtn>
                  <IconBtn active={txFilters.amountLT} onClick={() => setTxFilters(p => ({ ...p, amountLT: !p.amountLT, amountGT: p.amountLT ? p.amountGT : false }))}>{"<"}</IconBtn>
                </div>
                <input type="number" min="0" placeholder="0.00" style={{ ...inputSt, flex: 1 }} value={txFilters.amountVal} onChange={e => {
                  let v = e.target.value;
                  if (v.startsWith("-")) v = v.slice(1);
                  setTxFilters(p => {
                    const next = { ...p, amountVal: v };
                    if (v && !p.amountGT && !p.amountEQ && !p.amountLT) next.amountEQ = true;
                    return next;
                  });
                }} />
                <Btn small outline color={C.muted} onClick={() => { setTxFilters(blankTxFilters()); setTxSearch(""); clearChips(); }}>Clear All Filters</Btn>
              </div>
            </div>
          )}

          {openTransactions.length > 0 && (
            <button onClick={() => { setTxFilters({ ...blankTxFilters(), categoryId: UNCONFIRMED_FILTER }); setTxSearch(""); setShowTxFilters(true); }} style={{ display: "block", width: "100%", textAlign: "left", background: "#FFF8E7", borderBottom: `1px solid ${C.gold}`, borderLeft: `4px solid ${C.gold}`, padding: "10px 14px", fontSize: 12, color: "#7A5800", cursor: "pointer", fontFamily: "inherit" }}>
              <strong>⚠️ {openTransactions.length} transaction{openTransactions.length !== 1 ? "s" : ""} need{openTransactions.length === 1 ? "s" : ""} attention</strong> · Missing or Unconfirmed Categories · Tap to fix
            </button>
          )}

          {(() => {
            const search = normalizeSearch(txSearch);
            const amountVal = parseFloat(txFilters.amountVal);
            const filtered = sortedTxsByDate.filter(tx => {
              if (!(appData.showReconciled ?? false) && isLocked(tx)) return false;
              if (search && !(
                normalizeSearch(getDisplayName(tx.originalPayee) || "").includes(search) ||
                normalizeSearch(tx.note || "").includes(search) ||
                normalizeSearch(tx.date || "").includes(search)
              )) return false;
              if (txFilters.accountId && tx.accountId !== txFilters.accountId) return false;
              if (txFilters.categoryId === UNCONFIRMED_FILTER) {
                const needsAttention = !tx.accountId || (tx.type === "expense" && !tx.categoryId && !tx.splits) || tx.categoryConfirmed === false;
                if (!needsAttention) return false;
              } else if (txFilters.categoryId) {
                const cats = tx.splits ? tx.splits.map(sp => sp.categoryId) : [tx.categoryId];
                if (!cats.includes(txFilters.categoryId)) return false;
              }
              if (txFilters.categoryIds) {
                const cats = tx.splits ? tx.splits.map(sp => sp.categoryId) : [tx.categoryId];
                if (!cats.some(id => txFilters.categoryIds.includes(id))) return false;
              }
              if (txFilters.payee && getDisplayName(tx.originalPayee) !== txFilters.payee) return false;
              if (txFilters.type && tx.type !== txFilters.type) return false;
              if (txFilters.dateFrom && tx.date < txFilters.dateFrom) return false;
              if (txFilters.dateTo && tx.date > txFilters.dateTo) return false;
              if ((txFilters.amountGT || txFilters.amountEQ || txFilters.amountLT) && !isNaN(amountVal) && amountVal >= 0) {
                const A = amountVal;
                let pass = false;
                if (txFilters.amountEQ && (Math.abs(tx.amount - A) < 0.005 || Math.abs(tx.amount + A) < 0.005)) pass = true;
                if (txFilters.amountGT && (tx.amount > A + 0.005 || tx.amount < -A - 0.005)) pass = true;
                if (txFilters.amountLT && (tx.amount > -A + 0.005 && tx.amount < A - 0.005)) pass = true;
                if (!pass) return false;
              }
              // Apply search chips (each chip = additional AND condition)
              for (const chip of txSearchChips) {
                if (chip.type === "payee" && getDisplayName(tx.originalPayee) !== chip.value) return false;
                if (chip.type === "category") {
                  const cats = tx.splits ? tx.splits.map(sp => sp.categoryId) : [tx.categoryId];
                  if (!cats.includes(chip.value)) return false;
                }
                if (chip.type === "account" && tx.accountId !== chip.value) return false;
                if (chip.type === "amount_digits") {
                  // Strip non-digits from both the query and the formatted amount, then check substring
                  const txDigits = Math.abs(tx.amount).toFixed(2).replace(/[^0-9]/g, "");
                  if (!txDigits.includes(chip.value)) return false;
                }
                if (chip.type === "month" && !tx.date.startsWith(chip.value)) return false;
                if (chip.type === "txtype" && tx.type !== chip.value) return false;
              }
              return true;
            });
            filteredTxsRef.current = filtered; // expose to action bar for Select All
            if (budget.transactions.length === 0) return (
              <div style={{ textAlign: "center", padding: "80px 20px", color: C.muted }}>
                <div style={{ fontSize: 48, marginBottom: 12 }}>💸</div>
                <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 6 }}>No transactions yet</div>
                <div style={{ fontSize: 14 }}>Tap + Add Transaction to get started</div>
              </div>
            );
            if (filtered.length === 0) return (
              <div style={{ textAlign: "center", padding: "60px 20px", color: C.muted }}>
                <div style={{ fontSize: 36, marginBottom: 8 }}>🔍</div>
                <div style={{ fontSize: 14 }}>No transactions match your search/filters</div>
              </div>
            );

            // Show filtered total when any filter or search is active (reconciled toggle excluded)
            const blank = blankTxFilters();
            const hasActiveFilter = txSearch.trim() || txSearchChips.length > 0 ||
              Object.keys(blank).some(k => {
                const bv = blank[k]; const fv = txFilters[k];
                if (Array.isArray(bv)) return JSON.stringify(fv) !== JSON.stringify(bv);
                return fv !== bv;
              });
            const filteredTotal = hasActiveFilter
              ? filtered.reduce((s, tx) => {
                  const isCardTx = budget.creditCards.some(c => c.id === tx.accountId);
                  if (tx.type === "income") return s + Math.abs(tx.amount);
                  if (tx.type === "expense") return s - Number(tx.amount); // positive expense = debt/spend; negative = refund adds back
                  if (tx.type === "payment") return isCardTx
                    ? s + Math.abs(tx.amount)   // CC side: payment reduces debt → positive
                    : s - Math.abs(tx.amount);  // Bank side: payment leaves account → negative
                  return s;
                }, 0)
              : null;

            return (<>
              {filteredTotal !== null && (
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 14px", background: C.surface, borderBottom: `1px solid ${C.border}`, fontSize: 12 }}>
                  <span style={{ color: C.muted }}>{filtered.length} transaction{filtered.length !== 1 ? "s" : ""}</span>
                  <span style={{ fontWeight: 700, color: filteredTotal >= 0 ? C.green : C.red }}>
                    Net: {filteredTotal >= 0 ? "+" : ""}{fmt(filteredTotal)}
                  </span>
                </div>
              )}
              <div style={{ paddingBottom: inSelectionMode ? 60 : 0 }}>
              {filtered.map(tx => {
              const account = budget.accounts.find(a => a.id === tx.accountId) || budget.creditCards.find(c => c.id === tx.accountId);
              const cat = budget.categories.find(c => c.id === tx.categoryId);
              const isSplit = tx.splits && tx.splits.length > 0;
              const isExpanded = expandedTxId === tx.id;
              const locked = isLocked(tx);
              const isStartingBalance = tx.subtype === "starting_balance";
              const isRefundTx = tx.type === "expense" && tx.amount < 0;
              const isSuggested = !isStartingBalance && tx.categoryConfirmed === false && tx.categoryId && tx.type === "expense" && !tx.splits;
              const isMissingCat = !isStartingBalance && tx.type === "expense" && !tx.categoryId && !tx.splits;
              const isInlinePicker = inlineCatPickerTxId === tx.id;
              const isCardTx = budget.creditCards.some(c => c.id === tx.accountId);
              const isCardPayment = tx.type === "payment" && isCardTx;
              const sign = tx.type === "income" || (tx.type === "adjustment" && tx.amount >= 0) || isRefundTx || isCardPayment ? "+" : "-";
              const amtColor = tx.type === "income" || isRefundTx || isCardPayment ? C.green : tx.type === "payment" ? C.purple : tx.type === "adjustment" ? C.gold : C.text;

              // Category pill
              let catPill;
              if (isStartingBalance) {
                catPill = <span style={{ fontSize: 11, color: C.muted, background: "#F0EEE9", borderRadius: 6, padding: "2px 7px", whiteSpace: "nowrap", display: "inline-block", fontStyle: "italic" }}>Starting Balance</span>;
              } else if (isInlinePicker) {
                catPill = (
                  <div onClick={e => e.stopPropagation()} style={{ minWidth: 160 }}>
                    <SearchableSel value={tx.categoryId || ""} onChange={v => {
                      if (!v) { setInlineCatPickerTxId(null); return; }
                      const isBankAcct = budget.accounts.some(a => a.id === tx.accountId);
                      const isCardAcct = budget.creditCards.some(c => c.id === tx.accountId);
                      // CC account: "Payment from [X]" → convert to payment
                      if (isCardAcct && isPayFromValue(v)) {
                        const fromAccountId = getPayFromAccountId(v);
                        const scanned = runPaymentMatchScan(
                          budget.transactions.map(t => t.id === tx.id ? { ...t, type: "payment", categoryId: undefined, categoryConfirmed: undefined, paymentLinkStatus: "broken", paymentFromAccountId: fromAccountId } : t),
                          budget.creditCards, budget.accounts
                        );
                        updateBudget({ transactions: scanned });
                      // Bank account: CC payment category → convert to payment
                      } else if (isBankAcct && budget.categories.some(c => c.id === v && c.creditCardId)) {
                        const scanned = runPaymentMatchScan(
                          budget.transactions.map(t => t.id === tx.id ? { ...t, type: "payment", categoryId: v, categoryConfirmed: undefined, paymentLinkStatus: "broken" } : t),
                          budget.creditCards, budget.accounts
                        );
                        updateBudget({ transactions: scanned });
                      } else {
                        editTx(tx.id, { categoryId: v, categoryConfirmed: true });
                      }
                      setInlineCatPickerTxId(null);
                    }} options={buildCatOptionsForAccount(tx.accountId, budget)} placeholder="Search categories..." autoOpen />
                  </div>
                );
              } else if (isSplit) {
                catPill = <span style={{ fontSize: 11, color: C.muted }}>🔀 Split</span>;
              } else if (tx.type === "transfer") {
                catPill = <span style={{ fontSize: 11, color: C.purple, fontWeight: 600 }}>🔄 Transfer</span>;
              } else if (tx.type === "payment") {
                const isCardSide = budget.creditCards.some(c => c.id === tx.accountId);
                const linkIcon = tx.paymentLinkStatus === "linked" ? "🔗" : tx.paymentLinkStatus === "broken" ? "⛓️‍💥" : null;
                const label = isCardSide
                  ? (() => {
                      const fromAcct = tx.paymentFromAccountId ? budget.accounts.find(a => a.id === tx.paymentFromAccountId) : null;
                      return fromAcct ? `Payment from ${fromAcct.name}` : "Card Payment";
                    })()
                  : (() => {
                      const cat = budget.categories.find(c => c.id === tx.categoryId);
                      return cat?.name || "Payment";
                    })();
                catPill = <span style={{ fontSize: 11, color: C.purple, fontWeight: 600, display: "flex", alignItems: "center", gap: 3 }}>{linkIcon && <span title={tx.paymentLinkStatus === "linked" ? "Matched" : "Waiting for match"}>{linkIcon}</span>}{label}</span>;
              } else if (tx.type === "adjustment") {
                catPill = <span style={{ fontSize: 11, color: C.gold, fontWeight: 600 }}>⚖️ Adj</span>;
              } else if (tx.type === "income") {
                catPill = <span style={{ fontSize: 11, color: C.green, fontWeight: 600 }}>Income</span>;
              } else if (isMissingCat) {
                catPill = (
                  <button onClick={e => { e.stopPropagation(); setInlineCatPickerTxId(tx.id); }}
                    style={{ fontSize: 11, fontWeight: 700, border: `1.5px dashed ${C.red}`, borderRadius: 6, padding: "2px 7px", background: "#FFF0F0", color: C.red, cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap" }}>
                    — No Category
                  </button>
                );
              } else if (isSuggested) {
                catPill = (
                  <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                    <span style={{ fontSize: 11, fontWeight: 700, border: `1.5px dashed ${C.amber}`, borderRadius: 6, padding: "2px 7px", background: "#FFF8E7", color: C.amber, whiteSpace: "nowrap" }}>
                      {cat?.name || "—"}
                    </span>
                    <button onClick={e => { e.stopPropagation(); editTx(tx.id, { categoryConfirmed: true }); }}
                      title="Confirm" style={{ background: C.green, border: "none", borderRadius: 5, color: "#fff", fontSize: 11, fontWeight: 800, cursor: "pointer", padding: "2px 6px", fontFamily: "inherit" }}>✓</button>
                    <button onClick={e => { e.stopPropagation(); setInlineCatPickerTxId(tx.id); }}
                      title="Change" style={{ background: "none", border: `1.5px solid ${C.muted}`, borderRadius: 5, color: C.muted, fontSize: 11, fontWeight: 800, cursor: "pointer", padding: "2px 6px", fontFamily: "inherit" }}>✕</button>
                  </div>
                );
              } else {
                catPill = (
                  <span style={{ fontSize: 11, color: C.textLight, background: "#F0EEE9", borderRadius: 6, padding: "2px 7px", whiteSpace: "nowrap", display: "inline-block" }}>
                    {cat?.name || (isRefundTx ? "↩ Refund" : "—")}
                  </span>
                );
              }

              return (
                <div key={tx.id} style={{ background: selectedTxIds.has(tx.id) ? "#EEF2FF" : isStartingBalance ? "#F8F6F2" : isSuggested ? "#FFFBF0" : isMissingCat ? "#FFF8F8" : C.surface }}>
                  <div onClick={() => {
                    if (inSelectionMode) {
                      setSelectedTxIds(prev => { const next = new Set(prev); next.has(tx.id) ? next.delete(tx.id) : next.add(tx.id); return next.size > 0 ? next : new Set(); });
                    } else {
                      isSplit ? setExpandedTxId(isExpanded ? null : tx.id) : setEditingTx(tx);
                    }
                  }}
                    {...(inSelectionMode ? {} : bindTxLongPress(tx.id))}
                    style={{ display: "grid", gridTemplateColumns: inSelectionMode ? "32px 54px 1fr auto auto auto" : "54px 1fr auto auto auto", gap: 6, padding: "10px 14px", borderBottom: isExpanded ? "none" : "1px solid #F4F1EB", alignItems: "center", cursor: "pointer", WebkitTouchCallout: "none", WebkitUserSelect: "none", userSelect: "none" }}>
                    {inSelectionMode && (
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
                        <div style={{ width: 20, height: 20, borderRadius: 4, border: `2px solid ${selectedTxIds.has(tx.id) ? C.purple : C.border}`, background: selectedTxIds.has(tx.id) ? C.purple : "#fff", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                          {selectedTxIds.has(tx.id) && <span style={{ color: "#fff", fontSize: 13, lineHeight: 1 }}>✓</span>}
                        </div>
                      </div>
                    )}
                    <div style={{ fontSize: 11, color: C.muted, lineHeight: 1.3 }}>
                      {new Date(tx.date + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                    </div>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: isStartingBalance ? C.muted : undefined }}>
                        {isStartingBalance ? (account?.name || "Account") : getDisplayName(tx.originalPayee)}
                      </div>
                      <div style={{ fontSize: 11, color: C.muted, display: "flex", alignItems: "center", gap: 4, flexWrap: "nowrap", overflow: "hidden" }}>
                        {account ? <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{account.name}</span> : null}
                        {!tx.accountId && <span style={{ color: C.gold }}>⚠️ no account</span>}
                        {(() => {
                          const catNote = tx.categoryId && budget.categoryNotes?.[tx.date?.slice(0, 7)]?.[tx.categoryId];
                          const fullNote = [tx.note, catNote ? `Note from category for ${new Date((tx.date || "") + "T12:00:00").toLocaleDateString("en-US", { month: "short", year: "2-digit" })}: ${catNote}` : ""].filter(Boolean).join(" · ");
                          return fullNote ? <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: C.muted }}>· {fullNote}</span> : null;
                        })()}
                      </div>
                    </div>
                    <div onClick={e => e.stopPropagation()}>{catPill}</div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: amtColor, whiteSpace: "nowrap" }}>{sign}{fmt(Math.abs(tx.amount))}</div>
                    {locked ? (
                      <span style={{ fontSize: 14, padding: "0 2px", color: C.muted }} title="Locked by reconciliation">🔒</span>
                    ) : (
                      <button onClick={(e) => { e.stopPropagation(); setConfirmTxDelete(tx); }} style={{ background: "none", border: "none", color: "#C0BBCC", cursor: "pointer", fontSize: 20, padding: "0 2px" }}>×</button>
                    )}
                  </div>
                  {isExpanded && isSplit && (
                    <div style={{ background: C.inputBg, borderBottom: "1px solid #F4F1EB", padding: "4px 14px 8px 70px" }}>
                      {tx.splits.map((sp, i) => {
                        const spCat = budget.categories.find(c => c.id === sp.categoryId);
                        return (
                          <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "3px 0", fontSize: 12, color: C.textLight }}>
                            <span>{spCat?.name || "—"}</span>
                            <span>{fmt(sp.amount)}</span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
              </div>
            </>);
          })()}

          {/* ── Bulk selection action bar ── */}
          {inSelectionMode && (
            <div style={{ position: "fixed", bottom: 60, left: 0, right: 0, zIndex: 300, background: C.navy, color: "#fff", padding: "10px 14px", display: "flex", alignItems: "center", gap: 8, boxShadow: "0 -2px 12px rgba(0,0,0,0.2)", flexWrap: "wrap" }}>
              <span style={{ fontSize: 13, fontWeight: 700, flex: 1, whiteSpace: "nowrap" }}>{selectedTxIds.size} selected</span>
              <button onClick={() => {
                const allFilteredIds = new Set(filteredTxsRef.current.map(t => t.id));
                selectedTxIds.size === allFilteredIds.size ? exitSelection() : setSelectedTxIds(allFilteredIds);
              }} style={{ background: "rgba(255,255,255,0.15)", border: "none", color: "#fff", borderRadius: 6, padding: "5px 10px", fontSize: 12, cursor: "pointer", fontFamily: "inherit", fontWeight: 600 }}>
                {selectedTxIds.size >= filteredTxsRef.current.length && filteredTxsRef.current.length > 0 ? "Deselect All" : "Select All"}
              </button>
              {(() => {
                const selTxs = [...selectedTxIds].map(id => budget.transactions.find(t => t.id === id)).filter(Boolean);
                const canCategorize = selTxs.length > 0 && selTxs.every(t => t.type === "expense" || t.type === "income" || t.type === "transfer" || t.type === "adjustment" || t.type === "payment");
                const hasSuggested = selTxs.some(t => !t.splits && t.categoryConfirmed === false && t.categoryId && t.type === "expense");
                const exactlyOne = selectedTxIds.size === 1;
                return (
                  <>
                    {exactlyOne && (
                      <button onClick={() => { const tx = budget.transactions.find(t => t.id === [...selectedTxIds][0]); if (tx) { setEditingTx(tx); exitSelection(); } }} style={{ background: C.purple, border: "none", color: "#fff", borderRadius: 6, padding: "5px 10px", fontSize: 12, cursor: "pointer", fontFamily: "inherit", fontWeight: 600 }}>✏️ Edit</button>
                    )}
                    {hasSuggested && (
                      <button onClick={bulkConfirm} style={{ background: C.green, border: "none", color: "#fff", borderRadius: 6, padding: "5px 10px", fontSize: 12, cursor: "pointer", fontFamily: "inherit", fontWeight: 600 }}>✓ Confirm</button>
                    )}
                    <button onClick={() => { if (selTxs.length > 0) setBulkCatModal(true); }} style={{ background: "#0277BD", border: "none", color: "#fff", borderRadius: 6, padding: "5px 10px", fontSize: 12, cursor: "pointer", fontFamily: "inherit", fontWeight: 600 }}>🏷 Cat</button>
                    <button onClick={() => setBulkDeleteConfirm(true)} style={{ background: C.red, border: "none", color: "#fff", borderRadius: 6, padding: "5px 10px", fontSize: 12, cursor: "pointer", fontFamily: "inherit", fontWeight: 600 }}>🗑</button>
                    <button onClick={exitSelection} style={{ background: "rgba(255,255,255,0.15)", border: "none", color: "#fff", borderRadius: 6, padding: "5px 10px", fontSize: 12, cursor: "pointer", fontFamily: "inherit", fontWeight: 600 }}>✕</button>
                  </>
                );
              })()}
            </div>
          )}
        </>
      )}

      {/* Bulk delete confirmation */}
      {bulkDeleteConfirm && (
        <Modal title="Delete Transactions?" onClose={() => setBulkDeleteConfirm(false)}>
          <div style={{ fontSize: 14, color: C.textLight, lineHeight: 1.6, marginBottom: 16 }}>
            Delete <strong>{selectedTxIds.size} transaction{selectedTxIds.size !== 1 ? "s" : ""}</strong>? This cannot be undone. Locked (reconciled) transactions will be skipped.
          </div>
          <div style={{ display: "flex", gap: 10 }}>
            <Btn outline color={C.muted} onClick={() => setBulkDeleteConfirm(false)} style={{ flex: 1 }}>Cancel</Btn>
            <Btn color={C.red} onClick={bulkDelete} style={{ flex: 1 }}>Delete</Btn>
          </div>
        </Modal>
      )}

      {/* Bulk categorize modal */}
      {bulkCatModal && (() => {
        const selTxs = [...selectedTxIds].map(id => budget.transactions.find(t => t.id === id)).filter(Boolean);
        // Use first selected tx's account for options; falls back to all categories
        const accountId = selTxs.length === 1 ? selTxs[0].accountId : (selTxs.every(t => t.accountId === selTxs[0]?.accountId) ? selTxs[0]?.accountId : "");
        return (
          <Modal title={`Categorize ${selectedTxIds.size} Transaction${selectedTxIds.size !== 1 ? "s" : ""}`} onClose={() => setBulkCatModal(false)}>
            <div style={{ fontSize: 13, color: C.textLight, marginBottom: 14 }}>Choose a category to apply to all selected transactions. Any splits will be replaced with this single category. Transaction types will update automatically (e.g. expense → payment) where applicable.</div>
            <SearchableSel value="" onChange={v => { if (v) bulkCategorize(v); }}
              options={buildCatOptionsForAccount(accountId, budget)} placeholder="Search categories..." autoOpen />
          </Modal>
        );
      })()}

      {/* Payees View */}
      {nav === "payees" && <PayeesView budget={budget} updateBudget={updateBudget} canonicalNames={canonicalNames} getOriginalsForCanonical={getOriginalsForCanonical} getDisplayName={getDisplayName} getPayeeDefaultCategory={getPayeeDefaultCategory} setPayeeDefaultCategory={setPayeeDefaultCategory} getPayeeSuggestedCategory={getPayeeSuggestedCategory} setPayeeSuggestedCategory={setPayeeSuggestedCategory} setCanonicalForNames={setCanonicalForNames} unmergeOriginal={unmergeOriginal} unmergeAllForCanonical={unmergeAllForCanonical} unmergeAllPayees={unmergeAllPayees} clearAllPayeeDefaults={clearAllPayeeDefaults} goToTransactions={goToTransactions} suggestMergeNav={suggestMergeNav} onMergeNavConsumed={() => setSuggestMergeNav(false)} rejectedMerges={rejectedMerges} onRejectMerge={pair => updateBudget({ rejectedMerges: [...(budget.rejectedMerges || []), pair] })} />}

      {/* Settings */}
      {nav === "settings" && <SettingsView appData={appData} onSave={onSave} budget={budget} updateBudget={updateBudget} getAccountBalance={getAccountBalance} renameAccount={renameAccount} accountNameExists={accountNameExists} ccNameExists={ccNameExists} userAccount={userAccount} onSaveUserAccount={onSaveUserAccount} onLogOut={onLogOut} />}

      {/* End scrollable content area */}
      </div>

      {/* Bottom Nav */}
      <div style={{ flexShrink: 0, background: C.surface, borderTop: `1px solid ${C.border}`, display: "flex", zIndex: 30, alignItems: "stretch" }}>
        {[["accounts", "🏦", "Accounts"], ["budget", "📊", "Budget"], ["transactions", "💸", "Transactions"], ["payees", "👥", "Payees"], ["settings", "⚙️", "Settings"]].map(([id, icon, label]) => (
          <button key={id} onClick={() => setNav(id)} style={{ flex: 1, padding: "10px 4px 8px", background: "none", border: "none", cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", gap: 2, position: "relative" }}>
            <span style={{ fontSize: 20 }}>{icon}</span>
            <span style={{ fontSize: 11, fontWeight: nav === id ? 700 : 400, color: nav === id ? C.navy : C.muted }}>{label}</span>
            {id === "transactions" && openTransactions.length > 0 && (
              <span style={{ position: "absolute", top: 4, right: "28%", background: C.gold, color: "#fff", borderRadius: 8, fontSize: 9, fontWeight: 800, padding: "1px 5px", lineHeight: 1.3 }}>{openTransactions.length}</span>
            )}
          </button>
        ))}
        <div style={{ display: "flex", flexDirection: "column", justifyContent: "center", gap: 4, padding: "6px 8px", borderLeft: `1px solid ${C.border}` }}>
          <IconBtn onClick={onUndo} disabled={!canUndo} title="Undo">↩</IconBtn>
          <IconBtn onClick={onRedo} disabled={!canRedo} title="Redo">↪</IconBtn>
        </div>
      </div>

      {/* Notification Center */}
      {showShortcuts && (
        <Modal title="⌨️ Keyboard Shortcuts" onClose={() => setShowShortcuts(false)}>
          {[
            { heading: "Navigation" },
            { keys: ["G", "B"], desc: "Go to Budget" },
            { keys: ["G", "T"], desc: "Go to Transactions" },
            { keys: ["G", "A"], desc: "Go to Accounts" },
            { keys: ["G", "P"], desc: "Go to Payees" },
            { keys: ["G", "S"], desc: "Go to Settings" },
            { heading: "Budget" },
            { keys: ["←"], desc: "Previous month" },
            { keys: ["→"], desc: "Next month" },
            { heading: "Transactions" },
            { keys: ["N"], desc: "New transaction" },
            { keys: ["/"], desc: "Focus search" },
            { heading: "General" },
            { keys: ["⌘", "Z"], desc: "Undo" },
            { keys: ["⌘", "⇧", "Z"], desc: "Redo" },
            { keys: ["Esc"], desc: "Close modal / panel" },
            { keys: ["?"], desc: "Show this help" },
          ].map((row, i) => row.heading ? (
            <div key={i} style={{ fontSize: 10, fontWeight: 800, color: C.muted, textTransform: "uppercase", letterSpacing: "0.08em", marginTop: i === 0 ? 0 : 14, marginBottom: 6 }}>{row.heading}</div>
          ) : (
            <div key={i} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "5px 0", borderBottom: `1px solid ${C.border}` }}>
              <span style={{ fontSize: 13, color: C.text }}>{row.desc}</span>
              <div style={{ display: "flex", gap: 4 }}>
                {row.keys.map((k, ki) => (
                  <kbd key={ki} style={{ background: "#F0EEE9", border: `1px solid ${C.border}`, borderRadius: 5, padding: "2px 7px", fontSize: 12, fontFamily: "inherit", fontWeight: 700, color: C.navy, boxShadow: "0 1px 0 rgba(0,0,0,0.15)" }}>{k}</kbd>
                ))}
              </div>
            </div>
          ))}
          <div style={{ fontSize: 11, color: C.muted, marginTop: 14, textAlign: "center" }}>G-prefix shortcuts have a 1-second window</div>
        </Modal>
      )}

      {notifOpen && (
        <Modal title={`🔔 Notifications${notifCount > 0 ? ` (${notifCount})` : ""}`} onClose={() => { setNotifOpen(false); setExpandedNotifId(null); }}>
          {activeNotifications.length === 0 ? (
            <div style={{ textAlign: "center", padding: "32px 16px", color: C.muted }}>
              <div style={{ fontSize: 32, marginBottom: 8 }}>✅</div>
              <div style={{ fontSize: 14 }}>No active notifications</div>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
              {activeNotifications.map((notif, i) => {
                const isExpanded = expandedNotifId === notif.id;
                return (
                  <div key={notif.id} style={{ borderBottom: i < activeNotifications.length - 1 ? `1px solid ${C.border}` : "none" }}>
                    <button onClick={() => setExpandedNotifId(isExpanded ? null : notif.id)}
                      style={{ width: "100%", background: isExpanded ? "#F8F6F2" : "none", border: "none", textAlign: "left", padding: "12px 14px", cursor: "pointer", display: "flex", alignItems: "center", gap: 10, fontFamily: "inherit" }}>
                      <span style={{ fontSize: 18, flexShrink: 0 }}>{notif.icon || "🔔"}</span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 700, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{notif.subject}</div>
                        {notif.tag && <div style={{ fontSize: 11, color: C.muted, marginTop: 1 }}>{notif.tag}</div>}
                      </div>
                      <span style={{ fontSize: 12, color: C.muted, flexShrink: 0 }}>{isExpanded ? "▲" : "▼"}</span>
                    </button>
                    {isExpanded && (
                      <div style={{ padding: "0 14px 14px 42px" }}>
                        <div style={{ fontSize: 13, color: C.textLight, lineHeight: 1.65, marginBottom: notif.action ? 12 : 0 }}>{notif.body}</div>
                        {notif.action && (
                          <Btn color={notif.action.color || C.navy} onClick={() => { notif.action.onClick(); setNotifOpen(false); setExpandedNotifId(null); }} style={{ marginTop: 8 }}>
                            {notif.action.label}
                          </Btn>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </Modal>
      )}

      {/* Duplicate Review Modal */}
      {dupReviewOpen && (() => {
        const pendingDups = (budget.pendingDuplicates || []).filter(p =>
          budget.transactions.some(t => t.id === p.newTxId) &&
          budget.transactions.some(t => t.id === p.existingTxId)
        );
        if (pendingDups.length === 0) return null;
        const pair = pendingDups[0];
        const txA = budget.transactions.find(t => t.id === pair.newTxId);
        const txB = budget.transactions.find(t => t.id === pair.existingTxId);
        const resolvePair = (keepId, deleteId) => {
          const remaining = pendingDups.slice(1);
          const txDel = budget.transactions.find(t => t.id === deleteId);
          const txUpdates = { transactions: budget.transactions.filter(t => t.id !== deleteId) };
          // Reverse side effects of deleted tx
          if (txDel) {
            if (txDel.type === "expense" && budget.creditCards.some(c => c.id === txDel.accountId)) {
              const cid = findCCPaymentCatId(txDel.accountId);
              if (cid) { const mk = txDel.date.slice(0,7); const mb = { ...(budget.monthlyBudgets[mk] || {}) }; mb[cid] = (mb[cid] || 0) - Number(txDel.amount); txUpdates.monthlyBudgets = { ...budget.monthlyBudgets, [mk]: mb }; }
            }
            if (txDel.type === "income" && !budget.creditCards.some(c => c.id === txDel.accountId)) {
              const mk = txDel.date.slice(0,7); txUpdates.inflows = { ...budget.inflows, [mk]: (budget.inflows[mk] || 0) - Number(txDel.amount) };
            }
          }
          txUpdates.pendingDuplicates = remaining;
          updateBudget(txUpdates);
          if (remaining.length === 0) setDupReviewOpen(false);
        };
        const keepBoth = () => {
          const remaining = pendingDups.slice(1);
          updateBudget({ pendingDuplicates: remaining });
          if (remaining.length === 0) setDupReviewOpen(false);
        };
        const fmtTx = (tx) => {
          if (!tx) return null;
          const acct = [...budget.accounts, ...budget.creditCards].find(a => a.id === tx.accountId);
          const cat = tx.categoryId ? budget.categories.find(c => c.id === tx.categoryId) : null;
          return (
            <div style={{ border: `1px solid ${C.border}`, borderRadius: 10, padding: 14, flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: C.text, marginBottom: 6, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{tx.payee || "—"}</div>
              <div style={{ fontSize: 12, color: C.textLight, marginBottom: 3 }}>{tx.date}</div>
              <div style={{ fontSize: 16, fontWeight: 800, color: tx.amount < 0 ? C.red : C.green, marginBottom: 6 }}>{fmt(tx.amount)}</div>
              {acct && <div style={{ fontSize: 11, color: C.muted, marginBottom: 3 }}>📂 {acct.name}</div>}
              {cat && <div style={{ fontSize: 11, color: C.muted, marginBottom: 3 }}>🏷 {cat.name}</div>}
              {tx.note ? <div style={{ fontSize: 11, color: C.muted, fontStyle: "italic" }}>"{tx.note}"</div> : null}
            </div>
          );
        };
        return (
          <Modal title={`⚠️ Potential Duplicate (${pendingDups.length} remaining)`} onClose={() => setDupReviewOpen(false)}>
            <div style={{ fontSize: 13, color: C.textLight, marginBottom: 14, lineHeight: 1.6 }}>
              These two transactions look like they might be the same. Choose which one to keep, or keep both if they're different transactions.
            </div>
            <div style={{ display: "flex", gap: 10, marginBottom: 14 }}>
              {fmtTx(txA)}
              <div style={{ display: "flex", alignItems: "center", color: C.muted, fontSize: 18, flexShrink: 0 }}>⟷</div>
              {fmtTx(txB)}
            </div>
            <div style={{ display: "flex", gap: 8, flexDirection: "column" }}>
              <div style={{ display: "flex", gap: 8 }}>
                <Btn color={C.navy} onClick={() => resolvePair(txA?.id, txB?.id)} style={{ flex: 1 }}>Keep Left</Btn>
                <Btn color={C.navy} onClick={() => resolvePair(txB?.id, txA?.id)} style={{ flex: 1 }}>Keep Right</Btn>
              </div>
              <Btn outline color={C.muted} onClick={keepBoth} style={{ width: "100%" }}>Keep Both</Btn>
            </div>
          </Modal>
        );
      })()}

      {confirmTxDelete && (
        <Modal title="Delete Transaction?" onClose={() => setConfirmTxDelete(null)}>
          <div style={{ fontSize: 14, color: C.textLight, lineHeight: 1.6, marginBottom: 16 }}>
            Delete <strong>{confirmTxDelete.payee || "this transaction"}</strong> ({fmt(Math.abs(confirmTxDelete.amount))} on {confirmTxDelete.date})? This cannot be undone.
            {confirmTxDelete.type === "transfer" && confirmTxDelete.transferLinkId && (
              <div style={{ marginTop: 8, color: C.amber }}>Both sides of this transfer will be deleted.</div>
            )}
            {confirmTxDelete.type === "payment" && confirmTxDelete.paymentLinkStatus === "linked" && (
              <div style={{ marginTop: 8, color: C.amber }}>The matching payment on the other account will be unlinked.</div>
            )}
          </div>
          <div style={{ display: "flex", gap: 10 }}>
            <Btn outline color={C.muted} onClick={() => setConfirmTxDelete(null)} style={{ flex: 1 }}>Cancel</Btn>
            <Btn color={C.red} onClick={() => { deleteTx(confirmTxDelete); setConfirmTxDelete(null); }} style={{ flex: 1 }}>Delete</Btn>
          </div>
        </Modal>
      )}

      {modal === "tx" && (
        <Modal title="New Transaction" onClose={() => setModal(null)} closeLabel="Discard">
          {budget.accounts.length === 0 && budget.creditCards.length === 0 ? (
            <div>
              <div style={{ fontSize: 14, color: C.textLight, lineHeight: 1.7, marginBottom: 16 }}>
                Every transaction needs to be tied to an account or credit card, so the app can keep a running balance. Add one in Settings first.
              </div>
              <Btn color={C.navy} onClick={() => { setModal(null); setNav("settings"); }} style={{ width: "100%" }}>Go to Settings</Btn>
            </div>
          ) : (
            <>
              <Field label="Date">
                <input type="date" value={txForm.date} onChange={e => setTxForm(p => ({ ...p, date: e.target.value }))} style={{ ...inputSt, width: "100%", minWidth: 0, maxWidth: "100%", WebkitAppearance: "none", appearance: "none", boxSizing: "border-box" }} />
              </Field>

              <SearchableSel label="Account" value={txForm.accountId} onChange={v => setTxForm(p => ({ ...p, accountId: v, categoryId: "", splits: null }))}
                options={buildAccountOptions(budget.accounts, budget.creditCards)} placeholder="Search accounts..." />

              {/* Payee — hidden for CC payment transactions */}
              {!isPayFromValue(txForm.categoryId) && !budget.categories.some(c => c.id === txForm.categoryId && c.creditCardId) && (
              <Field label="Payee">
                <div style={{ position: "relative" }}>
                  <input style={inputSt} placeholder="Who was it?" value={txForm.payee} autoComplete="off" autoCorrect="off" autoCapitalize="words" spellCheck={false}
                    onChange={e => {
                      const val = e.target.value;
                      const displayedName = getDisplayName(val.trim());
                      const defCat = getPayeeDefaultCategory(displayedName);
                      const sugCat = getPayeeSuggestedCategory(displayedName);
                      const autoCat = defCat || sugCat || "";
                      setTxForm(p => ({ ...p, payee: val, categoryId: (!p.splits && !p.categoryId && autoCat) ? autoCat : p.categoryId }));
                      setPayeeDropOpen(true);
                    }}
                    onFocus={() => setPayeeDropOpen(true)}
                    onBlur={() => setTimeout(() => setPayeeDropOpen(false), 150)}
                  />
                  {payeeDropOpen && txForm.payee.trim() && (() => {
                    const q = txForm.payee.trim().toLowerCase();
                    const matches = canonicalNames.filter(n => n.toLowerCase().includes(q));
                    if (!matches.length) return null;
                    return (
                      <div style={{ position: "absolute", top: "100%", left: 0, right: 0, zIndex: 500, background: C.surface, border: `1.5px solid ${C.navy}`, borderRadius: 8, boxShadow: "0 4px 20px rgba(0,0,0,0.15)", marginTop: 2, maxHeight: 200, overflowY: "auto" }}>
                        {matches.slice(0, 8).map(name => (
                          <button key={name} type="button" onMouseDown={() => {
                            const defCat = getPayeeDefaultCategory(name);
                            const sugCat = getPayeeSuggestedCategory(name);
                            const autoCat = defCat || sugCat || "";
                            setTxForm(p => ({ ...p, payee: name, categoryId: (!p.splits && !p.categoryId && autoCat) ? autoCat : p.categoryId }));
                            setPayeeDropOpen(false);
                          }} style={{ display: "block", width: "100%", textAlign: "left", padding: "10px 14px", background: "none", border: "none", borderBottom: `1px solid #F4F1EB`, fontSize: 14, color: C.text, cursor: "pointer", fontFamily: "inherit" }}>
                            {name}
                          </button>
                        ))}
                      </div>
                    );
                  })()}
                </div>
              </Field>
              )}

              {/* Category — always shown, options depend on account type */}
              {!txForm.splits && (
                <SearchableSel label="Category" value={txForm.categoryId}
                  onChange={v => setTxForm(p => ({ ...p, categoryId: v }))}
                  options={txForm.accountId
                    ? buildCatOptionsForAccount(txForm.accountId, budget, [{ value: "__rta__", label: "→ Ready to Assign (income)" }])
                    : [{ value: "", label: "Select account first" }]}
                  placeholder="Search categories..." />
              )}

              {/* Amount — always shown; +/- toggle only for regular expenses */}
              {(() => {
                const isIncome = txForm.categoryId === "__rta__";
                const isPaymentCat = isPayFromValue(txForm.categoryId) || budget.categories.some(c => c.id === txForm.categoryId && c.creditCardId);
                const isSpecial = isIncome || isPaymentCat;
                if (txForm.splits) return null;
                if (isSpecial) {
                  return (
                    <AmountInput label="Amount" initialValue={txForm.amount || undefined}
                      onChange={v => setTxForm(p => ({ ...p, amount: Math.max(0, v) }))}
                      onCommit={v => setTxForm(p => ({ ...p, amount: Math.max(0, v) }))}
                      placeholder="0.00" />
                  );
                }
                return (
                  <Field label="Amount">
                    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      <div style={{ display: "flex", borderRadius: 8, overflow: "hidden", border: `1.5px solid ${C.border}`, flexShrink: 0 }}>
                        <button onClick={() => setTxForm(p => ({ ...p, isRefund: false }))}
                          style={{ padding: "0 14px", height: 44, background: !txForm.isRefund ? C.red : "transparent", color: !txForm.isRefund ? "#fff" : C.muted, border: "none", borderRight: `1px solid ${C.border}`, cursor: "pointer", fontSize: 18, fontWeight: 900, fontFamily: "inherit" }}>−</button>
                        <button onClick={() => setTxForm(p => ({ ...p, isRefund: true }))}
                          style={{ padding: "0 14px", height: 44, background: txForm.isRefund ? C.green : "transparent", color: txForm.isRefund ? "#fff" : C.muted, border: "none", cursor: "pointer", fontSize: 18, fontWeight: 900, fontFamily: "inherit" }}>+</button>
                      </div>
                      <AmountInput label="Amount" initialValue={txForm.amount ? Math.abs(txForm.amount) : undefined}
                        signPrefix={txForm.isRefund ? "+" : "−"}
                        onToggleSign={() => setTxForm(p => ({ ...p, isRefund: !p.isRefund }))}
                        onChange={v => setTxForm(p => ({ ...p, amount: v }))}
                        onCommit={v => setTxForm(p => ({ ...p, amount: v }))}
                        placeholder="0.00" style={{ flex: 1 }} />
                    </div>
                  </Field>
                );
              })()}

              {/* Split — only for regular expense categories; requires amount */}
              {!txForm.splits && txForm.accountId && txForm.categoryId !== "__rta__" && !isPayFromValue(txForm.categoryId) && !budget.categories.some(c => c.id === txForm.categoryId && c.creditCardId) && (
                <button
                  onClick={() => setTxForm(p => ({ ...p, splits: [{ categoryId: p.categoryId || "", amount: 0 }, { categoryId: "", amount: 0 }], preSplitCategoryId: p.categoryId, preSplitAmount: p.amount, categoryId: "" }))}
                  disabled={!txForm.amount}
                  style={{ background: "none", border: "none", color: txForm.amount ? C.purple : C.muted, fontSize: 12, fontWeight: 700, cursor: txForm.amount ? "pointer" : "not-allowed", padding: "0 0 14px", fontFamily: "inherit", opacity: txForm.amount ? 1 : 0.5 }}>
                  🔀 Split into multiple categories
                </button>
              )}

              {/* Split editor */}
              {txForm.splits && (() => {
                const splitSum = txForm.splits.reduce((s, sp) => s + (Number(sp.amount) || 0), 0);
                const remaining = Math.round((Math.abs(txForm.amount) - splitSum) * 100) / 100;
                const balanced = Math.abs(remaining) < 0.005;
                return (
                  <div style={{ marginBottom: 14 }}>
                    <label style={{ display: "block", fontSize: 11, fontWeight: 700, color: C.muted, marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.07em" }}>Split Categories</label>
                    {/* Total at top with +/- toggle */}
                    <Field label="Total Transaction Amount">
                      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                        <div style={{ display: "flex", borderRadius: 8, overflow: "hidden", border: `1.5px solid ${C.border}`, flexShrink: 0 }}>
                          <button onClick={() => setTxForm(p => ({ ...p, isRefund: false }))}
                            style={{ padding: "0 14px", height: 44, background: !txForm.isRefund ? C.red : "transparent", color: !txForm.isRefund ? "#fff" : C.muted, border: "none", borderRight: `1px solid ${C.border}`, cursor: "pointer", fontSize: 18, fontWeight: 900, fontFamily: "inherit" }}>−</button>
                          <button onClick={() => setTxForm(p => ({ ...p, isRefund: true }))}
                            style={{ padding: "0 14px", height: 44, background: txForm.isRefund ? C.green : "transparent", color: txForm.isRefund ? "#fff" : C.muted, border: "none", cursor: "pointer", fontSize: 18, fontWeight: 900, fontFamily: "inherit" }}>+</button>
                        </div>
                        <AmountInput label="Total Transaction Amount" initialValue={Math.abs(txForm.amount) || undefined}
                          signPrefix={txForm.isRefund ? "+" : "−"}
                          onToggleSign={() => setTxForm(p => ({ ...p, isRefund: !p.isRefund }))}
                          onChange={v => setTxForm(p => ({ ...p, amount: v }))}
                          onCommit={v => setTxForm(p => ({ ...p, amount: v }))}
                          placeholder="0.00" style={{ flex: 1 }} />
                      </div>
                    </Field>
                    {/* Individual splits — positive amounts only, sign from toggle */}
                    {txForm.splits.map((sp, i) => (
                      <div key={i} style={{ display: "flex", gap: 8, marginBottom: 8, alignItems: "flex-start" }}>
                        <div style={{ flex: 2 }}>
                          <SearchableSel value={sp.categoryId} onChange={v => setTxForm(p => ({ ...p, splits: p.splits.map((s, j) => j === i ? { ...s, categoryId: v } : s) }))}
                            options={buildCatOptions(budget.categoryGroups, budget.categories.filter(c => !c.creditCardId), { emptyLabel: "Category..." })} placeholder="Search..." />
                        </div>
                        <div style={{ flex: 1 }}>
                          <AmountInput initialValue={sp.amount || undefined} placeholder="0.00"
                            onChange={v => setTxForm(p => ({ ...p, splits: p.splits.map((s, j) => j === i ? { ...s, amount: Math.abs(v) } : s) }))}
                            onCommit={v => setTxForm(p => ({ ...p, splits: p.splits.map((s, j) => j === i ? { ...s, amount: Math.abs(v) } : s) }))} />
                        </div>
                        <button onClick={() => {
                          if (txForm.splits.length <= 1) return;
                          const next = txForm.splits.filter((_, j) => j !== i);
                          if (next.length === 1) {
                            setTxForm(p => ({ ...p, categoryId: p.preSplitCategoryId || next[0].categoryId || "", amount: p.preSplitAmount || txForm.amount || 0, splits: null, preSplitCategoryId: undefined, preSplitAmount: undefined }));
                          } else {
                            setTxForm(p => ({ ...p, splits: next }));
                          }
                        }} style={{ background: "none", border: "none", color: "#C0BBCC", fontSize: 18, cursor: "pointer", padding: "8px 2px" }}>×</button>
                      </div>
                    ))}
                    <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 4, marginBottom: 8 }}>
                      <button onClick={() => setTxForm(p => ({ ...p, splits: [...p.splits, { categoryId: "", amount: 0 }] }))} style={{ background: "none", border: "none", color: C.purple, fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>+ Add Category</button>
                      <button onClick={() => setTxForm(p => ({ ...p, categoryId: p.preSplitCategoryId || "", amount: p.preSplitAmount || 0, splits: null, preSplitCategoryId: undefined, preSplitAmount: undefined }))}
                        style={{ background: "none", border: "none", color: C.muted, fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>✕ Cancel Split</button>
                    </div>
                    {/* Balance indicator */}
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, padding: "6px 8px", borderRadius: 6, background: balanced ? "#EAF6F0" : "#FFF4E5" }}>
                      <span style={{ color: balanced ? C.green : C.amber, fontWeight: 700 }}>{balanced ? "✓ Balanced" : `${fmt(remaining)} remaining`}</span>
                      <span style={{ color: C.muted }}>Total: {txForm.isRefund ? "+" : "−"}{fmt(Math.abs(txForm.amount))}</span>
                    </div>
                  </div>
                );
              })()}

              <Inp label="Note (optional)" placeholder="Add a note..." value={txForm.note} onChange={e => setTxForm(p => ({ ...p, note: e.target.value }))} />

              <BtnRow onCancel={() => setModal(null)} onSave={addTx} saveLabel="Save Transaction" disabled={(() => {
                const isPaymentTx = isPayFromValue(txForm.categoryId) || budget.categories.some(c => c.id === txForm.categoryId && c.creditCardId);
                const payeeOk = isPaymentTx || !!txForm.payee;
                return !txForm.accountId || !payeeOk || !txForm.amount ||
                  (txForm.splits ? !(txForm.splits.length > 0 && txForm.splits.every(sp => sp.categoryId && sp.amount > 0) && Math.abs(txForm.splits.reduce((s, sp) => s + sp.amount, 0) - Math.abs(txForm.amount)) < 0.005) : false);
              })()} />
            </>
          )}
        </Modal>
      )}

      {modal === "fixTx" && (
        <Modal title="⚠️ Fix Transactions" onClose={() => setModal(null)}>
          <div style={{ fontSize: 13, color: C.textLight, marginBottom: 16, lineHeight: 1.6 }}>
            These transactions are missing an account and/or category. Assign what's needed for each.
          </div>
          {openTransactions.map(tx => (
            <div key={tx.id} style={{ borderBottom: `1px solid ${C.border}`, paddingBottom: 12, marginBottom: 12 }}>
              <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 6 }}>{getDisplayName(tx.originalPayee)} — {fmt(tx.amount)} <span style={{ color: C.muted, fontWeight: 400 }}>({new Date(tx.date + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })})</span></div>
              {!tx.accountId && (
                <Sel value={tx.accountId || ""} onChange={e => fixTransaction(tx.id, { accountId: e.target.value })}>
                  <option value="">Select an account...</option>
                  {budget.accounts.filter(a => !a.archived).length > 0 && <optgroup label="Cash & Bank Accounts">{budget.accounts.filter(a => !a.archived).map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</optgroup>}
                  {budget.creditCards.filter(c => !c.archived).length > 0 && <optgroup label="Credit Cards">{budget.creditCards.filter(c => !c.archived).map(cc => <option key={cc.id} value={cc.id}>{cc.name}</option>)}</optgroup>}
                </Sel>
              )}
              {!tx.categoryId && !tx.splits && (
                <div style={{ marginTop: 8 }}>
                  <Sel value={tx.categoryId || ""} onChange={e => fixTransaction(tx.id, { categoryId: e.target.value })}>
                    <option value="">Select a category...</option>
                    {budget.categoryGroups.map(g => (<optgroup key={g.id} label={g.name}>{budget.categories.filter(c => c.groupId === g.id && !c.archived).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</optgroup>))}
                  </Sel>
                </div>
              )}
            </div>
          ))}
          <Btn color={C.navy} onClick={() => setModal(null)} style={{ width: "100%" }}>Done</Btn>
        </Modal>
      )}

      {modal === "import" && (() => {
        const st = importState || { step: "select", rows: [], headers: [], accountId: "", dateCol: "", payeeCol: "", amountMode: "single", amountCol: "", signConvention: "neg-expense", debitCol: "", creditCol: "" };
        const closeImport = () => { setImportState(null); setModal(null); };
        const handleFile = (e) => {
          const file = e.target.files[0]; if (!file) return;
          const reader = new FileReader();
          reader.onload = (ev) => {
            const rows = parseCSV(ev.target.result);
            setImportState(p => ({ ...st, ...p, rows, headers: rows[0] || [], fileName: file.name }));
          };
          reader.readAsText(file);
        };
        const buildParsed = () => {
          const dataRows = st.rows.slice(1);
          const dIdx = st.headers.indexOf(st.dateCol);
          const pIdx = st.headers.indexOf(st.payeeCol);
          const aIdx = st.headers.indexOf(st.amountCol);
          const debIdx = st.headers.indexOf(st.debitCol);
          const credIdx = st.headers.indexOf(st.creditCol);
          const existing = budget.transactions.filter(tx => tx.accountId === st.accountId);
          const parsed = [];
          dataRows.forEach(row => {
            const date = parseCSVDate(row[dIdx]);
            const payee = (row[pIdx] || "").trim();
            if (!date || !payee) return;
            let amount, csvType;
            if (st.amountMode === "split") {
              const debit = parseCSVAmount(row[debIdx]); const credit = parseCSVAmount(row[credIdx]);
              if (debit > 0) { amount = debit; csvType = "expense"; }
              else if (credit > 0) { amount = credit; csvType = "income"; }
              else return;
            } else {
              const raw = parseCSVAmount(row[aIdx]); if (raw === 0) return;
              csvType = st.signConvention === "neg-expense" ? (raw < 0 ? "expense" : "income") : (raw > 0 ? "expense" : "income");
              amount = Math.abs(raw);
            }
            // B2: All rows enter review as type "expense" with amount sign preserved exactly as in CSV.
            // csvType carries the original sign-detected type for display purposes only.
            // Category selection in review drives type:
            //   RTA → income, CC payment cat → cc_payment, other cat → expense, no cat → expense
            const displayedPayee = getDisplayName(toTitleCase(payee));
            const categoryId = csvType === "expense" ? (getPayeeDefaultCategory(displayedPayee) || getPayeeSuggestedCategory(displayedPayee) || "") : "";
            // For split mode: debit = negative amount (expense), credit = positive amount (income-side)
            // For single-col mode: preserve raw sign
            const signedAmount = st.amountMode === "split"
              ? (csvType === "expense" ? -Math.abs(amount) : Math.abs(amount))
              : (st.signConvention === "neg-expense" ? (csvType === "expense" ? -Math.abs(amount) : Math.abs(amount)) : (csvType === "expense" ? Math.abs(amount) : -Math.abs(amount)));
            const isDup = existing.some(tx => tx.date === date && Math.abs(tx.amount - Math.abs(amount)) < 0.005 && (tx.originalPayee || "").trim().toLowerCase() === payee.toLowerCase());
            parsed.push({ date, payee, amount: signedAmount, type: "expense", csvType, categoryId, duplicate: isDup });
          });
          // Remember this mapping for next time we import to this account
          saveImportTemplate(st.accountId, { dateCol: st.dateCol, payeeCol: st.payeeCol, amountMode: st.amountMode, amountCol: st.amountCol, signConvention: st.signConvention, debitCol: st.debitCol, creditCol: st.creditCol });
          setImportState(p => ({ ...p, parsedTxs: parsed, step: "review" }));
        };
        // Move to the Map Columns step, pre-filling with a saved per-account template if its
        // columns still exist in this file, otherwise an auto-detected best guess.
        const goToMap = () => {
          const template = getImportTemplate(st.accountId);
          const templateValid = template && [template.dateCol, template.payeeCol, ...(template.amountMode === "split" ? [template.debitCol, template.creditCol] : [template.amountCol])].every(col => col && st.headers.includes(col));
          const mapping = templateValid ? template : guessColumnMapping(st.headers);
          setImportState({ ...st, ...mapping, step: "map", mappingSource: templateValid ? "template" : (mapping.dateCol || mapping.payeeCol) ? "guess" : "none" });
        };
        const updateParsed = (i, updates) => setImportState(p => ({ ...p, parsedTxs: p.parsedTxs.map((row, j) => j === i ? { ...row, ...updates } : row) }));
        const dupCount = (st.parsedTxs || []).filter(p => p.duplicate).length;
        const toImport = (st.parsedTxs || []).filter(p => !p.duplicate);
        const finishImport = () => { importTransactions(toImport, st.accountId); closeImport(); };

        if (st.step === "select") return (
          <Modal title="📥 Import Transactions" onClose={closeImport}>
            <div style={{ fontSize: 13, color: C.textLight, marginBottom: 16, lineHeight: 1.6 }}>Import a CSV export from your bank. You'll map the columns and review categories before anything is added.</div>
            <Field label="CSV File">
              <input type="file" accept=".csv" onChange={handleFile} style={{ ...inputSt, padding: 8 }} />
            </Field>
            {st.fileName && <div style={{ fontSize: 12, color: C.green, marginBottom: 14 }}>✓ {st.fileName} — {Math.max(0, st.rows.length - 1)} rows found</div>}
            <Sel label="Import into" value={st.accountId} onChange={e => setImportState({ ...st, accountId: e.target.value })}>
              <option value="">Select an account or card...</option>
              {budget.accounts.length > 0 && <optgroup label="Cash & Bank Accounts">{budget.accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</optgroup>}
              {budget.creditCards.length > 0 && <optgroup label="Credit Cards">{budget.creditCards.map(cc => <option key={cc.id} value={cc.id}>{cc.name}</option>)}</optgroup>}
            </Sel>
            <BtnRow onCancel={closeImport} onSave={goToMap} saveLabel="Next: Map Columns" disabled={st.rows.length < 2 || !st.accountId} />
          </Modal>
        );

        if (st.step === "map") return (
          <Modal title="Map Columns" onClose={closeImport} closeLabel="Discard">
            {st.mappingSource === "template" && (
              <div style={{ background: "#EAF6F0", border: `1px solid #A8DFBF`, borderRadius: 8, padding: 10, fontSize: 12, color: "#1A5C36", marginBottom: 14 }}>
                ✓ Pre-filled using the mapping you used last time for this account. Adjust if needed.
              </div>
            )}
            {st.mappingSource === "guess" && (
              <div style={{ background: "#EAF6F0", border: `1px solid #A8DFBF`, borderRadius: 8, padding: 10, fontSize: 12, color: "#1A5C36", marginBottom: 14 }}>
                ✓ Pre-filled based on your file's column names. Double-check these look right.
              </div>
            )}
            <div style={{ fontSize: 12, color: C.textLight, marginBottom: 14 }}>Preview of row 1: {st.rows[1]?.slice(0, 4).join(" · ")}{st.rows[1]?.length > 4 ? "…" : ""}</div>
            <Sel label="Date Column" value={st.dateCol} onChange={e => setImportState({ ...st, dateCol: e.target.value })}>
              <option value="">Select...</option>{st.headers.map(h => <option key={h} value={h}>{h}</option>)}
            </Sel>
            <Sel label="Payee / Description Column" value={st.payeeCol} onChange={e => setImportState({ ...st, payeeCol: e.target.value })}>
              <option value="">Select...</option>{st.headers.map(h => <option key={h} value={h}>{h}</option>)}
            </Sel>
            <Field label="Amount Format">
              <div style={{ display: "flex", gap: 8 }}>
                <Btn small color={st.amountMode === "single" ? C.navy : C.muted} outline={st.amountMode !== "single"} onClick={() => setImportState({ ...st, amountMode: "single" })} style={{ flex: 1 }}>One Amount Column</Btn>
                <Btn small color={st.amountMode === "split" ? C.navy : C.muted} outline={st.amountMode !== "split"} onClick={() => setImportState({ ...st, amountMode: "split" })} style={{ flex: 1 }}>Separate Debit/Credit</Btn>
              </div>
            </Field>
            {st.amountMode === "single" ? (
              <>
                <Sel label="Amount Column" value={st.amountCol} onChange={e => setImportState({ ...st, amountCol: e.target.value })}>
                  <option value="">Select...</option>{st.headers.map(h => <option key={h} value={h}>{h}</option>)}
                </Sel>
                <Field label="Sign Convention">
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {[["neg-expense", "Negative numbers are expenses"], ["pos-expense", "Positive numbers are expenses"]].map(([val, label]) => (
                      <label key={val} style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer", padding: "9px 12px", borderRadius: 8, background: st.signConvention === val ? "#EAF6F0" : "#F8F6F2", border: `1.5px solid ${st.signConvention === val ? C.green : "transparent"}` }}>
                        <input type="radio" checked={st.signConvention === val} onChange={() => setImportState({ ...st, signConvention: val })} /><span style={{ fontSize: 13 }}>{label}</span>
                      </label>
                    ))}
                  </div>
                </Field>
              </>
            ) : (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <Sel label="Debit Column (expenses)" value={st.debitCol} onChange={e => setImportState({ ...st, debitCol: e.target.value })}>
                  <option value="">Select...</option>{st.headers.map(h => <option key={h} value={h}>{h}</option>)}
                </Sel>
                <Sel label="Credit Column (income)" value={st.creditCol} onChange={e => setImportState({ ...st, creditCol: e.target.value })}>
                  <option value="">Select...</option>{st.headers.map(h => <option key={h} value={h}>{h}</option>)}
                </Sel>
              </div>
            )}
            <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
              <Btn outline color={C.muted} onClick={() => setImportState({ ...st, step: "select" })} style={{ flex: 1 }}>Back</Btn>
              <Btn color={C.navy} onClick={buildParsed} style={{ flex: 1 }} disabled={!st.dateCol || !st.payeeCol || (st.amountMode === "single" ? !st.amountCol : (!st.debitCol || !st.creditCol))}>Next: Review</Btn>
            </div>
          </Modal>
        );

        const RTA_SENTINEL = "__rta__";
        // Use buildCatOptionsForAccount for consistent category options across import, manual entry,
        // inline picker, and EditTxModal. CC imports get "Payment from [X]" virtual options.
        const importCatOptions = buildCatOptionsForAccount(st.accountId, budget, [
          { value: RTA_SENTINEL, label: "→ Ready to Assign (record as income)" },
        ]);
        return (
          <Modal title="Review Import" onClose={closeImport} closeLabel="Discard">
            <div style={{ fontSize: 13, color: C.textLight, marginBottom: 14 }}>
              <strong>{toImport.length}</strong> transaction{toImport.length !== 1 ? "s" : ""} ready to import{dupCount > 0 && <span>, <strong>{dupCount}</strong> skipped as duplicate{dupCount !== 1 ? "s" : ""}</span>}.
            </div>
            {/* B1: scrollable list, sticky buttons at bottom */}
            <div style={{ overflowY: "auto", maxHeight: "55vh", paddingBottom: 4 }}>
              {toImport.length === 0 ? (
                <div style={{ textAlign: "center", padding: "20px", color: C.muted, fontSize: 13 }}>
                  {dupCount > 0 ? "Everything in this file is already in ClearBudget — nothing new to import." : "Nothing to import."}
                </div>
              ) : (st.parsedTxs.filter(p => !p.duplicate).map((p, idx) => {
                const i = st.parsedTxs.indexOf(p);
                const displayedPayee = getDisplayName(toTitleCase(p.payee));
                const defCat = getPayeeDefaultCategory(displayedPayee);
                const sugCat = getPayeeSuggestedCategory(displayedPayee);
                const hasCatPref = !!(defCat || sugCat);
                const isRTA = p.categoryId === RTA_SENTINEL;
                // B2: amount is now sign-preserved; determine display color
                const willBeIncome = isRTA;
                const isPositive = p.amount > 0;
                // Positive non-RTA expense = refund (green); negative = normal expense (dark)
                const amtColor = willBeIncome ? C.green : isPositive ? C.green : C.text;
                return (
                  <div key={i} style={{ borderBottom: `1px solid #F4F1EB`, paddingBottom: 10, marginBottom: 10 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 2 }}>
                      <span style={{ fontWeight: 600 }}>{p.payee}</span>
                      <span style={{ fontWeight: 700, color: amtColor }}>{fmt(p.amount)}</span>
                    </div>
                    <div style={{ fontSize: 11, color: C.muted, marginBottom: 6 }}>
                      {new Date(p.date + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                      {willBeIncome && <span style={{ marginLeft: 6, color: C.green, fontWeight: 600 }}>· → Income / RTA</span>}
                      {!willBeIncome && isPositive && <span style={{ marginLeft: 6, color: C.green, fontWeight: 600 }}>· → Refund / Return</span>}
                      {!willBeIncome && !isPositive && <span style={{ marginLeft: 6 }}>· expense</span>}
                      {hasCatPref && !isRTA && !isPositive && <span style={{ marginLeft: 6, color: defCat ? C.green : C.amber }}>· {defCat ? "Default" : "Suggested"} pre-filled</span>}
                    </div>
                    {p.type === "expense" && (
                      <SearchableSel value={p.categoryId || ""} onChange={v => updateParsed(i, { categoryId: v })}
                        options={importCatOptions} placeholder="Search categories..." />
                    )}
                  </div>
                );
              }))}
            </div>
            {/* B1: sticky button row */}
            <div style={{ display: "flex", gap: 10, marginTop: 12, paddingTop: 12, borderTop: `1px solid ${C.border}` }}>
              {toImport.length === 0 ? (
                <Btn color={C.navy} onClick={closeImport} style={{ flex: 1 }}>Dismiss</Btn>
              ) : (
                <>
                  <Btn outline color={C.muted} onClick={() => setImportState({ ...st, step: "map" })} style={{ flex: 1 }}>Back</Btn>
                  <Btn color={C.green} onClick={finishImport} style={{ flex: 1 }}>Import {toImport.length} Transaction{toImport.length !== 1 ? "s" : ""}</Btn>
                </>
              )}
            </div>
          </Modal>
        );
      })()}

      {editingTx && (
        <EditTxModal
          tx={editingTx}
          budget={budget}
          isLocked={isLocked}
          isStartingBalance={editingTx.subtype === "starting_balance"}
          onSave={(id, updates) => editTx(id, updates)}
          onDelete={deleteTx}
          onClose={() => setEditingTx(null)}
          canonicalNames={canonicalNames}
          getDisplayName={getDisplayName}
          getPayeeDefaultCategory={getPayeeDefaultCategory}
          getPayeeSuggestedCategory={getPayeeSuggestedCategory}
          findCCPaymentCatId={findCCPaymentCatId}
          updateBudget={updateBudget}
        />
      )}

      {modal === "history" && (() => {
        // Computed here so it only runs when the modal is open (#6)
        const start = budgetStartMonth || todayMonth;
        const end = [furthestMonth, todayMonth].sort().pop();
        const months = []; let mk = start; let guard = 0;
        while (mk <= end && guard < 120) { months.push(mk); mk = nextKey(mk); guard++; }
        const historyData = months.map(mk => {
          const income = Number(budget.inflows[mk] || 0);
          const budgeted = Object.values(budget.monthlyBudgets[mk] || {}).reduce((s, v) => s + Number(v), 0);
          const spent = budget.transactions.filter(tx => tx.date.startsWith(mk) && tx.type === "expense").reduce((s, tx) => s + Number(tx.amount), 0);
          const trulyFree = getToAssignSim(mk, budget.monthlyBudgets, budget.inflows);
          return { month: mk, label: keyLabelShort(mk), income, budgeted, spent, trulyFree };
        });
        return (
        <Modal title="📈 Budget History" onClose={() => setModal(null)}>
          <Btn color={C.navy} onClick={() => { setMonth(todayMonth); setModal(null); }} style={{ width: "100%", marginBottom: 16 }}>📍 Jump to Today ({keyLabelShort(todayMonth)})</Btn>

          {historyData.length > 1 && (
            <div style={{ marginBottom: 20, marginLeft: -8 }}>
              <ResponsiveContainer width="100%" height={200}>
                <ComposedChart data={historyData} margin={{ top: 5, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#E5E2DC" />
                  <XAxis dataKey="label" tick={{ fontSize: 10 }} />
                  <YAxis tick={{ fontSize: 10 }} tickFormatter={v => `$${v}`} />
                  <Tooltip formatter={(v) => fmt(v)} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Bar dataKey="income" name="Income" fill={C.green} />
                  <Bar dataKey="spent" name="Spent" fill={C.red} />
                  <Line type="monotone" dataKey="trulyFree" name="Truly Free" stroke={C.navy} strokeWidth={2} dot={false} />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          )}

          {[...historyData].reverse().map(h => (
            <button key={h.month} onClick={() => { setMonth(h.month); setModal(null); }}
              style={{ display: "block", width: "100%", textAlign: "left", background: h.month === month ? "#EAF6F0" : C.surface, border: `1px solid ${h.month === month ? C.green : C.border}`, borderRadius: 8, padding: "10px 12px", marginBottom: 8, cursor: "pointer", fontFamily: "inherit" }}>
              <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 4, display: "flex", justifyContent: "space-between" }}>
                <span>{keyLabel(h.month)}{h.month === todayMonth ? " (Today)" : ""}</span>
                <span style={{ color: h.trulyFree < 0 ? C.red : C.green }}>{fmt(h.trulyFree)}</span>
              </div>
              <div style={{ display: "flex", gap: 12, fontSize: 11, color: C.muted }}>
                <span>Income: {fmt(h.income)}</span>
                <span>Budgeted: {fmt(h.budgeted)}</span>
                <span>Spent: {fmt(h.spent)}</span>
              </div>
            </button>
          ))}
        </Modal>
        );
      })()}

      {modal === "addCat" && <AddCategoryModal groups={budget.categoryGroups.filter(g => g.name !== "Credit Card Payments")} nameExists={nameExists} onAdd={addCategory} onClose={() => setModal(null)} />}
      {modal === "addGroup" && <AddGroupModal nameExists={groupNameExists} onAdd={addGroup} onClose={() => setModal(null)} />}
      {modal === "editAllGoals" && <EditAllGoalsModal budget={budget} updateBudget={updateBudget} onClose={() => setModal(null)} />}

      {catForSettings && (
        <CategorySettingsModal cat={catForSettings} groups={budget.categoryGroups} hasTransactions={catHasTransactions(catForSettings.id)} nameExists={nameExists}
          viewMonth={month} todayMonth={todayMonth}
          onSave={(updated) => { updateCategory(updated); setCatSettingsId(null); }}
          onArchive={archiveCategory} onDelete={deleteCategory} onClose={() => setCatSettingsId(null)} />
      )}

      {groupForEdit && (
        <EditGroupModal group={groupForEdit} categories={budget.categories} nameExists={groupNameExists} onSave={updateGroup} onDelete={deleteGroup} onClose={() => setEditGroupId(null)} />
      )}

      {moveMoneyState && (
        <MoveMoneyModal budget={budget} month={month} initialFrom={moveMoneyState.fromId} initialTo={moveMoneyState.toId} rtaAvailable={globalFree} getAvail={getAvailableFast} onMove={moveMoney} onClose={() => setMoveMoneyState(null)} />
      )}

      {contextMenu && <ContextMenu items={contextMenu.items} onClose={() => setContextMenu(null)} />}

      {/* Savings goal funding prompt */}
      {/* Auto-Assign Preview Modal */}
      {autoAssignPreview && (() => {
        const previewTotal = Object.values(autoAssignPreview.amounts).reduce((s, v) => s + (Number(v) || 0), 0);
        const previewRemaining = globalFree - previewTotal;
        return (
          <Modal title={`✨ Auto-Assign — ${keyLabel(autoAssignPreview.cascadeContext ? autoAssignPreview.cascadeContext.nextM : month)}`} onClose={() => setAutoAssignPreview(null)}>
            <div style={{ fontSize: 13, color: C.textLight, marginBottom: 12, lineHeight: 1.6 }}>
              Review the suggested amounts below. Tap any amount to adjust it before confirming.
            </div>
            <div style={{ background: C.surface, borderRadius: 10, border: `1px solid ${C.border}`, overflow: "hidden", marginBottom: 14 }}>
              {autoAssignPreview.result.assignments.map((a, i) => {
                const cat = budget.categories.find(c => c.id === a.categoryId);
                const amt = Number(autoAssignPreview.amounts[a.categoryId]) || 0;
                return (
                  <div key={a.categoryId} style={{ display: "flex", alignItems: "center", padding: "10px 14px", borderBottom: i < autoAssignPreview.result.assignments.length - 1 ? `1px solid ${C.border}` : "none" }}>
                    <div style={{ flex: 1, fontSize: 14, fontWeight: 600 }}>{cat?.name || "Unknown"}</div>
                    <div onClick={e => e.stopPropagation()}>
                      <AmountInput
                        initialValue={amt || undefined}
                        onCommit={val => setAutoAssignPreview(p => ({ ...p, amounts: { ...p.amounts, [a.categoryId]: Math.max(0, val) } }))}
                        style={{ width: 90, border: "none", outline: "none", boxShadow: "none", WebkitAppearance: "none", fontSize: 14, fontWeight: 700, fontFamily: "inherit", background: "transparent", textAlign: "right", color: C.navy, cursor: "pointer", padding: "2px 0", WebkitUserSelect: "none", userSelect: "none", caretColor: "transparent" }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, fontWeight: 700, padding: "8px 0", borderTop: `1px solid ${C.border}`, marginBottom: 16 }}>
              <span>Remaining RTA after assignment</span>
              <span style={{ color: previewRemaining < 0 ? C.red : C.green }}>{fmt(previewRemaining)}</span>
            </div>
            {previewRemaining < -0.001 && <div style={{ fontSize: 12, color: C.red, marginBottom: 10 }}>Total exceeds your Ready to Assign — reduce one or more amounts.</div>}
            <div style={{ display: "flex", gap: 10 }}>
              <Btn outline color={C.muted} onClick={() => setAutoAssignPreview(null)} style={{ flex: 1 }}>Cancel</Btn>
              <Btn color={C.green} onClick={confirmAutoAssign} disabled={previewRemaining < -0.001 || previewTotal <= 0} style={{ flex: 1 }}>Confirm & Assign</Btn>
            </div>
          </Modal>
        );
      })()}

      {savingsPrompt && (
        <Modal title="💰 Fund Savings Goals?" onClose={skipSavingsFund}>
          <div style={{ fontSize: 15, color: C.textLight, lineHeight: 1.7, marginBottom: 16 }}>
            You have <strong style={{ color: C.green }}>{fmt(savingsPrompt.remaining)}</strong> left over after funding this month's other goals. Enter how much to put toward any savings goals below — these aren't filled automatically.
          </div>
          {savingsPrompt.goals.map(g => (
            <div key={g.id} style={{ marginBottom: 12 }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                <span style={{ fontSize: 13, fontWeight: 700 }}>{g.name}</span>
                <span style={{ fontSize: 12, color: C.textLight }}>{fmt(g.current)} of {fmt(g.target)} · needs {fmt(g.need)}</span>
              </div>
              <AmountInput
                initialValue={savingsPrompt.amounts[g.id] || undefined}
                placeholder="0.00"
                onChange={val => setSavingsAmount(g.id, Math.max(0, Math.min(val, g.need)))}
                onCommit={val => setSavingsAmount(g.id, Math.max(0, Math.min(val, g.need)))}
              />
            </div>
          ))}
          <div style={{ display: "flex", justifyContent: "space-between", padding: "10px 0", borderTop: `1px solid ${C.border}`, marginTop: 8, fontSize: 13, fontWeight: 700 }}>
            <span>Remaining after allocations</span>
            <span style={{ color: savingsRemainingAfter < 0 ? C.red : C.green }}>{fmt(savingsRemainingAfter)}</span>
          </div>
          {savingsRemainingAfter < 0 && <div style={{ fontSize: 12, color: C.red, marginBottom: 8 }}>You've allocated more than what's available — reduce one or more amounts.</div>}
          <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
            <Btn outline color={C.muted} onClick={skipSavingsFund} style={{ flex: 1 }}>Skip</Btn>
            <Btn color={C.green} onClick={confirmSavingsFund} disabled={savingsRemainingAfter < -0.001 || savingsAllocatedTotal <= 0} style={{ flex: 1 }}>Assign & Continue</Btn>
          </div>
        </Modal>
      )}

      {/* Clawback prompt — assigning more than is truly free */}
      {clawbackPrompt && (
        clawbackPrompt.insufficient ? (
          <Modal title="🚫 Not Enough Money" onClose={() => setClawbackPrompt(null)}>
            <div style={{ fontSize: 15, color: C.textLight, lineHeight: 1.7, marginBottom: 16 }}>
              That change needs <strong style={{ color: C.red }}>{fmt(clawbackPrompt.shortfall)}</strong> more than is truly free right now, but only <strong>{fmt(clawbackPrompt.available)}</strong> is assigned in future months that could be freed up.
            </div>
            <div style={{ fontSize: 13, color: C.textLight, marginBottom: 16 }}>This change can't be made — you'd be assigning money you don't have.</div>
            <Btn color={C.navy} onClick={() => setClawbackPrompt(null)} style={{ width: "100%" }}>OK</Btn>
          </Modal>
        ) : (
          <Modal title="💎 Free Up Money From Future Months?" onClose={() => setClawbackPrompt(null)}>
            <div style={{ fontSize: 15, color: C.textLight, lineHeight: 1.7, marginBottom: 16 }}>
              This change to <strong>{clawbackPrompt.catName}</strong> needs <strong style={{ color: C.red }}>{fmt(clawbackPrompt.shortfall)}</strong> more than is truly free right now — that much is already assigned in future months.
            </div>
            <div style={{ fontSize: 12, fontWeight: 700, color: C.muted, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6 }}>Unassign to cover it:</div>
            {clawbackPrompt.plan.map((p, i) => (
              <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "5px 0", fontSize: 13, borderBottom: i < clawbackPrompt.plan.length - 1 ? `1px solid #F4F1EB` : "none" }}>
                <span>{p.categoryName} <span style={{ color: C.muted }}>· {keyLabelShort(p.month)}</span></span>
                <span style={{ fontWeight: 700, color: C.red }}>-{fmt(p.amount)}</span>
              </div>
            ))}
            <div style={{ display: "flex", justifyContent: "space-between", padding: "8px 0 0", marginTop: 6, borderTop: `2px solid ${C.border}`, fontSize: 13, fontWeight: 800 }}>
              <span>Total Unassigned</span><span>{fmt(clawbackPrompt.shortfall)}</span>
            </div>
            <div style={{ display: "flex", gap: 10, marginTop: 20 }}>
              <Btn outline color={C.muted} onClick={() => setClawbackPrompt(null)} style={{ flex: 1 }}>No, Cancel</Btn>
              <Btn color={C.purple} onClick={confirmClawback} style={{ flex: 1 }}>Yes, Free It Up</Btn>
            </div>
          </Modal>
        )
      )}

      {/* Cascade prompt */}
      {cascadePrompt && (
        <Modal title="🎉 This Month's Goals Funded!" onClose={cascadeStop}>
          <div style={{ fontSize: 15, color: C.textLight, lineHeight: 1.7, marginBottom: 16 }}>
            All goals for <strong>{keyLabel(cascadePrompt.fromMonth)}</strong> are fully funded. You still have <strong style={{ color: C.green }}>{fmt(cascadePrompt.remaining)}</strong> left to assign.
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <Btn color={C.green} onClick={cascadeFundAll}>🚀 Fund All Future Months</Btn>
            <Btn outline color={C.navy} onClick={cascadeNextMonth}>Continue → {keyLabel(nextKey(cascadePrompt.fromMonth))} Only</Btn>
            <Btn outline color={C.muted} onClick={cascadeStop}>Stop Here</Btn>
          </div>
        </Modal>
      )}

      {/* Recap */}
      {recapData && <RecapModal months={recapData} onClose={() => setRecapData(null)} />}

      {/* Category monthly note modal */}
      {catNoteModal && (
        <CatNoteModal
          cat={budget.categories.find(c => c.id === catNoteModal.catId)}
          month={catNoteModal.month}
          existing={budget.categoryNotes?.[catNoteModal.month]?.[catNoteModal.catId] || ""}
          onSave={(noteVal) => {
            const mk = catNoteModal.month;
            const newNotes = { ...(budget.categoryNotes || {}), [mk]: { ...(budget.categoryNotes?.[mk] || {}), [catNoteModal.catId]: noteVal.trim() } };
            if (!noteVal.trim()) delete newNotes[mk][catNoteModal.catId];
            updateBudget({ categoryNotes: newNotes });
            setCatNoteModal(null);
          }}
          onClose={() => setCatNoteModal(null)}
        />
      )}

      {/* Money Move History modal */}
      {showMoveLog && (() => {
        const log = [...(budget.moneyMoveLog || [])].filter(e => e.month === month).reverse();
        const typeLabel = (type) => type === "cover" ? "Cover Overspending" : type === "cover-future" ? "Cover from Future Months" : type === "assign" ? "Budget Assignment" : "Move Money";
        const typeColor = (type) => type === "cover" || type === "cover-future" ? C.red : type === "assign" ? C.green : C.purple;
        return (
          <Modal title={`📋 Move History — ${keyLabel(month)}`} onClose={() => setShowMoveLog(false)}>
            <div style={{ maxHeight: "55vh", overflowY: "auto" }}>
              {log.length === 0 ? (
                <div style={{ textAlign: "center", padding: "20px", color: C.muted }}>No moves recorded for {keyLabel(month)}.</div>
              ) : log.map((entry, i) => (
                <div key={i} style={{ borderBottom: `1px solid #F4F1EB`, paddingBottom: 10, marginBottom: 10 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                    <span style={{ fontSize: 10, fontWeight: 700, color: typeColor(entry.type), textTransform: "uppercase", letterSpacing: "0.06em", background: `${typeColor(entry.type)}18`, borderRadius: 4, padding: "2px 6px" }}>{typeLabel(entry.type)}</span>
                    <span style={{ fontSize: 11, color: C.muted }}>Moved on: {new Date(entry.ts).toLocaleDateString("en-US", { month: "short", day: "numeric" })} {new Date(entry.ts).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}</span>
                  </div>
                  {(entry.entries || []).map((e, j) => (
                    <div key={j} style={{ fontSize: 13, color: C.text, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", paddingLeft: 4, marginTop: 3 }}>
                      <span style={{ color: C.muted }}>{getCatName(e.from)}</span>
                      <span style={{ color: C.muted }}>→</span>
                      <span style={{ fontWeight: 600 }}>{getCatName(e.to)}</span>
                      <span style={{ marginLeft: "auto", fontWeight: 700, color: C.green }}>{fmt(e.amount)}</span>
                    </div>
                  ))}
                </div>
              ))}
            </div>
            <Btn outline color={C.muted} onClick={() => setShowMoveLog(false)} style={{ width: "100%", marginTop: 12 }}>Close</Btn>
          </Modal>
        );
      })()}

      {/* Cover Overspending modal */}
      {coverOverspendModal && (
        <CoverOverspendingModal
          budget={budget}
          targetMonth={coverOverspendModal.targetMonth}
          getAvailable={(catId, mk) => getAvailableFast(catId, mk)}
          rtaAvailable={Math.max(0, globalFree)}
          onCover={coverOverspending}
          onClose={() => setCoverOverspendModal(null)}
          cascadeNote={coverOverspendModal.cascadeNote}
        />
      )}

      {/* Account archive/delete balance resolution */}
      {pendingAccountAction && (() => {
        const { id, isCard, action, name, balance, blocked } = pendingAccountAction;
        const absBalance = Math.abs(balance);
        const actionLabel = action === "archive" ? "Archive" : "Delete";

        // Card with non-zero balance — hard block
        if (pendingAccountAction.blockedByUncat) {
          return (
            <Modal title={`Cannot ${actionLabel} "${name}"`} onClose={() => setPendingAccountAction(null)}>
              <div style={{ fontSize: 14, color: C.textLight, lineHeight: 1.7, marginBottom: 16 }}>
                <strong>{pendingAccountAction.uncatCount} transaction{pendingAccountAction.uncatCount !== 1 ? "s" : ""}</strong> on this account {pendingAccountAction.uncatCount !== 1 ? "are" : "is"} missing a category or have an unconfirmed category. All transactions must be categorized and confirmed before you can {actionLabel.toLowerCase()} it.
              </div>
              <div style={{ display: "flex", gap: 10 }}>
                <Btn outline color={C.muted} onClick={() => setPendingAccountAction(null)} style={{ flex: 1 }}>Cancel</Btn>
                <Btn color={C.navy} onClick={() => { setPendingAccountAction(null); setTxFilters({ ...blankTxFilters(), accountId: pendingAccountAction.id, categoryId: UNCONFIRMED_FILTER }); setShowTxFilters(true); setTxSearch(""); setNav("transactions"); }} style={{ flex: 1 }}>Review Transactions</Btn>
              </div>
            </Modal>
          );
        }

        if (blocked) {
          return (
            <Modal title={`Cannot ${actionLabel} "${name}"`} onClose={() => setPendingAccountAction(null)}>
              <div style={{ fontSize: 14, color: C.textLight, lineHeight: 1.7, marginBottom: 16 }}>
                <strong>{name}</strong> still has <strong style={{ color: C.red }}>{fmt(absBalance)}</strong> owed, but your payment category only has <strong style={{ color: C.amber }}>{fmt(pendingAccountAction.setAside)}</strong> set aside — a shortfall of <strong style={{ color: C.red }}>{fmt(pendingAccountAction.shortfall)}</strong>.
              </div>
              <div style={{ fontSize: 13, color: C.muted, lineHeight: 1.6, marginBottom: 20 }}>
                Budget an additional <strong>{fmt(pendingAccountAction.shortfall)}</strong> to the {name} payment category, then pay off the card balance before attempting to {actionLabel.toLowerCase()} it.
              </div>
              <Btn color={C.navy} onClick={() => setPendingAccountAction(null)} style={{ width: "100%" }}>OK</Btn>
            </Modal>
          );
        }
        // All non-zero bank accounts route through AccountBalanceResolutionModal
        return (
          <AccountBalanceResolutionModal
            budget={budget}
            id={id}
            isCard={isCard}
            action={action}
            name={name}
            absBalance={absBalance}
            globalFree={globalFree}
            spentByMonthCat={spentByMonthCat}
            appendMoveLog={appendMoveLog}
            archiveAccount={archiveAccount}
            updateBudget={updateBudget}
            triggerTransferRef={triggerTransferRef}
            getAccountBalance={getAccountBalance}
            onClose={() => setPendingAccountAction(null)}
          />
        );
      })()}

      {/* Expired by-date goals modal — un-bypassable until resolved */}
      {expiredGoalCats.length > 0 && showExpiredGoals && (
        <ExpiredGoalsModal
          expiredCats={expiredGoalCats}
          budget={budget}
          updateBudget={updateBudget}
          onAllResolved={() => setShowExpiredGoals(false)}
        />
      )}

      {/* Auto-assign blocked warning when expired goals exist */}
      {showAutoAssignWarning && (
        <Modal title="⚠️ Expired Goals" onClose={() => setShowAutoAssignWarning(false)}>
          <div style={{ fontSize: 13, color: C.textLight, marginBottom: 16, lineHeight: 1.6 }}>
            Auto-Assign can't run until all expired target-by-date goals are resolved. Please update or remove them first.
          </div>
          <div style={{ display: "flex", gap: 10 }}>
            <Btn outline color={C.muted} onClick={() => setShowAutoAssignWarning(false)} style={{ flex: 1 }}>Cancel</Btn>
            <Btn color={C.navy} onClick={() => { setShowAutoAssignWarning(false); setShowExpiredGoals(true); }} style={{ flex: 1 }}>Resolve Goals →</Btn>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ── Root ─────────────────────────────────────────────────────
export default function App() {
  const [appData, setAppData] = useState(null);
  const [userAccount, setUserAccount] = useState(undefined); // undefined = loading, null = none found
  const [undoStack, setUndoStack] = useState([]);
  const [redoStack, setRedoStack] = useState([]);
  const appDataRef = useRef(null);
  useEffect(() => { appDataRef.current = appData; }, [appData]);

  // Prevent zoom on mobile — inject viewport meta and CSS touch-action
  useEffect(() => {
    let meta = document.querySelector("meta[name=viewport]");
    if (!meta) { meta = document.createElement("meta"); meta.name = "viewport"; document.head.appendChild(meta); }
    meta.content = "width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no";
    const style = document.createElement("style");
    style.id = "clearbudget-nozoom";
    style.textContent = `html, body { touch-action: pan-x pan-y; } #root { height: 100%; }`;
    document.head.appendChild(style);
    return () => { document.head.removeChild(style); };
  }, []);
  useEffect(() => {
    const style = document.createElement("style");
    style.textContent = `
      *, *::before, *::after {
        -webkit-user-select: none;
        user-select: none;
        -webkit-touch-callout: none;
      }
      input, textarea, select, [contenteditable="true"] {
        font-size: 16px !important;
        -webkit-user-select: text !important;
        user-select: text !important;
        -webkit-touch-callout: default !important;
        caret-color: #1A2B4A !important;
        color: #1A2035 !important;
      }
      input:focus, textarea:focus, select:focus {
        outline: 2px solid #1A2B4A !important;
        outline-offset: 1px !important;
        border-color: #1A2B4A !important;
      }
      input::selection, textarea::selection {
        background: rgba(26, 43, 74, 0.25) !important;
        color: #1A2035 !important;
      }
      input::-webkit-selection, textarea::-webkit-selection {
        background: rgba(26, 43, 74, 0.25) !important;
      }
      input[type="text"], input[type="number"], input[type="email"], input:not([type]), textarea {
        -webkit-autocomplete: off;
      }
    `;
    document.head.appendChild(style);
    return () => document.head.removeChild(style);
  }, []);

  // Select all text in any text-like input/textarea when it gains focus, for quick edit/replace
  useEffect(() => {
    const SELECTABLE_TYPES = ["text", "search", "tel", "url", "email", "number", "password"];
    const handler = (e) => {
      const el = e.target;
      if (!el || !el.value) return;
      if (el.tagName === "TEXTAREA" || (el.tagName === "INPUT" && SELECTABLE_TYPES.includes(el.type))) {
        requestAnimationFrame(() => { try { el.select(); } catch {} });
      }
    };
    document.addEventListener("focusin", handler);
    return () => document.removeEventListener("focusin", handler);
  }, []);


  useEffect(() => {
    (async () => {
      try { const r = await window.storage.get(STORAGE_KEY); setAppData(r ? migratePayeeModel(JSON.parse(r.value)) : { setupComplete: false, activeBudgetId: null, budgets: [] }); }
      catch { setAppData({ setupComplete: false, activeBudgetId: null, budgets: [] }); }
    })();
  }, []);

  useEffect(() => {
    (async () => {
      try { const r = await window.storage.get(USER_STORAGE_KEY); setUserAccount(r ? JSON.parse(r.value) : null); }
      catch { setUserAccount(null); }
    })();
  }, []);

  const saveUserAccount = useCallback(async (account) => {
    setUserAccount(account);
    try { await window.storage.set(USER_STORAGE_KEY, JSON.stringify(account)); }
    catch (e) { console.error(e); }
  }, []);

  const logOut = useCallback(async () => {
    setUserAccount(null);
    try { await window.storage.delete(USER_STORAGE_KEY); }
    catch (e) { console.error(e); }
  }, []);

  const save = useCallback(async (newData, skipUndo = false) => {
    if (!skipUndo && appDataRef.current?.setupComplete) {
      setUndoStack(h => [...h.slice(-29), appDataRef.current]);
      setRedoStack([]);
    }
    setAppData(newData);
    try { await window.storage.set(STORAGE_KEY, JSON.stringify(newData)); }
    catch (e) { console.error(e); }
  }, []);

  const undo = useCallback(() => {
    const current = appDataRef.current;
    setUndoStack(h => {
      if (h.length === 0) return h;
      const prev = h[h.length - 1];
      setRedoStack(r => [current, ...r.slice(0, 29)]);
      setAppData(prev);
      window.storage.set(STORAGE_KEY, JSON.stringify(prev)).catch(e => console.error(e));
      return h.slice(0, -1);
    });
  }, []);

  const redo = useCallback(() => {
    const current = appDataRef.current;
    setRedoStack(r => {
      if (r.length === 0) return r;
      const next = r[0];
      setUndoStack(h => [...h.slice(-29), current]);
      setAppData(next);
      window.storage.set(STORAGE_KEY, JSON.stringify(next)).catch(e => console.error(e));
      return r.slice(1);
    });
  }, []);

  if (userAccount === undefined || !appData) return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh", fontFamily: "system-ui", color: C.muted, flexDirection: "column", gap: 12 }}>
      <div style={{ fontSize: 44 }}>💰</div><div>Loading ClearBudget...</div>
    </div>
  );

  if (!userAccount) return <IdentityGate onComplete={saveUserAccount} />;

  if (!appData.setupComplete) return <AmountPadProvider><SetupWizard onComplete={d => save(d, true)} userAccount={userAccount} /></AmountPadProvider>;
  return <AmountPadProvider><MainApp appData={appData} onSave={save} onUndo={undo} canUndo={undoStack.length > 0} onRedo={redo} canRedo={redoStack.length > 0} userAccount={userAccount} onSaveUserAccount={saveUserAccount} onLogOut={logOut} /></AmountPadProvider>;
}
