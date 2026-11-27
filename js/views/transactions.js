import { h, btn, openSheet, field, textInput, toast, moneyButton, confirmDialog, keepFocus } from "../ui.js?v=139";
import { fmt, todayKey, toTitleCase, isCard, ccPayCat, makePayFrom, RTA } from "../util.js?v=139";
import { displayName, payeeDefaultCategory, payeeSuggestedCategory, findFuzzyDuplicates, isAccountPayee } from "../payees.js?v=139";
import { addTransaction, deleteTransactions, isLocked, setTxCategory, updateTransaction, replaceTransaction, confirmCategories } from "../mutate.js?v=139";
import { parseCSV, guessColumnMapping, applyMapping } from "../csv.js?v=139";

export function renderTransactions(root, ctx) {
  const budget = ctx.budget();
  const f = ctx.ui.txFilter;
  const q = (ctx.ui.txQuery || "").toLowerCase();
  let rows = [...(budget.transactions || [])].sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));
  if (f.accountId) rows = rows.filter((t) => t.accountId === f.accountId);
  if (f.categoryId) rows = rows.filter((t) => t.categoryId === f.categoryId || t.splits?.some((s) => s.categoryId === f.categoryId));
  if (f.type) rows = rows.filter((t) => t.type === f.type);
  if (f.dateFrom) rows = rows.filter((t) => t.date >= f.dateFrom);
  if (f.dateTo) rows = rows.filter((t) => t.date <= f.dateTo);
  if (f.month) {
    const range = monthRangeSafe(f.month);
    rows = rows.filter((t) => t.date >= range.from && t.date <= range.to);
  }
  if (f.groupId) {
    const ids = new Set((budget.categories || []).filter((c) => c.groupId === f.groupId).map((c) => c.id));
    rows = rows.filter((t) => ids.has(t.categoryId) || t.splits?.some((s) => ids.has(s.categoryId)));
  }
  if (f.hideReconciled) rows = rows.filter((t) => !t.reconciled && !isLocked(budget, t));
  if (f.attention) rows = rows.filter((t) => t.type === "expense" && !t.splits && (!t.categoryId || t.categoryConfirmed === false));
  if (f.amountOp && f.amount != null && f.amount !== "") {
    const n = Number(f.amount);
    rows = rows.filter((t) => {
      const a = Math.abs(Number(t.amount) || 0);
      if (f.amountOp === ">") return a > n + 0.001;
      if (f.amountOp === "<") return a < n - 0.001;
      return Math.abs(a - n) < 0.02;
    });
  }
  if (q) {
    rows = rows.filter((t) => {
      const name = displayName(budget, t.originalPayee || t.payee);
      const cat = budget.categories.find((c) => c.id === t.categoryId)?.name || "";
      return `${name} ${t.note || ""} ${cat} ${t.date}`.toLowerCase().includes(q);
    });
  }
  const selected = ctx.ui.selected;
  const sum = rows.reduce((s, t) => s + signedDisplay(budget, t), 0);

  const search = h("input", { class: "input", type: "search", placeholder: "Search payees, notes, categories", value: ctx.ui.txQuery || "", "aria-label": "Search transactions" });
  const typing = ctx.ui.txTyping;
  search.addEventListener("input", () => { ctx.ui.txQuery = search.value; ctx.ui.txTyping = true; ctx.render(); });

  const dups = (budget.pendingDuplicates || []).filter((p) => budget.transactions.some((t) => t.id === p.newTxId) && budget.transactions.some((t) => t.id === p.existingTxId));

  root.append(h("header", { class: "view-head" },
    h("h1", { text: "Activity" }),
    btn("Add", { onClick: () => openTx(ctx, null) }),
  ));
  root.append(h("div", { class: "search-row" }, search));
  root.append(h("nav", { class: "link-row", "aria-label": "Activity tools" },
    h("button", { class: "text-link", type: "button", text: "Filter", onclick: () => openFilters(ctx) }),
    h("button", { class: "text-link", type: "button", text: "Import", onclick: () => openImport(ctx) }),
    h("button", { class: "text-link", type: "button", text: "Select", onclick: () => { rows.forEach((t) => selected.add(t.id)); ctx.render(); } }),
  ));
  const chips = h("div", { class: "chip-row" });
  const chip = (label, key) => chips.append(h("button", { class: "pill", type: "button", text: `${label} ×`, onclick: () => { const next = { ...ctx.ui.txFilter }; delete next[key]; if (key === "amount") delete next.amountOp; ctx.ui.txFilter = next; ctx.render(); } }));
  if (f.accountId) chip("Account", "accountId");
  if (f.categoryId) chip("Category", "categoryId");
  if (f.groupId) chip("Group", "groupId");
  if (f.type) chip(f.type, "type");
  if (f.month) chip(f.month, "month");
  if (f.hideReconciled) chip("Hiding reconciled", "hideReconciled");
  if (f.attention) chip("Needs attention", "attention");
  if (f.amountOp) chip(`Amount ${f.amountOp} ${f.amount}`, "amount");
  if (q) chips.append(h("button", { class: "pill", type: "button", text: `“${ctx.ui.txQuery}” ×`, onclick: () => { ctx.ui.txQuery = ""; ctx.render(); } }));
  if (chips.childNodes.length) root.append(chips);
  if (f.accountId || f.categoryId || f.groupId || f.type || f.month || f.attention || f.hideReconciled || f.amountOp || q) {
    root.append(h("p", { class: "hint", text: `${rows.length} shown · net ${fmt(sum)}` }),
      btn("Clear filters", { kind: "quiet", onClick: () => { ctx.ui.txFilter = {}; ctx.ui.txQuery = ""; ctx.render(); } }));
  }
  if (dups.length) {
    root.append(h("button", { class: "notice", type: "button", onclick: () => openDupes(ctx) },
      h("strong", { text: `${dups.length} possible duplicate${dups.length === 1 ? "" : "s"}` }),
      h("span", { class: "notice-go", text: "Review" }),
    ));
  }
  if (selected.size) {
    root.append(h("div", { class: "bulk" },
      h("span", { text: `${selected.size} selected` }),
      btn("Category", { kind: "ghost", onClick: () => openBulkCat(ctx) }),
      btn("Confirm", { kind: "ghost", onClick: () => { ctx.updateBudget((b) => confirmCategories(b, [...selected])); selected.clear(); toast("Categories confirmed"); } }),
      btn("Delete", { kind: "danger", onClick: () => confirmDialog({
        title: "Delete transactions?",
        message: "Starting balances and reconciled transactions stay. Transfers delete both sides.",
        confirm: "Delete", danger: true,
        onConfirm: () => { ctx.updateBudget((b) => deleteTransactions(b, [...selected])); selected.clear(); toast("Deleted", { label: "Undo", action: () => ctx.undo() }); },
      }) }),
      btn("Done", { kind: "quiet", onClick: () => { selected.clear(); ctx.render(); } }),
    ));
  }
  const list = h("div", { class: "tx-list" });
  if (!rows.length) list.append(h("p", { class: "empty", text: (q || f.accountId || f.categoryId || f.type || f.month || f.groupId || f.attention || f.hideReconciled) ? "No transactions match." : "Nothing here yet. Add a transaction when money moves." }));
  const PAGE = 80;
  const filterKey = JSON.stringify({ f, q });
  if (ctx.ui.txFilterKey !== filterKey) {
    ctx.ui.txFilterKey = filterKey;
    ctx.ui.txLimit = PAGE;
  }
  const limit = ctx.ui.txLimit || PAGE;
  const shown = rows.slice(0, limit);
  for (const tx of shown) list.append(txRow(ctx, tx, selected));
  root.append(list);
  if (rows.length > shown.length) {
    root.append(h("p", { class: "hint", text: `Showing ${shown.length} of ${rows.length}` }),
      h("button", { class: "text-link", type: "button", text: "Show more", onclick: () => { ctx.ui.txLimit = limit + PAGE; ctx.render(); } }));
  }
  ctx.ui.searchEl = search;
  if (typing) { ctx.ui.txTyping = false; keepFocus(search); }
}

