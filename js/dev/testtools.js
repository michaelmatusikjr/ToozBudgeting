/** Isolated test tools. Loaded only when js/app.js includes the TEST TOOLS import. */
import { uid } from "../util.js?v=154";
import { importData } from "../store.js?v=154";

export function isTestBudget(b) {
  return !!b && String(b.id).startsWith("test-");
}

export function safeCommit(ctx, nextState) {
  const before = ctx.state?.budgets || [];
  const after = nextState?.budgets || [];
  const realBefore = before.filter((b) => !isTestBudget(b));
  const realAfter = after.filter((b) => !isTestBudget(b));
  if (realBefore.length !== realAfter.length) {
    throw new Error("safeCommit refused: a real budget was added or removed");
  }
  for (let i = 0; i < realBefore.length; i++) {
    if (realBefore[i] !== realAfter[i]) {
      throw new Error("safeCommit refused: a real budget changed");
    }
  }
  const beforeIds = realBefore.map((b) => b.id);
  const afterIds = realAfter.map((b) => b.id);
  if (beforeIds.join("\0") !== afterIds.join("\0")) {
    throw new Error("safeCommit refused: a real budget was added or removed");
  }
  return ctx.commit(nextState);
}

export function buildTestBudget() {
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

  const budget = {
    id: "test-" + uid(), name: "🧪 Test Budget", createdAt: new Date().toISOString(), archived: false,
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
  return { setupComplete: true, activeBudgetId: budget.id, budgets: [budget] };
}


export function testBudgetFromState(state) {
  return (state?.budgets || []).find(isTestBudget) || null;
}

export function asTestBudget(budget) {
  if (!budget) return budget;
  if (isTestBudget(budget)) return budget;
  return { ...budget, id: "test-" + (budget.id || uid()), name: budget.name || "🧪 Test Budget" };
}

function switchTo(ctx, budgetId, budgets) {
  return { ...ctx.state, setupComplete: true, activeBudgetId: budgetId, budgets, _testWizard: undefined };
}

/** Guest: replace this device's data with a JSX-shaped test backup (same path as Paste backup). */
export function applyLoadGuest(ctx) {
  const next = importData(buildTestBudget());
  if (typeof ctx.restore === "function") ctx.restore(next);
  else ctx.commit(next, { undo: false });
  return next;
}

/** Signed in: create or refill exactly one 🧪 Test Budget. Real budgets stay the same objects. */
export function applyLoadSignedIn(ctx) {
  if (ctx.readOnly?.()) throw new Error("View only people can't change budgets.");
  const existing = testBudgetFromState(ctx.state);
  const fresh = importData(buildTestBudget()).budgets[0];
  const budgets = [...(ctx.state.budgets || [])];
  if (existing) {
    fresh.id = existing.id;
    const next = budgets.map((b) => (b.id === existing.id ? fresh : b));
    safeCommit(ctx, switchTo(ctx, existing.id, next));
    return testBudgetFromState({ budgets: next });
  }
  const next = [...budgets, fresh];
  safeCommit(ctx, switchTo(ctx, fresh.id, next));
  return fresh;
}

/** Signed in: drop the test budget and mark the wizard so a new budget gets a test- id. */
export function applyResetTestBudget(ctx) {
  if (ctx.readOnly?.()) throw new Error("View only people can't change budgets.");
  const budgets = (ctx.state.budgets || []).filter((b) => !isTestBudget(b));
  const firstReal = budgets[0];
  safeCommit(ctx, {
    ...ctx.state,
    budgets,
    activeBudgetId: firstReal?.id || null,
    setupComplete: false,
    _testWizard: true,
  });
}

/** Signed in: remove only 🧪 Test Budget. */
export function applyDeleteTestBudget(ctx) {
  if (ctx.readOnly?.()) throw new Error("View only people can't change budgets.");
  const budgets = (ctx.state.budgets || []).filter((b) => !isTestBudget(b));
  const firstReal = budgets[0];
  safeCommit(ctx, {
    ...ctx.state,
    budgets,
    activeBudgetId: firstReal?.id || ctx.state.activeBudgetId,
    setupComplete: !!budgets.some((b) => !b.archived),
    _testWizard: undefined,
  });
}

function signedIn(ctx) {
  return !!ctx.account?.token;
}

async function installHooks() {
  if (typeof document === "undefined") return;
  const { devHooks, h, btn, toast, confirmModal } = await import("../ui.js?v=154");

  function card(host, title, body, buttons) {
    const box = h("div", { class: "card", style: "background:var(--amber-bg, #fff6e5);border-color:var(--gold,#c4a35a);color:var(--amber-ink, #5a3d00);" },
      h("h3", { style: "margin:0 0 8px;font-size:15px;font-weight:800;", text: title }),
      h("p", { class: "hint", text: body }),
      ...buttons,
    );
    host.append(box);
  }

  devHooks.wizardCard = (host, ctx) => {
    const guest = !signedIn(ctx);
    if (guest) {
      card(host, "🧪 Testing Tools", "Load a sample budget and skip the rest of the wizard.", [
        btn("📥 Load Test Data & Skip Wizard", { block: true, onClick: () => applyLoadGuest(ctx) }),
      ]);
      return;
    }
    const noBudget = !(ctx.state.budgets || []).length;
    if (noBudget) {
      card(host, "🧪 Testing Tools", "Create 🧪 Test Budget so you can try signed-in features. Real budgets are never touched.", [
        btn("📥 Load Test Data", { block: true, disabled: !!ctx.readOnly?.(), onClick: () => {
          try { applyLoadSignedIn(ctx); } catch (e) { toast(e.message); }
        } }),
      ]);
    }
  };

  devHooks.settingsCard = (host, ctx) => {
    const guest = !signedIn(ctx);
    const ro = !!ctx.readOnly?.();
    if (guest) {
      card(host, "🧪 Testing Tools", "Load sample data or restart the wizard. This affects only this device.", [
        btn("📥 Load Test Data", { block: true, onClick: () => applyLoadGuest(ctx) }),
        btn("🧪 Test Wizard (Erases Data)", { kind: "danger", block: true, onClick: async () => {
          const ok = await confirmModal({
            title: "🧪 Test Wizard (Erases Data)",
            body: "This erases all budgets on this device and opens the setup wizard. Export a backup first if you might want them back.",
            yes: "Erase and start wizard",
            no: "Cancel",
            danger: true,
          });
          if (ok) ctx.reset?.();
        } }),
      ]);
      return;
    }
    card(host, "🧪 Testing Tools", "These buttons work only on 🧪 Test Budget. Real budgets are never changed or erased.", [
      btn("📥 Load Test Data", { block: true, disabled: ro, onClick: () => {
        try { applyLoadSignedIn(ctx); } catch (e) { toast(e.message); }
      } }),
      btn("🧪 Test Wizard (Resets Test Budget)", { kind: "ghost", block: true, disabled: ro, onClick: async () => {
        const ok = await confirmModal({
          title: "🧪 Test Wizard (Resets Test Budget)",
          body: "This resets only 🧪 Test Budget. Your real budgets are not touched.",
          yes: "Reset test budget",
          no: "Cancel",
          danger: true,
        });
        if (ok) {
          try { applyResetTestBudget(ctx); } catch (e) { toast(e.message); }
        }
      } }),
      btn("🗑 Delete Test Budget", { kind: "danger", block: true, disabled: ro, onClick: async () => {
        const ok = await confirmModal({
          title: "Delete 🧪 Test Budget?",
          body: "This removes 🧪 Test Budget from the household. Your real budgets are not touched.",
          yes: "Delete",
          no: "Cancel",
          danger: true,
        });
        if (ok) {
          try { applyDeleteTestBudget(ctx); } catch (e) { toast(e.message); }
        }
      } }),
      ro ? h("p", { class: "hint", text: "View only people can't change budgets." }) : null,
    ]);
  };
}

installHooks().catch(() => {});
