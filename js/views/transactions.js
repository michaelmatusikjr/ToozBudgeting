import { h, btn, openSheet, field, textInput, toast, moneyButton, confirmDialog } from "../ui.js";
import { fmt, todayKey, toTitleCase, uid, isPayFrom, makePayFrom, RTA } from "../util.js";
import { displayName, payeeDefaultCategory, payeeSuggestedCategory } from "../payees.js";
import { addTransaction, deleteTransactions, isLocked, setTxCategory, updateTransaction } from "../mutate.js";
import { parseCSV, guessColumnMapping, applyMapping } from "../csv.js";
import { findFuzzyDuplicates } from "../payees.js";

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
  if (q) {
    rows = rows.filter((t) => {
      const name = displayName(budget, t.originalPayee || t.payee);
      const cat = budget.categories.find((c) => c.id === t.categoryId)?.name || "";
      return `${name} ${t.note || ""} ${cat} ${t.date}`.toLowerCase().includes(q);
    });
  }
  const selected = ctx.ui.selected;
  const sum = rows.reduce((s, t) => s + signedDisplay(budget, t), 0);

  const search = h("input", { class: "input", type: "search", placeholder: "Search payees, notes, categories", value: ctx.ui.txQuery || "" });
  search.addEventListener("input", () => { ctx.ui.txQuery = search.value; ctx.render(); });

  const dups = (budget.pendingDuplicates || []).filter((p) => budget.transactions.some((t) => t.id === p.newTxId) && budget.transactions.some((t) => t.id === p.existingTxId));

  root.append(h("header", { class: "view-head" },
    h("h1", { text: "Transactions" }),
    btn("Add", { onClick: () => openTx(ctx, null) }),
  ));
  root.append(h("div", { class: "toolbar" }, search, btn("Filter", { kind: "ghost", onClick: () => openFilters(ctx) }), btn("Import", { kind: "ghost", onClick: () => openImport(ctx) })));
  if (f.accountId || f.categoryId || f.type || f.month || q) {
    root.append(h("p", { class: "hint", text: `${rows.length} shown · net ${fmt(sum)}` }),
      btn("Clear filters", { kind: "quiet", onClick: () => { ctx.ui.txFilter = {}; ctx.ui.txQuery = ""; ctx.render(); } }));
  }
  if (dups.length) {
    root.append(h("button", { class: "notice", type: "button", onclick: () => openDupes(ctx) },
      h("strong", { text: `${dups.length} possible duplicate${dups.length === 1 ? "" : "s"}` }),
      h("span", { text: "Same account, amount within $0.05, date within 2 days." }),
    ));
  }
  if (selected.size) {
    root.append(h("div", { class: "bulk" },
      h("span", { text: `${selected.size} selected` }),
      btn("Category", { kind: "ghost", onClick: () => openBulkCat(ctx) }),
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
  if (!rows.length) list.append(h("p", { class: "empty", text: "No transactions match." }));
  for (const tx of rows) list.append(txRow(ctx, tx, selected));
  root.append(list);
  ctx.ui.searchEl = search;
}

function signedDisplay(budget, tx) {
  const card = (budget.creditCards || []).some((c) => c.id === tx.accountId);
  if (tx.type === "income") return Math.abs(tx.amount);
  if (tx.type === "expense") return card ? -tx.amount : -tx.amount;
  if (tx.type === "transfer") return tx.amount;
  if (tx.type === "payment") return -Math.abs(tx.amount);
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
  row.append(
    selected.size ? box : null,
    h("button", { class: "tx-main", type: "button", onclick: () => { if (selected.size) { if (selected.has(tx.id)) selected.delete(tx.id); else selected.add(tx.id); ctx.render(); } else openTx(ctx, tx); } },
      h("span", { class: "tx-payee", text: name }),
      h("span", { class: "muted", text: `${tx.date} · ${acct?.name || "No account"}` }),
    ),
    h("button", { class: "pill", type: "button", text: cat, disabled: locked && tx.subtype === "starting_balance", onclick: (e) => { e.stopPropagation(); if (tx.subtype === "starting_balance") { toast("Starting balances can’t be edited"); return; } openInlineCat(ctx, tx); } }),
    h("span", { class: `tx-amt ${Number(tx.amount) < 0 ? "in" : ""}`, text: fmt(tx.type === "income" || (tx.type === "transfer" && tx.amount > 0) ? Math.abs(tx.amount) : -Math.abs(tx.amount) * (tx.type === "expense" && tx.amount < 0 ? -1 : 1)) }),
  );
  // Simpler amount: show signed stored amount for expenses (negative = refund) and positive income.
  row.lastChild.textContent = amountLabel(tx);
  return row;
}

function amountLabel(tx) {
  if (tx.type === "income") return fmt(Math.abs(tx.amount));
  if (tx.type === "expense") return fmt(-Number(tx.amount));
  if (tx.type === "transfer") return fmt(tx.amount);
  if (tx.type === "payment") return fmt(-Math.abs(tx.amount));
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
        if (v === RTA) ctx.updateBudget((b) => updateTransaction(b, tx.id, { type: "income", categoryId: null, splits: undefined }));
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
  const locked = existing && isLocked(budget, existing);
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
    title: existing ? "Edit transaction" : "New transaction",
    body: (host) => {
      const date = h("input", { class: "input", type: "date", value: form.date });
      date.addEventListener("change", () => { form.date = date.value; });
      const payee = textInput({ value: form.payee, placeholder: "Payee" });
      const suggest = h("div", { class: "suggest" });
      const refreshSug = () => {
        suggest.replaceChildren();
        const q = payee.value.trim().toLowerCase();
        if (q.length < 1) return;
        const names = [...new Set((budget.transactions || []).map((t) => displayName(budget, t.originalPayee || t.payee)).filter(Boolean))];
        for (const n of names.filter((n) => n.toLowerCase().includes(q)).slice(0, 6)) {
          suggest.append(h("button", { type: "button", class: "sug", text: n, onclick: () => {
            payee.value = n; form.payee = n;
            const def = payeeDefaultCategory(budget, n) || payeeSuggestedCategory(budget, n);
            if (def) { form.categoryId = def; cat.value = def; }
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
        host.append(btn(existing ? "Save" : "Add", { block: true, onClick: () => {
          const payload = { ...form, payee: form.payee, type: form.transferAccountId ? "transfer" : (form.categoryId === RTA ? "income" : form.type) };
          if (existing) {
            ctx.updateBudget((b) => {
              let next = deleteTransactions(b, [existing.id]);
              const res = addTransaction(next, payload);
              return res.budget;
            });
          } else {
            const res = addTransaction(budget, payload);
            if (res.error) { toast(res.error); return; }
            ctx.updateBudget(() => res.budget);
          }
          sheet.close();
          toast(existing ? "Saved" : "Added", { label: "Undo", action: () => ctx.undo() });
        }}));
      } else host.append(h("p", { class: "hint", text: "Reconciled transactions can’t be deleted. Category edits are limited." }));
      if (existing && !locked) host.append(btn("Delete", { kind: "danger", block: true, onClick: () => {
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
      host.append(field("Account", acct), field("Type", type), field("From", from), field("To", to),
        btn("Apply", { block: true, onClick: () => {
          ctx.ui.txFilter = { ...f, accountId: acct.value, type: type.value, dateFrom: from.value, dateTo: to.value };
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
        const preview = rows.slice(1, 6).map((r) => applyMapping(r, headers, { ...mapping, amountMode: mode.value }));
        mapBox.append(h("p", { class: "hint", text: preview.map((p) => `${p.date || "?"} ${p.payee} ${p.amount}`).join("\n") }));
        mapBox.append(btn("Import", { block: true, onClick: () => {
          const mappingNow = {
            dateCol: selects.dateCol.value, payeeCol: selects.payeeCol.value, amountCol: selects.amountCol.value,
            debitCol: selects.debitCol.value, creditCol: selects.creditCol.value,
            amountMode: mode.value, signConvention: sign.value,
          };
          let b = { ...budget, csvMappings: { ...(budget.csvMappings || {}), [acct.value]: mappingNow } };
          let added = 0; let dup = 0;
          for (const r of rows.slice(1)) {
            const parsed = applyMapping(r, headers, mappingNow);
            if (!parsed.date || !parsed.amount) continue;
            const expense = parsed.amount > 0;
            const res = addTransaction(b, {
              date: parsed.date, payee: parsed.payee, amount: Math.abs(parsed.amount),
              accountId: acct.value, categoryId: expense ? "" : RTA, type: expense ? "expense" : "income",
            });
            if (res.error) continue;
            b = res.budget;
            added++;
            if ((b.pendingDuplicates || []).length > (budget.pendingDuplicates || []).length) dup++;
          }
          ctx.updateBudget(() => b);
          sheet.close();
          toast(`Imported ${added}${dup ? `, ${dup} possible duplicates` : ""}`);
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

void uid;
void toTitleCase;
void isPayFrom;
void findFuzzyDuplicates;