function signedDisplay(budget, tx) {
  const card = (budget.creditCards || []).some((c) => c.id === tx.accountId);
  if (tx.type === "income") return Math.abs(tx.amount);
  if (tx.type === "expense") return card ? -tx.amount : -tx.amount;
  if (tx.type === "transfer") return tx.amount;
  if (tx.type === "payment") {
    const card = (budget.creditCards || []).some((c) => c.id === tx.accountId);
    return card ? Math.abs(tx.amount) : -Math.abs(tx.amount);
  }
  return tx.amount;
}

function monthRangeSafe(k) {
  const [y, m] = k.split("-").map(Number);
  const last = new Date(y, m, 0).getDate();
  return { from: `${k}-01`, to: `${k}-${String(last).padStart(2, "0")}` };
}

function txRow(ctx, tx, selected) {
  const budget = ctx.budget();
  const name = tx.subtype === "starting_balance" ? "Starting Balance" : (displayName(budget, tx.originalPayee || tx.payee) || tx.payee || "—");
  const cat = tx.splits?.length ? "Split" : (budget.categories.find((c) => c.id === tx.categoryId)?.name || (tx.type === "income" ? "Ready to Assign" : "No category"));
  const acct = [...budget.accounts, ...budget.creditCards].find((a) => a.id === tx.accountId);
  const locked = isLocked(budget, tx);
  const row = h("article", { class: `tx ${selected.has(tx.id) ? "sel" : ""}` });
  let timer = null;
  row.addEventListener("contextmenu", (e) => { e.preventDefault(); selected.add(tx.id); ctx.render(); });
  row.addEventListener("touchstart", () => { timer = setTimeout(() => { selected.add(tx.id); ctx.render(); }, 480); }, { passive: true });
  row.addEventListener("touchend", () => clearTimeout(timer));
  const box = h("input", { type: "checkbox", checked: selected.has(tx.id), onclick: (e) => { e.stopPropagation(); if (e.target.checked) selected.add(tx.id); else selected.delete(tx.id); ctx.render(); } });
  if (selected.size) row.append(box);
  row.append(
    h("div", { class: "tx-body" },
      h("button", { class: "tx-main", type: "button", onclick: () => { if (selected.size) { if (selected.has(tx.id)) selected.delete(tx.id); else selected.add(tx.id); ctx.render(); } else openTx(ctx, tx); } },
        h("span", { class: "tx-top" },
          h("span", { class: "tx-payee", text: name }),
          h("span", { class: amountClass(budget, tx), text: amountLabel(budget, tx) }),
        ),
        h("span", { class: "muted", text: `${tx.date} · ${acct?.name || "No account"}` }),
      ),
      h("div", { class: "tx-sub" },
        h("button", { class: `pill ${tx.categoryConfirmed === false ? "bad" : ""}`, type: "button", text: tx.categoryConfirmed === false ? `${cat} · confirm` : cat, disabled: !!locked, onclick: (e) => { e.stopPropagation(); openInlineCat(ctx, tx); } }),
        tx.type === "payment" ? h("button", { class: `quiet-link ${tx.paymentLinkStatus === "linked" ? "" : "bad"}`, type: "button", text: tx.paymentLinkStatus === "linked" ? "Linked" : "Other side", onclick: (e) => { e.stopPropagation(); if (tx.paymentLinkStatus === "linked") return; openMissingSide(ctx, tx); } }) : null,
      ),
    ),
  );
  return row;
}

function amountClass(budget, tx) {
  if (tx.type === "income") return "tx-amt in";
  if (tx.type === "expense") return Number(tx.amount) < 0 ? "tx-amt in" : "tx-amt out";
  if (tx.type === "transfer") return Number(tx.amount) < 0 ? "tx-amt out" : "tx-amt in";
  if (tx.type === "payment") return (budget.creditCards || []).some((c) => c.id === tx.accountId) ? "tx-amt in" : "tx-amt out";
  return "tx-amt";
}

export function openMissingSide(ctx, tx) {
  const budget = ctx.budget();
  const card = isCard(budget, tx.accountId);
  if (card) {
    const from = tx.paymentFromAccountId || budget.accounts.find((a) => !a.archived)?.id;
    const pay = ccPayCat(budget, tx.accountId);
    if (!from || !pay) { toast("Pick the bank account on the card payment first"); return; }
    openTx(ctx, { draft: true, date: tx.date, amount: Math.abs(tx.amount), accountId: from, categoryId: pay.id, type: "payment", payee: "" });
    return;
  }
  const cat = (budget.categories || []).find((c) => c.id === tx.categoryId);
  if (!cat?.creditCardId) { toast("This payment isn’t tied to a card"); return; }
  openTx(ctx, { draft: true, date: tx.date, amount: Math.abs(tx.amount), accountId: cat.creditCardId, categoryId: makePayFrom(tx.accountId), type: "payment", payee: "" });
}

function amountLabel(budget, tx) {
  if (tx.type === "income") return fmt(Math.abs(tx.amount));
  if (tx.type === "expense") return fmt(-Number(tx.amount));
  if (tx.type === "transfer") return fmt(Number(tx.amount));
  if (tx.type === "payment") return isCard(budget, tx.accountId) ? fmt(Math.abs(tx.amount)) : fmt(-Math.abs(tx.amount));
  return fmt(tx.amount);
}

function openInlineCat(ctx, tx) {
  const budget = ctx.budget();
  const sheet = openSheet({
    title: "Category",
    body: (host) => {
      const sel = categorySelect(budget, tx.accountId, true);
      sel.value = tx.categoryId || (tx.type === "income" ? RTA : "");
      host.append(sel, btn("Save", { block: true, onClick: () => {
        const v = sel.value;
        if (v === RTA) ctx.updateBudget((b) => updateTransaction(b, tx.id, { type: "income", categoryId: null, splits: undefined, amount: Math.abs(tx.amount) }));
        else ctx.updateBudget((b) => setTxCategory(b, tx.id, v));
        sheet.close();
      }}));
    },
  });
}

function categorySelect(budget, accountId, includeRta) {
  const sel = h("select", { class: "input" });
  sel.append(h("option", { value: "", text: "No category" }));
  if (includeRta) sel.append(h("option", { value: RTA, text: "Ready to Assign (income)" }));
  const card = (budget.creditCards || []).some((c) => c.id === accountId);
  if (card) {
    for (const a of budget.accounts.filter((a) => !a.archived)) sel.append(h("option", { value: makePayFrom(a.id), text: `Payment from ${a.name}` }));
  }
  for (const g of budget.categoryGroups) {
    const og = h("optgroup", { label: g.name });
    for (const c of budget.categories.filter((c) => c.groupId === g.id && !c.archived)) {
      if (card && c.creditCardId) continue;
      og.append(h("option", { value: c.id, text: c.name }));
    }
    sel.append(og);
  }
  return sel;
}

export function openTx(ctx, existing) {
  const budget = ctx.budget();
  if (existing?.subtype === "starting_balance") { toast("Starting balances can’t be edited or deleted"); return; }
  const editing = !!(existing?.id && !existing.draft);
  const locked = editing && isLocked(budget, existing);
  const form = {
    date: existing?.date || todayKey(),
    payee: existing ? displayName(budget, existing.originalPayee || existing.payee) : "",
    note: existing?.note || "",
    amount: existing ? Math.abs(Number(existing.amount) || 0) : 0,
    isRefund: existing?.type === "expense" && Number(existing.amount) < 0,
    accountId: existing?.accountId || budget.accounts.find((a) => !a.archived)?.id || "",
    categoryId: existing?.type === "income" ? RTA : (existing?.categoryId || ""),
    transferAccountId: existing?.transferAccountId || "",
    splits: existing?.splits ? existing.splits.map((s) => ({ ...s, amount: Math.abs(s.amount) })) : null,
    type: existing?.type || "expense",
  };
  const sheet = openSheet({
    title: existing?.draft ? "Enter the other side" : (editing ? "Edit transaction" : "New transaction"),
    body: (host) => {
      const date = h("input", { class: "input", type: "date", value: form.date });
      date.addEventListener("change", () => { form.date = date.value; });
      const payee = textInput({ value: form.payee, placeholder: "Payee" });
      const suggest = h("div", { class: "suggest" });
      const refreshSug = () => {
        suggest.replaceChildren();
        const q = payee.value.trim().toLowerCase();
        if (q.length < 1) return;
        const names = [...new Set((budget.transactions || []).map((t) => displayName(budget, t.originalPayee || t.payee)).filter((n) => n && !isAccountPayee(budget, n)))];
        for (const n of names.filter((n) => n.toLowerCase().includes(q)).slice(0, 6)) {
          suggest.append(h("button", { type: "button", class: "sug", text: n, onclick: () => {
            payee.value = n; form.payee = n;
            const def = payeeDefaultCategory(budget, n) || payeeSuggestedCategory(budget, n);
            if (def) { form.categoryId = def; form.categoryConfirmed = !!payeeDefaultCategory(budget, n); cat.value = def; }
            suggest.replaceChildren();
          }}));
        }
      };
      payee.addEventListener("input", () => { form.payee = payee.value; refreshSug(); });
      const acct = h("select", { class: "input" });
      for (const a of budget.accounts) if (!a.archived || a.id === form.accountId) acct.append(h("option", { value: a.id, text: a.name }));
      for (const c of budget.creditCards) if (!c.archived || c.id === form.accountId) acct.append(h("option", { value: c.id, text: c.name + " (card)" }));
      acct.value = form.accountId;
      const catSlot = h("div", { class: "cat-slot" });
      let cat = categorySelect(budget, form.accountId, true);
      const bindCat = (node, prev) => {
        cat = node;
        if (prev) cat.value = prev;
        form.categoryId = cat.value;
        cat.addEventListener("change", () => { form.categoryId = cat.value; });
        catSlot.replaceChildren(cat);
      };
      bindCat(cat, form.categoryId || "");
      const transfer = h("select", { class: "input" });
      const fillTransfer = () => {
        transfer.replaceChildren(h("option", { value: "", text: "Not a transfer" }));
        for (const a of [...budget.accounts, ...budget.creditCards]) {
          if (a.archived || a.id === form.accountId) continue;
          transfer.append(h("option", { value: a.id, text: a.name }));
        }
        transfer.value = form.transferAccountId || "";
      };
      acct.addEventListener("change", () => {
        form.accountId = acct.value;
        bindCat(categorySelect(budget, form.accountId, true), form.categoryId);
        fillTransfer();
      });
      fillTransfer();
      transfer.addEventListener("change", () => { form.transferAccountId = transfer.value; form.type = transfer.value ? "transfer" : "expense"; });
      const splitsBox = h("div");
      const paintSplits = () => {
        splitsBox.replaceChildren();
        if (!form.splits) return;
        for (const sp of form.splits) {
          const sel = categorySelect(budget, form.accountId, false);
          sel.value = sp.categoryId || "";
          sel.addEventListener("change", () => { sp.categoryId = sel.value; });
          splitsBox.append(h("div", { class: "line" }, sel, moneyButton(sp.amount, (n) => { sp.amount = n; })));
        }
        splitsBox.append(btn("Add split line", { kind: "quiet", onClick: () => { form.splits.push({ categoryId: "", amount: 0 }); paintSplits(); } }));
      };
      host.append(
        existing?.draft ? h("p", { class: "lede", text: "This is the missing side of a card payment. Check the account and category, then add it." }) : null,
        field("Date", date),
        field("Payee", payee),
        suggest,
        field("Account", acct),
        field("Category", catSlot),
        field("Transfer to", transfer),
        field("Amount", moneyButton(form.amount, (n) => { form.amount = Math.abs(n); form.isRefund = n < 0; })),
        h("p", { class: "hint", text: "Use the pad’s math keys, or toggle refund for a negative expense." }),
        btn(form.splits ? "Use one category" : "Split", { kind: "ghost", onClick: () => {
          form.splits = form.splits ? null : [{ categoryId: form.categoryId, amount: form.amount }];
          paintSplits();
        }}),
        splitsBox,
        field("Note", (() => { const t = h("textarea", { class: "input", rows: "2" }); t.value = form.note; t.addEventListener("input", () => { form.note = t.value; }); return t; })()),
      );
      paintSplits();
        if (!locked) {
        host.append(btn(editing ? "Save" : "Add", { block: true, onClick: () => {
          if (form.splits?.length) {
            const sum = form.splits.reduce((s, sp) => s + Math.abs(Number(sp.amount) || 0), 0);
            if (Math.abs(sum - Math.abs(form.amount)) > 0.02) { toast("Splits have to add up to the amount"); return; }
            if (form.splits.some((sp) => !sp.categoryId)) { toast("Each split needs a category"); return; }
          }
          const payload = { ...form, payee: form.payee, type: form.transferAccountId ? "transfer" : (form.categoryId === RTA ? "income" : form.type) };
          ctx.updateBudget((b) => {
            const res = editing ? replaceTransaction(b, existing.id, payload) : addTransaction(b, payload);
            if (res.error) { toast(res.error); return b; }
            sheet.close();
            toast(editing ? "Saved" : "Added", { label: "Undo", action: () => ctx.undo() });
            return res.budget;
          });
        }}));
      } else host.append(h("p", { class: "hint", text: "Reconciled transactions can’t be deleted. You can still edit the note." }));
      if (editing && !locked) host.append(btn("Delete", { kind: "danger", block: true, onClick: () => {
        ctx.updateBudget((b) => deleteTransactions(b, [existing.id]));
        sheet.close();
        toast("Deleted", { label: "Undo", action: () => ctx.undo() });
      }}));
    },
  });
}

function openFilters(ctx) {
  const f = ctx.ui.txFilter;
  const budget = ctx.budget();
  const sheet = openSheet({
    title: "Filters",
    body: (host) => {
      const acct = h("select", { class: "input" }, h("option", { value: "", text: "All accounts" }));
      for (const a of [...budget.accounts, ...budget.creditCards]) acct.append(h("option", { value: a.id, text: a.name }));
      acct.value = f.accountId || "";
      const type = h("select", { class: "input" },
        h("option", { value: "", text: "All types" }),
        h("option", { value: "expense", text: "Expense" }),
        h("option", { value: "income", text: "Income" }),
        h("option", { value: "transfer", text: "Transfer" }),
        h("option", { value: "payment", text: "Payment" }),
      );
      type.value = f.type || "";
      const from = h("input", { class: "input", type: "date", value: f.dateFrom || "" });
      const to = h("input", { class: "input", type: "date", value: f.dateTo || "" });
      const op = h("select", { class: "input" },
        h("option", { value: "", text: "Any amount" }),
        h("option", { value: ">", text: "Greater than" }),
        h("option", { value: "=", text: "Equal to" }),
        h("option", { value: "<", text: "Less than" }),
      );
      op.value = f.amountOp || "";
      const amt = h("input", { class: "input", inputmode: "decimal", value: f.amount ?? "", placeholder: "0.00" });
      const hide = h("input", { type: "checkbox", checked: !!f.hideReconciled });
      const attn = h("input", { type: "checkbox", checked: !!f.attention });
      host.append(field("Account", acct), field("Type", type), field("From", from), field("To", to), field("Amount", op), field("Amount value", amt),
        h("label", { class: "choice" }, hide, h("span", { text: "Hide reconciled" })),
        h("label", { class: "choice" }, attn, h("span", { text: "Needs a category or confirmation" })),
        btn("Apply", { block: true, onClick: () => {
          ctx.ui.txFilter = { ...f, accountId: acct.value, type: type.value, dateFrom: from.value, dateTo: to.value, amountOp: op.value, amount: amt.value, hideReconciled: hide.checked, attention: attn.checked };
          sheet.close(); ctx.render();
        }}));
    },
  });
}

function openImport(ctx) {
  const budget = ctx.budget();
  const sheet = openSheet({
    title: "Import CSV",
    body: (host) => {
      const acct = h("select", { class: "input" });
      for (const a of [...budget.accounts, ...budget.creditCards].filter((a) => !a.archived)) acct.append(h("option", { value: a.id, text: a.name }));
      const file = h("input", { type: "file", accept: ".csv,text/csv" });
      const mapBox = h("div");
      host.append(field("Account", acct), field("CSV file", file), mapBox);
      file.addEventListener("change", async () => {
        const f = file.files?.[0]; if (!f) return;
        const rows = parseCSV(await f.text());
        if (rows.length < 2) { toast("No rows in that file"); return; }
        const headers = rows[0];
        const remembered = budget.csvMappings?.[acct.value];
        const mapping = remembered || guessColumnMapping(headers);
        mapBox.replaceChildren();
        const selects = {};
        const make = (label, key) => {
          const sel = h("select", { class: "input" }, h("option", { value: "", text: "—" }));
          headers.forEach((hd) => sel.append(h("option", { value: hd, text: hd })));
          sel.value = mapping[key] || "";
          selects[key] = sel;
          mapBox.append(field(label, sel));
        };
        make("Date", "dateCol"); make("Payee", "payeeCol"); make("Amount", "amountCol"); make("Debit", "debitCol"); make("Credit", "creditCol");
        const sign = h("select", { class: "input" },
          h("option", { value: "neg-expense", text: "Negative amounts are expenses" }),
          h("option", { value: "pos-expense", text: "Positive amounts are expenses" }),
        );
        sign.value = mapping.signConvention || "neg-expense";
        const mode = h("select", { class: "input" },
          h("option", { value: "single", text: "One amount column" }),
          h("option", { value: "split", text: "Separate debit and credit" }),
        );
        mode.value = mapping.amountMode || "single";
        mapBox.append(field("Amount style", mode), field("Sign", sign));
        const review = h("div", { class: "stack" });
        mapBox.append(h("p", { class: "kicker", text: "Review" }), review);
        const mappingNow = () => ({
          dateCol: selects.dateCol.value, payeeCol: selects.payeeCol.value, amountCol: selects.amountCol.value,
          debitCol: selects.debitCol.value, creditCol: selects.creditCol.value,
          amountMode: mode.value, signConvention: sign.value,
        });
        const parsedRows = () => rows.slice(1).map((r) => applyMapping(r, headers, mappingNow())).filter((p) => p.date && p.amount);
        let draft = [];
        const paintReview = () => {
          review.replaceChildren();
          draft = parsedRows();
          if (!draft.length) { review.append(h("p", { class: "hint", text: "No dated amounts with the columns selected." })); return; }
          draft.forEach((p, i) => {
            const expense = p.amount > 0;
            const named = toTitleCase((p.payee || "").trim());
            const guessed = named ? (payeeDefaultCategory(budget, named) || payeeSuggestedCategory(budget, named) || "") : "";
            p._named = named;
            p._skip = !named;
            p._categoryId = expense ? guessed : RTA;
            if (i >= 12) return;
            const cat = categorySelect(budget, acct.value, true);
            cat.value = p._categoryId;
            cat.addEventListener("change", () => { p._categoryId = cat.value; });
            const skip = h("input", { type: "checkbox", checked: !named });
            skip.addEventListener("change", () => { p._skip = skip.checked; });
            const row = h("div", { class: "pair" },
              h("p", { text: `${p.date} · ${named || "No payee"} · ${fmt(p.amount)}` }),
              h("label", { class: "choice" }, skip, h("span", { text: named ? "Skip this row" : "Skipped — no payee" })),
            );
            if (named) row.append(cat);
            review.append(row);
          });
          if (draft.length > 12) review.append(h("p", { class: "hint", text: `${draft.length - 12} more rows use each payee’s default category.` }));
        };
        for (const sel of Object.values(selects)) sel.addEventListener("change", paintReview);
        mode.addEventListener("change", paintReview);
        sign.addEventListener("change", paintReview);
        paintReview();
        mapBox.append(btn("Import", { block: true, onClick: () => {
          const map = mappingNow();
          let b = { ...budget, csvMappings: { ...(budget.csvMappings || {}), [acct.value]: map } };
          let added = 0; let dup = 0; let skipped = 0;
          const seen = new Set((b.transactions || []).map((t) => `${t.accountId}|${t.date}|${Math.abs(t.amount)}|${(t.originalPayee || t.payee || "").toLowerCase()}`));
          for (const parsed of draft) {
            const named = parsed._named || toTitleCase((parsed.payee || "").trim());
            if (!named || parsed._skip) { skipped++; continue; }
            const key = `${acct.value}|${parsed.date}|${Math.abs(parsed.amount)}|${named.toLowerCase()}`;
            if (seen.has(key)) { skipped++; continue; }
            seen.add(key);
            const expense = parsed.amount > 0;
            const chosen = parsed._categoryId || "";
            const confirmed = chosen ? chosen === (payeeDefaultCategory(b, named) || "") : true;
            const res = addTransaction(b, {
              date: parsed.date, payee: named, amount: Math.abs(parsed.amount),
              accountId: acct.value,
              categoryId: expense ? chosen : RTA,
              type: expense ? "expense" : "income",
              categoryConfirmed: confirmed,
            });
            if (res.error) continue;
            b = res.budget;
            added++;
            if ((b.pendingDuplicates || []).length > dup) dup = b.pendingDuplicates.length;
          }
          ctx.updateBudget(() => b);
          sheet.close();
          toast(`Imported ${added}${skipped ? `, skipped ${skipped}` : ""}${dup ? `, ${dup} possible duplicates` : ""}`);
        }}));
      });
    },
  });
}

function openDupes(ctx) {
  const budget = ctx.budget();
  const pairs = (budget.pendingDuplicates || []).filter((p) => budget.transactions.some((t) => t.id === p.newTxId) && budget.transactions.some((t) => t.id === p.existingTxId));
  const sheet = openSheet({
    title: "Possible duplicates",
    body: (host) => {
      for (const p of pairs) {
        const a = budget.transactions.find((t) => t.id === p.newTxId);
        const b = budget.transactions.find((t) => t.id === p.existingTxId);
        host.append(h("div", { class: "pair" },
          h("p", { text: `${a.date} ${displayName(budget, a.originalPayee || a.payee)} ${fmt(a.amount)}` }),
          h("p", { class: "muted", text: `Existing ${b.date} ${displayName(budget, b.originalPayee || b.payee)} ${fmt(b.amount)}` }),
          h("div", { class: "row gap" },
            btn("Keep both", { kind: "ghost", onClick: () => {
              ctx.updateBudget((bud) => ({ ...bud, pendingDuplicates: (bud.pendingDuplicates || []).filter((x) => x !== p && !(x.newTxId === p.newTxId && x.existingTxId === p.existingTxId)) }));
              sheet.close(); ctx.render(); openDupes(ctx);
            }}),
            btn("Delete new", { kind: "danger", onClick: () => {
              ctx.updateBudget((bud) => deleteTransactions({ ...bud, pendingDuplicates: (bud.pendingDuplicates || []).filter((x) => x.newTxId !== p.newTxId) }, [p.newTxId]));
              sheet.close();
            }}),
          ),
        ));
      }
      if (!pairs.length) host.append(h("p", { text: "All caught up." }));
    },
  });
}

function openBulkCat(ctx) {
  const budget = ctx.budget();
  const sheet = openSheet({
    title: "Set category",
    body: (host) => {
      const sel = categorySelect(budget, "", true);
      host.append(sel, btn("Apply", { block: true, onClick: () => {
        const ids = [...ctx.ui.selected];
        ctx.updateBudget((b) => {
          let cur = b;
          for (const id of ids) cur = setTxCategory(cur, id, sel.value);
          return cur;
        });
        ctx.ui.selected.clear();
        sheet.close();
      }}));
    },
  });
}
